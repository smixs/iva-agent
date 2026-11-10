"""QR-login onboarding tools for the telegram-userbot proxy.

Lets a non-technical iva user connect their Telegram account by scanning a QR
code sent straight into their bot chat — no CLI, no session strings. The login
token (`tg://login?token=…`) is account-takeover-grade, so it is rendered and
delivered ON THE BOX and never returned into the model context.

Tools (registered by `register_onboarding_tools`):
  qr_login_start     — begin QR login; render + send the QR to the owner's bot chat
  qr_login_status    — poll the phase (`Phase`)
  qr_login_password  — supply the 2FA password when the phase is password_needed
  login_status       — is the userbot connected? (agent checks before other tools)

The Telethon client persists the session automatically on success (file session),
so no manual save and no restart: the same live client just becomes authorized.

The login is modelled in specs/UserbotLogin.tla; the comments name its invariants.
"""
import asyncio
import io
import math
import os
import sys
import time
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

_QR_MAX_REFRESHES = 3  # ~30s per QR ⇒ ~90s total before we give up
_QR_CAPTION = (
    "Отсканируй этот QR в приложении Telegram того аккаунта, который подключаешь:\n"
    "Настройки → Устройства → Подключить устройство.\n"
    "Код обновляется автоматически. Это подключение на твой страх и риск."
)
# Beside the session file: present while a login is in progress, so a restart can tell
# a login it cut from a login that was never begun.
MARKER_NAME = "telegram-userbot.login"


class Phase(str, Enum):
    """The one list of login phases. `/healthz` sends the value as `login`, and
    scripts/lib/userbot-health.ts reads it against the same list."""

    IDLE = "idle"
    STARTING = "starting"
    WAITING = "waiting"
    PASSWORD_NEEDED = "password_needed"
    AUTHORIZED = "authorized"
    EXPIRED = "expired"
    ERROR = "error"
    INTERRUPTED = "interrupted"


IN_PROGRESS = frozenset({Phase.STARTING, Phase.WAITING, Phase.PASSWORD_NEEDED})
_DETAIL = {
    Phase.IDLE: "вход не начат",
    Phase.STARTING: "готовлю QR",
    Phase.WAITING: "QR отправлен в чат с ботом, жду скан",
    Phase.PASSWORD_NEEDED: "Включена двухфакторная защита — пришли пароль",
    Phase.AUTHORIZED: "аккаунт подключён.",
    Phase.EXPIRED: "QR истёк слишком много раз — начни заново",
    Phase.ERROR: "вход не удался — начни заново",
    Phase.INTERRUPTED: "прокси перезапустился посреди входа — начни заново с qr_login_start",
}
_SESSION_LOST = (
    "Telegram впустил аккаунт, но файла сессии на диске нет: вход не переживёт перезапуск. "
    "Перезапусти прокси (`iva userbot setup`) и подключи аккаунт заново"
)


class _Told(RuntimeError):
    """A failure whose text is ours and safe to show."""


def _first_id(csv: "str | None") -> "str | None":
    if not csv:
        return None
    for part in csv.replace(",", " ").split():
        part = part.strip()
        if part:
            return part
    return None


def _owner_chat_id() -> "str | None":
    return os.getenv("TELEGRAM_USERBOT_QR_CHAT_ID") or _first_id(
        os.getenv("TELEGRAM_ALLOWED_USER_IDS")
    )


