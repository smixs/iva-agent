"""QR login against specs/UserbotLogin.tla: Telegram is replaced, nothing touches the network.

Test names end with the invariant of the model they hold the code to.
"""
import asyncio
import contextlib
import io
import os
import random
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import onboarding
from onboarding import IN_PROGRESS, MARKER_NAME, Login, Phase

SECRET = "SECRET"
RIGHT = f"right-{SECRET}"
WRONG = f"wrong-{SECRET}"
BOT_TOKEN = f"1:bot-{SECRET}"


class SessionPasswordNeededError(Exception):
    pass


class PasswordHashInvalidError(Exception):
    pass


class FloodWaitError(Exception):
    def __init__(self, seconds):
        super().__init__(f"A wait of {seconds} seconds is required")
        self.seconds = seconds


_ERRORS = types.SimpleNamespace(
    SessionPasswordNeededError=SessionPasswordNeededError,
    PasswordHashInvalidError=PasswordHashInvalidError,
    FloodWaitError=FloodWaitError,
)


class Telegram:
    """Telegram's side of one auth key: `tg` and `flood` of the model, plus a clock."""

    def __init__(self):
        self.tg = "none"
        self.flood_until = 0.0
        self.now = 1000.0
        self.scans = []  # what each `wait` of the QR meets: expire | password | authorized | fail
        self.checks = 0  # passwords that reached Telegram
        self.recreated = 0

    def clock(self):
        return self.now


class Qr:
    def __init__(self, telegram):
        self._telegram = telegram
        self.url = f"tg://login?token={SECRET}"
        self.expires = datetime.now(timezone.utc) + timedelta(seconds=30)

    async def wait(self, timeout):
        telegram = self._telegram
        scan = telegram.scans.pop(0) if telegram.scans else "expire"
        if scan == "expire":
            raise asyncio.TimeoutError
        if scan == "fail":
            raise RuntimeError(f"POST https://api.telegram.org/bot{BOT_TOKEN}/sendPhoto failed")
        telegram.tg = scan
        if scan == "password":
            raise SessionPasswordNeededError(self.url)

    async def recreate(self):
        self._telegram.recreated += 1
        if self._telegram.scans[:1] == ["password-on-refresh"]:
            self._telegram.scans.pop(0)
            self._telegram.tg = "password"
            raise SessionPasswordNeededError(self.url)


class Client:
    def __init__(self, telegram):
        self._telegram = telegram

    async def is_user_authorized(self):
        return self._telegram.tg == "authorized"

    async def qr_login(self):
        self._telegram.tg = "token"
        return Qr(self._telegram)

    async def sign_in(self, password):
        telegram = self._telegram
        telegram.checks += 1
        if telegram.now < telegram.flood_until:
            raise FloodWaitError(telegram.flood_until - telegram.now)
        if telegram.tg != "password":
            raise RuntimeError(f"no login is open for {password}")
        if password != RIGHT:
            raise PasswordHashInvalidError(f"{password} is invalid")
        telegram.tg = "authorized"


class Proxy:
    """One installation: the data directory, Telegram, and the process that may restart."""

    def __init__(self, case):
        self.dir = Path(case.enterContext(tempfile.TemporaryDirectory(prefix="iva-userbot-login-")))
        self.session = self.dir / "telegram-userbot.session"
        self.telegram = Telegram()
        self.said = []  # every tool reply and health body
        self.boot()

    def boot(self):
        if not self.session.exists():  # a fresh auth key, which Telegram does not know
            self.session.touch()
            self.telegram.tg = "none"
        elif self.telegram.tg == "token":
            self.telegram.tg = "none"
        self.login = Login(Client(self.telegram), self.session, clock=self.telegram.clock)

    async def call(self, tool, *args):
        reply = await getattr(self.login, tool)(*args)
        if self.login._task:
            await self.login._task
        self.said.append(str(reply))
        return reply

    async def phase(self):
        return await self.login.phase()


class LoginCase(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(sys.modules, {
            "telethon": types.SimpleNamespace(errors=_ERRORS),
            "telethon.errors": _ERRORS,
        }))
        self.enterContext(patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": BOT_TOKEN}))
        self.enterContext(patch.object(onboarding, "_render_qr_png", new=lambda url: b"png"))
        self.sent = self.enterContext(patch.object(onboarding, "_send_qr_to_bot", new=AsyncMock()))
        self.journal = self.enterContext(contextlib.redirect_stderr(io.StringIO()))
        self.proxy = Proxy(self)

    def run_steps(self, steps):
        return asyncio.run(steps)

    async def to_password(self, proxy=None):
        proxy = proxy or self.proxy
        proxy.telegram.scans = ["password"]
        await proxy.call("start")
        self.assertIs(await proxy.phase(), Phase.PASSWORD_NEEDED)

    def assert_no_secret(self, proxy=None):
        proxy = proxy or self.proxy
        files = {
            path.name: path.read_bytes().decode(errors="replace")
            for path in proxy.dir.iterdir()
        }
        self.assertEqual(files.get(MARKER_NAME, ""), "")
        for where, text in (("journal", self.journal.getvalue()), ("replies", "\n".join(proxy.said)),
                            ("disk", "\n".join(files.values()))):
            self.assertNotIn(SECRET, text, where)


class QrTests(LoginCase):
    def test_scan_without_cloud_password_ends_authorized(self):
        async def steps():
            self.proxy.telegram.scans = ["authorized"]
            await self.proxy.call("start")
            self.assertEqual(await self.proxy.call("status"), "authorized: аккаунт подключён.")
            self.assertEqual(await self.proxy.call("connected"), "connected")
            self.assertEqual(await self.proxy.call("start"), "Telegram уже подключён — новый QR не нужен.")

        self.run_steps(steps())
        self.sent.assert_awaited_once()

    def test_password_asked_when_refresh_reports_two_factor(self):
        # Alexey, 15.10.2026: scan landed on the refresh boundary; the password answer
        # came from ExportLoginTokenRequest in `recreate()` and went to the `error` phase.
        async def steps():
            self.proxy.telegram.scans = ["expire", "password-on-refresh"]
            await self.proxy.call("start")
            self.assertIs(await self.proxy.phase(), Phase.PASSWORD_NEEDED)

        self.run_steps(steps())
        self.assertEqual(self.proxy.telegram.recreated, 1)

    def test_password_asked_when_wait_reports_two_factor(self):
        self.run_steps(self.to_password())

    def test_token_expiring_every_time_ends_in_expired(self):
        async def steps():
            await self.proxy.call("start")
            self.assertEqual(
                await self.proxy.call("status"), "expired: QR истёк слишком много раз — начни заново"
            )

        self.run_steps(steps())
        self.assertEqual(self.proxy.telegram.recreated, onboarding._QR_MAX_REFRESHES)
        self.assertFalse((self.proxy.dir / MARKER_NAME).exists())

    def test_second_start_while_the_login_runs_starts_nothing(self):
        async def steps():
            gate = asyncio.Event()

            async def hold(*_):
                await gate.wait()

            self.sent.side_effect = hold
            first = await self.proxy.login.start()
            await asyncio.sleep(0)
            second = await self.proxy.login.start()
            gate.set()
            await self.proxy.login._task
            return first, second

        first, second = self.run_steps(steps())
        self.assertIn("Отправляю QR-код", first)
        self.assertEqual(second, "Логин уже идёт — проверь свой чат с ботом, там QR-код.")
        self.assertEqual(self.sent.await_count, onboarding._QR_MAX_REFRESHES)

    def test_failure_is_told_in_fixed_words_NoSecretLeaves(self):
        async def steps():
            self.proxy.telegram.scans = ["fail"]
            await self.proxy.call("start")
            self.assertEqual(
                await self.proxy.call("status"),
                "error: вход по QR не удался: RuntimeError — начни заново",
            )
            await self.proxy.call("connected")
            self.proxy.said.append(str(await self.proxy.login.health()))

        self.run_steps(steps())
        self.assertIn("вход по QR не удался: RuntimeError", self.journal.getvalue())
        self.assert_no_secret()

    def test_bot_api_refusal_names_the_status_not_the_url_NoSecretLeaves(self):
        class Http:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def post(self, url, **_):
                return types.SimpleNamespace(status_code=403)

        async def steps():
            httpx = types.SimpleNamespace(AsyncClient=lambda **_: Http())
            with patch.dict(sys.modules, {"httpx": httpx}), patch.dict(
                os.environ, {"TELEGRAM_ALLOWED_USER_IDS": "42"}
            ), patch.object(onboarding, "_send_qr_to_bot", new=self.real_send):
                await self.proxy.call("start")
            return await self.proxy.call("status")

        self.assertEqual(
            self.run_steps(steps()),
            "error: вход по QR не удался: Telegram Bot API ответил 403 на отправку QR — начни заново",
        )
        self.assert_no_secret()

    real_send = staticmethod(onboarding._send_qr_to_bot)


class PasswordTests(LoginCase):
    def test_wrong_password_is_asked_again_WrongPasswordKeepsAsking(self):
        # The path TLC prints for UserbotLogin-wrong-password-ends.cfg, one call per action:
        # StartLogin, QrSent, OwnerScans, ProxySeesPasswordAsked, WrongPassword — and then
        # the witness of UserbotLogin-retry-witness.cfg: RightPassword.
        async def steps():
            await self.to_password()
            wrong = await self.proxy.call("password", WRONG)
            self.assertEqual(
                wrong, "Пароль не подошёл. Статус прежний, password_needed — пришли пароль ещё раз."
            )
            self.assertEqual(
                await self.proxy.call("status"),
                "password_needed: Включена двухфакторная защита — пришли пароль",
            )
            self.assertTrue((self.proxy.dir / MARKER_NAME).exists())
            self.assertEqual(await self.proxy.call("password", RIGHT), "Готово — аккаунт подключён.")
            self.assertIs(await self.proxy.phase(), Phase.AUTHORIZED)

        self.run_steps(steps())
        self.assertEqual(self.proxy.telegram.checks, 2)
        self.sent.assert_awaited_once()  # one QR for the whole login
        self.assert_no_secret()

    def test_wait_named_by_telegram_is_told_and_kept_WaitRespected(self):
        async def steps():
            await self.to_password()
            telegram = self.proxy.telegram
            telegram.flood_until = telegram.now + 120
            told = await self.proxy.call("password", WRONG)
            self.assertIn("подождать 120 с", told)
            self.assertIs(await self.proxy.phase(), Phase.PASSWORD_NEEDED)
            telegram.now += 30
            self.assertIn("подождать 90 с", await self.proxy.call("password", RIGHT))
            self.assertIn("password_needed: Telegram просит подождать 90 с", await self.proxy.call("status"))
            self.assertEqual(telegram.checks, 1)  # the second password stayed on the box
            telegram.now += 90
            self.assertEqual(await self.proxy.call("password", RIGHT), "Готово — аккаунт подключён.")

        self.run_steps(steps())
        self.assertEqual(self.proxy.telegram.checks, 2)
        self.assert_no_secret()

    def test_empty_password_does_not_reach_telegram_WrongPasswordKeepsAsking(self):
        async def steps():
            await self.to_password()
            self.assertIn("Пароль пустой", await self.proxy.call("password", ""))
            self.assertIs(await self.proxy.phase(), Phase.PASSWORD_NEEDED)

        self.run_steps(steps())
        self.assertEqual(self.proxy.telegram.checks, 0)

    def test_password_without_a_question_changes_nothing(self):
        async def steps():
            return await self.proxy.call("password", RIGHT)

        self.assertEqual(self.run_steps(steps()), "Пароль сейчас не требуется (статус: idle).")
        self.assertEqual(self.proxy.telegram.checks, 0)

    def test_other_failure_of_the_check_ends_the_login_in_fixed_words_NoSecretLeaves(self):
        async def steps():
            await self.to_password()
            self.proxy.telegram.tg = "none"  # Telegram no longer holds the login
            reply = await self.proxy.call("password", RIGHT)
            self.assertEqual(
                reply, "Не удалось войти: проверка пароля не удалась: RuntimeError — начни заново"
            )
            self.assertIs(await self.proxy.phase(), Phase.ERROR)
            self.assertIn("Отправляю QR-код", await self.proxy.call("start"))

        self.run_steps(steps())
        self.assert_no_secret()


class RestartTests(LoginCase):
    def test_restart_on_the_password_step_is_named_NoSilentIdle(self):
        # The path TLC prints for UserbotLogin-no-marker.cfg, continued to the password step.
        async def steps():
            await self.to_password()
            self.proxy.boot()
            self.assertEqual(
                await self.proxy.call("status"),
                "interrupted: прокси перезапустился посреди входа — начни заново с qr_login_start",
            )
            self.assertIn("phase=interrupted", await self.proxy.call("connected"))
            self.assertEqual(
                await self.proxy.login.health(), {"state": "unauthorized", "login": "interrupted"}
            )
            self.assertIn("статус: interrupted", await self.proxy.call("password", RIGHT))
            self.proxy.boot()  # a second restart forgets nothing
            self.assertIs(await self.proxy.phase(), Phase.INTERRUPTED)
            self.proxy.telegram.scans = ["authorized"]
            await self.proxy.call("start")
            self.assertIs(await self.proxy.phase(), Phase.AUTHORIZED)
            self.proxy.boot()
            self.assertIs(await self.proxy.phase(), Phase.AUTHORIZED)

        self.run_steps(steps())
        self.assertEqual(self.proxy.telegram.checks, 0)
        self.assertFalse((self.proxy.dir / MARKER_NAME).exists())

    def test_read_ends_a_login_the_process_did_not_live_to_tell_ReadEndsLogin(self):
        # The path TLC prints for UserbotLogin-read-keeps-marker.cfg, with the restart that
        # cut the process between Telegram's yes and the phase.
        async def steps():
            await self.to_password()
            self.proxy.telegram.tg = "authorized"  # sign_in went through; the process died
            self.proxy.boot()
            self.assertEqual(await self.proxy.login.health(), {"state": "ready", "login": "authorized"})
            self.assertFalse((self.proxy.dir / MARKER_NAME).exists())
            self.assertEqual(await self.proxy.call("start"), "Telegram уже подключён — новый QR не нужен.")
            self.proxy.telegram.tg = "none"  # signed out from another device
            self.assertEqual(await self.proxy.call("status"), "idle: вход не начат")
            self.proxy.boot()
            self.assertIs(await self.proxy.phase(), Phase.IDLE)

        self.run_steps(steps())

    def test_restart_without_a_login_stays_idle(self):
        async def steps():
            self.proxy.boot()
            self.assertEqual(await self.proxy.call("status"), "idle: вход не начат")
            await self.proxy.call("start")  # expires
            self.proxy.boot()
            return await self.proxy.phase()

        self.assertIs(self.run_steps(steps()), Phase.IDLE)

    def test_login_is_refused_when_the_marker_cannot_be_written_NoSilentIdle(self):
        async def steps():
            with patch.object(Path, "touch", side_effect=PermissionError(f"denied {SECRET}")):
                reply = await self.proxy.call("start")
            self.assertEqual(
                reply, "error: не могу записать на диск отметку входа: PermissionError — начни заново"
            )

        self.run_steps(steps())
        self.assertIsNone(self.proxy.login._task)
        self.sent.assert_not_awaited()
        self.assert_no_secret()


class SessionTests(LoginCase):
    def test_authorized_is_told_only_with_the_session_file_AuthorizedHasSession(self):
        # The state TLC reaches for UserbotLogin-no-session-check.cfg: Telegram lets the
        # account in while the session file is gone.
        async def steps():
            self.proxy.session.unlink()
            self.proxy.telegram.scans = ["authorized"]
            await self.proxy.call("start")
            self.assertIs(await self.proxy.phase(), Phase.ERROR)
            self.assertIn("файла сессии на диске нет", await self.proxy.call("status"))
            self.assertIn("not_connected (phase=error", await self.proxy.call("connected"))
            self.assertEqual(await self.proxy.login.health(), {"state": "unauthorized", "login": "error"})
            self.assertIn("error: Telegram впустил аккаунт", await self.proxy.call("start"))

        self.run_steps(steps())
        self.sent.assert_awaited_once()

    def test_right_password_without_the_session_file_is_not_told_connected_SuccessIsTheRead(self):
        # The path TLC prints for UserbotLogin-success-unread.cfg.
        async def steps():
            await self.to_password()
            self.proxy.session.unlink()
            reply = await self.proxy.call("password", RIGHT)
            self.assertTrue(reply.startswith("error: Telegram впустил аккаунт"), reply)
            self.assertEqual(await self.proxy.login.health(), {"state": "unauthorized", "login": "error"})

        self.run_steps(steps())
        self.assert_no_secret()

    def test_sign_out_from_another_device_reads_idle(self):
        async def steps():
            self.proxy.telegram.scans = ["authorized"]
            await self.proxy.call("start")
            self.assertEqual(await self.proxy.login.health(), {"state": "ready", "login": "authorized"})
            self.proxy.telegram.tg = "none"
            self.assertEqual(await self.proxy.call("status"), "idle: вход не начат")
            self.assertEqual(await self.proxy.login.health(), {"state": "unauthorized", "login": "idle"})

        self.run_steps(steps())


class ModelWalk(LoginCase):
    """Random walks over the actions of the model; each step is checked against its invariants."""

    STEPS = ("start", "start", "wrong", "wrong", "right", "empty", "flood", "time", "restart",
             "restart", "session_lost", "signed_out", "accepted", "status")

    def walk(self, seed):
        rng = random.Random(seed)
        proxy = Proxy(self)
        telegram = proxy.telegram
        cut = seen = False

        async def steps():
            nonlocal cut, seen
            for _ in range(40):
                step = rng.choice(self.STEPS)
                before, checks, known_wait = proxy.login._phase, telegram.checks, (
                    proxy.login._retry_at > telegram.now
                )
                if step == "start":
                    telegram.scans = rng.choice(
                        (["password"], ["authorized"], ["fail"], [], ["expire", "password-on-refresh"])
                    )
                    reply = await proxy.call("start")
                    cut = cut and "Отправляю" not in reply
                    seen = seen and "Отправляю" not in reply
                elif step in ("wrong", "right", "empty"):
                    reply = await proxy.call(
                        "password", {"wrong": WRONG, "right": RIGHT, "empty": ""}[step]
                    )
                    # 7. SuccessIsTheRead
                    if reply == "Готово — аккаунт подключён.":
                        self.assertIs(await proxy.phase(), Phase.AUTHORIZED, step)
                    if before is Phase.PASSWORD_NEEDED and telegram.tg == "password":
                        # 1. WrongPasswordKeepsAsking
                        self.assertIs(proxy.login._phase, Phase.PASSWORD_NEEDED, step)
                    # 5. WaitRespected
                    self.assertFalse(known_wait and telegram.checks > checks, step)
                elif step == "flood":
                    telegram.flood_until = telegram.now + rng.choice((61, 600))
                elif step == "time":
                    telegram.now += rng.choice((1, 60, 600))
                elif step == "restart":
                    cut = cut or before in IN_PROGRESS
                    proxy.boot()
                elif step == "session_lost":
                    proxy.session.unlink(missing_ok=True)
                elif step == "signed_out" and telegram.tg == "authorized":
                    telegram.tg = "none"
                elif step == "accepted" and telegram.tg == "password":
                    telegram.tg = "authorized"  # Telegram said yes; the process is not told
                else:
                    await proxy.call("status")
                phase = await proxy.phase()
                proxy.said.append(str(await proxy.login.health()))
                if phase is Phase.AUTHORIZED:  # the read ended the login, cut or not
                    seen, cut = True, False
                # 2. NoSilentIdle
                if cut:
                    self.assertIn(phase, (Phase.INTERRUPTED, Phase.AUTHORIZED, Phase.ERROR), step)
                # 3. AuthorizedHasSession
                if phase is Phase.AUTHORIZED:
                    self.assertTrue(proxy.session.is_file() and telegram.tg == "authorized", step)
                marked = (proxy.dir / MARKER_NAME).exists()
                stored = proxy.login._phase
                self.assertTrue(marked or stored not in IN_PROGRESS, step)
                self.assertTrue(not marked or stored in IN_PROGRESS or stored is Phase.INTERRUPTED, step)
                # 6. ReadEndsLogin
                if seen:
                    self.assertFalse(marked or stored is Phase.INTERRUPTED, step)
            # 4. NoSecretLeaves
            self.assert_no_secret(proxy)

        asyncio.run(steps())

    def test_random_walks_hold_every_invariant_of_the_model(self):
        base = int(os.environ.get("USERBOT_LOGIN_SEED", "20261110"))
        for seed in range(base, base + 300):
            with self.subTest(seed=seed):
                self.walk(seed)


class ToolArgumentTests(LoginCase):
    def test_password_that_is_not_a_string_is_not_quoted_back_NoSecretLeaves(self):
        try:
            from mcp.server.fastmcp import FastMCP
        except ImportError:
            self.skipTest("mcp is not installed here")
        number = 900_000_000 + len(SECRET)  # a digit password the model sent as a number

        async def steps():
            await self.to_password()
            mcp = FastMCP("test")
            onboarding.register_onboarding_tools(mcp, self.proxy.login)
            tool = next(t for t in await mcp.list_tools() if t.name == "qr_login_password")
            self.assertEqual(tool.inputSchema["properties"]["password"]["type"], "string")
            replies = []
            for value in (number, [RIGHT], {"password": WRONG}):
                content, _ = await mcp.call_tool("qr_login_password", {"password": value})
                replies.append(content[0].text)
            return replies

        replies = self.run_steps(steps())
        self.assertEqual(replies[0], "Пароль не подошёл. Статус прежний, password_needed — пришли пароль ещё раз.")
        for reply in replies:
            self.assertNotIn(str(number), reply)
            self.assertNotIn(SECRET, reply)
        self.assertEqual(self.proxy.telegram.checks, 3)


class TelethonNamesTests(unittest.TestCase):
    def test_installed_telethon_has_the_errors_the_login_catches(self):
        try:
            from telethon import errors
        except ImportError:
            self.skipTest("telethon is not installed here")
        self.assertEqual(errors.FloodWaitError(request=None, capture=7).seconds, 7)
        for name in ("SessionPasswordNeededError", "PasswordHashInvalidError"):
            self.assertTrue(issubclass(getattr(errors, name), Exception), name)


if __name__ == "__main__":
    unittest.main()