def _render_qr_png(url: str) -> bytes:
    import qrcode
    from qrcode.image.pure import PyPNGImage

    qr = qrcode.QRCode(box_size=10, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    buf = io.BytesIO()
    qr.make_image(image_factory=PyPNGImage).save(buf)
    return buf.getvalue()


async def _send_qr_to_bot(png: bytes, caption: str) -> None:
    import httpx

    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = _owner_chat_id()
    if not token or not chat_id:
        raise _Told(
            "нужны TELEGRAM_BOT_TOKEN и chat владельца "
            "(TELEGRAM_USERBOT_QR_CHAT_ID или TELEGRAM_ALLOWED_USER_IDS) для доставки QR"
        )
    async with httpx.AsyncClient(timeout=30) as http:
        resp = await http.post(
            f"https://api.telegram.org/bot{token}/sendPhoto",
            data={"chat_id": chat_id, "caption": caption},
            files={"photo": ("login-qr.png", png, "image/png")},
        )
    # Not raise_for_status(): its message quotes the URL, and the URL holds the bot token.
    if resp.status_code >= 400:
        raise _Told(f"Telegram Bot API ответил {resp.status_code} на отправку QR")


def _seconds_until_expiry(qr) -> float:
    expires = qr.expires
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return max(1.0, (expires - datetime.now(timezone.utc)).total_seconds() - 1.0)


def _wait_text(seconds: float) -> str:
    return (
        f"Telegram просит подождать {math.ceil(seconds)} с перед следующей попыткой пароля. "
        "Пароль в Telegram не отправлен — пришли его после паузы."
    )


class Login:
    """The login of one account: the phase in memory, the marker on disk."""

    def __init__(self, client, session_file, clock=time.monotonic) -> None:
        self._client = client
        self._session_file = Path(session_file)
        self._marker = self._session_file.with_name(MARKER_NAME)
        self._clock = clock
        self._lock = asyncio.Lock()
        self._task: "asyncio.Task | None" = None
        self._retry_at = 0.0
        # NoSilentIdle: the marker outlived the process that wrote it.
        self._phase = Phase.INTERRUPTED if self._marker.exists() else Phase.IDLE
        self._detail = _DETAIL[self._phase]

    def _set(self, phase: Phase, detail: "str | None" = None) -> None:
        if phase in IN_PROGRESS:
            self._marker.touch()  # before the phase: no login in progress without it
        else:
            try:
                self._marker.unlink(missing_ok=True)
            except OSError:
                pass  # the marker stays: a restart says "interrupted", which is safe
        self._phase, self._detail = phase, detail or _DETAIL[phase]

    def _fail(self, what: str, exc: BaseException) -> None:
        # NoSecretLeaves: our own words and the class of the exception, never its text —
        # a foreign message can quote the bot token, the login token or the password.
        told = str(exc) if isinstance(exc, _Told) else type(exc).__name__
        self._set(Phase.ERROR, f"{what}: {told} — начни заново")
        print(f"telegram-userbot: {what}: {told}", file=sys.stderr)

    async def _read(self) -> "tuple[Phase, str]":
        """Telegram's answer first, the phase in memory otherwise."""
        if await self._client.is_user_authorized():
            # AuthorizedHasSession
            if not self._session_file.is_file():
                return Phase.ERROR, _SESSION_LOST
            if self._phase is not Phase.AUTHORIZED:
                # ReadEndsLogin: the process that let the account in may have died before
                # it said so; the read ends that login and takes the marker away.
                self._set(Phase.AUTHORIZED)
            return Phase.AUTHORIZED, _DETAIL[Phase.AUTHORIZED]
        if self._phase is Phase.AUTHORIZED:  # signed out from another device
            return Phase.IDLE, _DETAIL[Phase.IDLE]
        wait = self._retry_at - self._clock()
        if self._phase is Phase.PASSWORD_NEEDED and wait > 0:
            return self._phase, _wait_text(wait)
        return self._phase, self._detail

    async def phase(self) -> Phase:
        return (await self._read())[0]

    async def health(self) -> "dict[str, str]":
        """The `/healthz` body: `state` for every release, `login` for the phase."""
        phase = await self.phase()
        state = "ready" if phase is Phase.AUTHORIZED else "unauthorized"
        return {"state": state, "login": phase.value}

    async def _run(self) -> None:
        from telethon import errors

        try:
            qr = await self._client.qr_login()
            for _ in range(_QR_MAX_REFRESHES):
                await _send_qr_to_bot(_render_qr_png(qr.url), _QR_CAPTION)
                self._set(Phase.WAITING)
                try:
                    await qr.wait(timeout=_seconds_until_expiry(qr))
                except asyncio.TimeoutError:
                    await qr.recreate()
                    continue
                self._set(Phase.AUTHORIZED)
                return
            self._set(Phase.EXPIRED)
        except errors.SessionPasswordNeededError:
            # Telegram asks for the cloud password as soon as the scanned token is accepted.
            # With the scan landing on the refresh boundary that answer comes back from
            # `recreate()` (ExportLoginTokenRequest), not from `wait()` — so it is caught for
            # the whole login, and the owner is asked for the password in every case.
            self._set(Phase.PASSWORD_NEEDED)
        except Exception as exc:  # noqa: BLE001
            self._fail("вход по QR не удался", exc)

    async def start(self) -> str:
        """Подключить Telegram-аккаунт владельца через QR. Рендерит QR-код и отправляет его
        картинкой в чат владельца с ботом. Затем опрашивай qr_login_status."""
        async with self._lock:
            phase, detail = await self._read()
            if phase is Phase.AUTHORIZED:
                return "Telegram уже подключён — новый QR не нужен."
            if detail is _SESSION_LOST:
                return f"{phase.value}: {detail}"
            if self._task and not self._task.done():
                return "Логин уже идёт — проверь свой чат с ботом, там QR-код."
            try:
                self._set(Phase.STARTING)
            except OSError as exc:
                self._fail("не могу записать на диск отметку входа", exc)
                return f"{self._phase.value}: {self._detail}"
            self._task = asyncio.create_task(self._run())
        return (
            "Отправляю QR-код в твой чат с ботом. Открой в приложении Telegram того "
            "аккаунта: Настройки → Устройства → Подключить устройство — и отсканируй. "
            "Потом я проверю статус."
        )

    async def status(self) -> str:
        phase, detail = await self._read()
        return f"{phase.value}: {detail}"

    async def password(self, password: str) -> str:
        """Завершить логин двухфакторным паролем, когда статус == password_needed.
        Неверный пароль статус не меняет: попроси пароль ещё раз."""
        from telethon import errors

        async with self._lock:
            if self._phase is not Phase.PASSWORD_NEEDED:
                return f"Пароль сейчас не требуется (статус: {(await self.phase()).value})."
            if not password:
                return "Пароль пустой — пришли пароль двухфакторной защиты."
            # WaitRespected: inside the wait Telegram named nothing is sent.
            wait = self._retry_at - self._clock()
            if wait > 0:
                return _wait_text(wait)
            try:
                await self._client.sign_in(password=password)
            except errors.PasswordHashInvalidError:
                # WrongPasswordKeepsAsking: the login stays open on Telegram's side.
                return "Пароль не подошёл. Статус прежний, password_needed — пришли пароль ещё раз."
            except errors.FloodWaitError as exc:
                self._retry_at = self._clock() + exc.seconds
                return _wait_text(exc.seconds)
            except Exception as exc:  # noqa: BLE001
                self._fail("проверка пароля не удалась", exc)
                return f"Не удалось войти: {self._detail}"
            self._set(Phase.AUTHORIZED)
            # SuccessIsTheRead: "connected" only when the read says so.
            phase, detail = await self._read()
            if phase is not Phase.AUTHORIZED:
                return f"{phase.value}: {detail}"
            return "Готово — аккаунт подключён."

    async def connected(self) -> str:
        """Подключён ли userbot к Telegram? Зови перед использованием остальных тулов."""
        phase, detail = await self._read()
        if phase is Phase.AUTHORIZED:
            return "connected"
        return f"not_connected (phase={phase.value}: {detail})"


def register_onboarding_tools(mcp, login: Login) -> None:
    from typing import Annotated

    from mcp.types import ToolAnnotations
    from pydantic import BeforeValidator

    # NoSecretLeaves: a password that is not a string (the model sent 123456 as a number)
    # becomes one before the schema check, whose refusal would quote it as `input_value`.
    # `password` is named secret in agent/connections/telegram-userbot.ts for Trace.
    async def qr_login_password(password: Annotated[str, BeforeValidator(str)]) -> str:
        return await login.password(password)

    read_only = ToolAnnotations(readOnlyHint=True)
    phases = " | ".join(phase.value for phase in Phase)
    for name, fn, description in (
        ("qr_login_start", login.start, login.start.__doc__),
        ("qr_login_status", login.status, f"Проверить статус QR-логина: {phases}."),
        ("qr_login_password", qr_login_password, login.password.__doc__),
        ("login_status", login.connected, login.connected.__doc__),
    ):
        mcp.add_tool(fn, name=name, description=description, annotations=read_only)
