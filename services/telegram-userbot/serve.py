#!/usr/bin/env python3
"""
Persistent HTTP proxy that owns the Telethon userbot sessions and exposes the
upstream chigwell/telegram-mcp tools over MCP streamable-HTTP for the iva agent.

Why this exists (hard-won lesson, do not "simplify" away):
- Exactly ONE process may own a given Telethon session. A second opener desyncs
  the MTProto session and crashes Telethon with TypeNotFoundError. So this proxy
  is the sole session owner; iva reaches it on demand over HTTP.

Design:
- Session-less boot. If no saved session exists yet, we seed an EMPTY StringSession
  so upstream's `_discover_accounts()` builds an unauthorized-but-connectable client
  instead of `sys.exit(1)`. The QR-login tools (Phase 1, onboarding.py) authorize
  that SAME live client in place, then persist the real session — no restart, no
  hot-swap of a different client.
- Bearer auth + bind 127.0.0.1 (single box; defense-in-depth on top of localhost).
- receive_updates defaults to True upstream, so Telethon's own loop auto-reconnects;
  we add a cheap EnsureConnected middleware as belt-and-suspenders.

Env:
  TELEGRAM_MCP_HOST   bind address        (default 127.0.0.1)
  TELEGRAM_MCP_PORT   bind port           (default 8724)
  TELEGRAM_MCP_TOKEN  bearer secret; every request must send `Authorization: Bearer <token>`
  TELEGRAM_API_ID / TELEGRAM_API_HASH     from my.telegram.org (required)
  TELEGRAM_SESSION_FILE  path to the SQLite session file. Default: <iva_root>/data/
                         telegram-userbot.session, beside the proxy token. The production
                         unit passes ASSISTANT_DATA_DIR as one canonical absolute path.
"""
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path

SESSION_NAME = "telegram-userbot.session"
# SQLite keeps these beside the database while a write is in flight.
SESSION_SIDECARS = ("-journal", "-wal", "-shm")


async def _health_payload(client) -> dict[str, str]:
    """Report authorization from the proxy's existing Telethon client."""
    return {"state": "ready" if await client.is_user_authorized() else "unauthorized"}


def _fail(msg: str) -> None:
    print(f"telegram-userbot: {msg}", file=sys.stderr)
    sys.exit(1)


def _root_dir() -> Path:
    # services/telegram-userbot/serve.py → parents[2] = the iva root. Under the
    # versioned layout that is the version directory, where `data` is a link back to
    # the installation — so the path follows the update instead of being left by it.
    return Path(__file__).resolve().parents[2]


def _data_dir() -> Path:
    """Trust the canonical absolute path supplied by the production unit.

    Missing configuration preserves direct legacy invocations. A relative value is a
    broken process boundary: fail instead of silently selecting another directory.
    """
    data_dir = (os.getenv("ASSISTANT_DATA_DIR") or "").strip()
    if data_dir:
        if not os.path.isabs(data_dir):
            _fail("ASSISTANT_DATA_DIR must be a canonical absolute path")
        return Path(data_dir)
    return _root_dir() / "data"


def _session_file() -> Path:
    explicit = os.getenv("TELEGRAM_SESSION_FILE")
    if explicit:
        return Path(explicit)
    return _data_dir() / SESSION_NAME


def _legacy_session_candidates() -> tuple[Path, ...]:
    """Places an older release resolved the session to, newest first.

    The unit's cwd is services/telegram-userbot. A session inside an already retired
    version directory is not reached from here, and was never reachable: it died with
    the version that held it, which is the bug the anchor above stops from recurring.
    The old fixed <root>/data anchor comes first when C4 moves a configured installation.
    Checking only the CURRENT environment also misses installations that gained
    ASSISTANT_DATA_DIR after the account was linked: their session sits at the bare cwd.
    """
    here = Path.cwd()
    data_dir = os.getenv("ASSISTANT_DATA_DIR")
    candidates = []
    old_anchor = _root_dir() / "data" / SESSION_NAME
    if data_dir and os.path.isabs(data_dir) and Path(data_dir) != old_anchor.parent:
        candidates.append(old_anchor)
    if data_dir and not os.path.isabs(data_dir):
        candidates.append(here / data_dir / SESSION_NAME)
    candidates.append(here / SESSION_NAME)
    return tuple(candidates)


def _move_session(legacy: Path, path: Path) -> None:
    """Copy the session and its sidecars to the anchor, publish, then drop the originals.

    Never `shutil.move`: the two paths can sit on different filesystems, where move
    degrades to a copy, and a copy that runs out of space leaves a TRUNCATED file at the
    destination. That stump is fatal, not untidy — every later start finds a session
    already at the anchor, never adopts again, and Telethon opens a corpse while the whole
    file still lies at the old path: a QR code asked for an account whose key is on disk.

    So the destination only ever sees finished files. Copies land on a temporary name in
    the destination directory (same filesystem, so `os.replace` is atomic), are flushed,
    and only then take their real names; the originals go last. Any failure clears
    everything this call wrote and leaves the originals untouched, so the next start
    simply tries again — which is also what makes the order of the files a non-question.
    """
    pairs = [
        (legacy.with_name(legacy.name + suffix), path.with_name(path.name + suffix))
        for suffix in ("", *SESSION_SIDECARS)
        if legacy.with_name(legacy.name + suffix).exists()
    ]
    # Gone between the check and here: another proxy start won the race, and claiming a
    # move this call did not make would send whoever reads the log to the wrong directory.
    if not pairs:
        return

    staged: list[tuple[Path, Path]] = []
    published: list[Path] = []
    try:
        for source, target in pairs:
            temporary = target.with_name(f"{target.name}.iva-adopt-{os.getpid()}")
            # Recorded BEFORE the copy runs: a copy that dies part-way has still put a
            # file there, and the cleanup below can only remove what it was told about.
            staged.append((temporary, target))
            shutil.copy2(source, temporary)
            # copy2 carries the source's mode, and the sessions worth adopting are
            # exactly the old ones — written before this proxy forced umask 0077, so
            # 0644 and readable by every other account on the box. The move is the
            # moment to fix that, not to preserve it.
            os.chmod(temporary, 0o600)
            # The auth key cannot be reissued, so the bytes reach the disk before the
            # rename that turns them into the session everything else will read.
            with open(temporary, "r+b") as handle:
                os.fsync(handle.fileno())
        for temporary, target in staged:
            os.replace(temporary, target)
            published.append(target)
        # The renames themselves have to be durable before the originals go. The whole
        # point of this function is that the two paths can be on different filesystems,
        # and a crash in the window between "originals deleted" and "rename on the disk"
        # would take the only copy of the MTProto key with it. No test can open that
        # window - it needs a machine you can cut power to - so it is held by this
        # comment and by the fact that the call is unconditional.
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError as exc:
        # The cleanup is itself filesystem work and can fail the same way the copy
        # did. A traceback out of here would take the proxy down on startup over a
        # session it never had to adopt, so what cannot be removed is reported and
        # the originals - which nothing has touched yet - are still the whole truth.
        for leftover in [temporary for temporary, _ in staged] + published:
            try:
                leftover.unlink(missing_ok=True)
            except OSError as cleanup_error:
                print(
                    f"telegram-userbot: could not remove {leftover.resolve()} after a"
                    f" failed adoption ({cleanup_error}) — delete it by hand",
                    file=sys.stderr,
                )
        print(
            f"telegram-userbot: could not copy {legacy.resolve()} to {path.resolve()}:"
            f" {exc} — nothing was left half-written, the session stays where it is",
            file=sys.stderr,
        )
        return

    for source, _ in pairs:
        try:
            # missing_ok: a second start racing this one may have removed the original
            # already, and there is nothing to warn about a file that is simply gone.
            source.unlink(missing_ok=True)
        except OSError as exc:
            # The anchor already holds the whole session, so this is a leftover copy and
            # not a loss — but it is a copy of the account key and has to be named.
            print(
                f"telegram-userbot: {source.resolve()} still holds a copy of the account"
                f" key and could not be removed ({exc}) — delete it by hand",
                file=sys.stderr,
            )
    print(
        f"telegram-userbot: session moved from {legacy.resolve().parent}"
        f" to {path.resolve().parent}",
        file=sys.stderr,
    )


def _adopt_legacy_session(path: Path) -> None:
    """Carry a session left at an older working-directory-relative path to the anchor.

    A one-time move, and only into a free path: the file holds the MTProto auth key,
    which nothing can regenerate, so a failed move leaves the original exactly where it
    is and says where it went wrong instead of starting an empty session over it.
    """
    if path.exists() or os.getenv("TELEGRAM_SESSION_FILE"):
        return
    for legacy in _legacy_session_candidates():
        if legacy.exists() and legacy.resolve() != path.resolve():
            _move_session(legacy, path)
            return


def _token_file() -> Path:
    # The token and Telethon session are one credential pair. The systemd boundary passes
    # their canonical absolute directory, and both Python and TypeScript consume it.
    return _data_dir() / "telegram-userbot.token"


def _resolve_token() -> str:
    env = os.getenv("TELEGRAM_MCP_TOKEN")
    if env:
        return env.strip()
    f = _token_file()
    return f.read_text().strip() if f.exists() else ""


def _seed_session_env() -> Path:
    """Point upstream at our SQLite session file (created empty if absent = onboarding).

    Must run BEFORE importing telegram_mcp.runtime, whose module-level
    `_discover_accounts()` reads the session env and `sys.exit(1)`s if unset.

    We use a FILE session (not a string): an unauthorized session can't be
    serialized to a non-empty StringSession, but a missing SQLite file is a valid
    empty unauthorized session, and Telethon persists the auth to it automatically
    on QR login — no manual save. Single owner ⇒ no "database is locked".
    """
    path = _session_file()
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    _adopt_legacy_session(path)
    sessions = {"default": path}
    for extra in sorted(_data_dir().glob("telegram-userbot-*.session")):
        label = extra.name[len("telegram-userbot-"):-len(".session")]
        if not extra.is_file() or not re.fullmatch(r"[a-z0-9_]+", label) or label == "default":
            print(f"telegram-userbot: пропуск файла сессии {extra.name!r}", file=sys.stderr)
            continue
        sessions[label] = extra
    prefixes = ("TELEGRAM_SESSION_NAME_", "TELEGRAM_SESSION_STRING_")
    session_files = {session.resolve() for session in sessions.values()}
    external = set()
    for key in list(os.environ):
        for prefix in prefixes:
            if key.startswith(prefix):
                label = key[len(prefix):].lower()
                value = os.environ[key]
                duplicate = prefix == prefixes[0] and value and Path(
                    value if value.endswith(".session") else value + ".session"
                ).resolve() in session_files
                if label in sessions or duplicate:
                    os.environ[key] = ""  # Keep dotenv from restoring a stale value.
                    if duplicate and label not in sessions:
                        print(f"telegram-userbot: пропуск аккаунта {label}: дубль файла сессии", file=sys.stderr)
                elif os.environ[key]:
                    external.add(label)
    if external:
        print(f"telegram-userbot: аккаунты из окружения: {', '.join(sorted(external))}", file=sys.stderr)
    os.environ["TELEGRAM_SESSION_STRING"] = ""
    if len(sessions) == 1 and not external:
        os.environ["TELEGRAM_SESSION_NAME"] = str(path).removesuffix(".session")
    else:
        os.environ["TELEGRAM_SESSION_NAME"] = ""
        for label, session in sessions.items():
            os.environ[f"TELEGRAM_SESSION_NAME_{label.upper()}"] = str(session).removesuffix(".session")
    return path


def _configure_media_roots(runtime) -> None:
    """Confine file tools to an owned private directory, including client Roots."""
    directory = _data_dir() / "userbot-files"
    roots = []
    try:
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise OSError("expected an owned directory with private permissions")
        roots.append(directory.resolve())
    except OSError as exc:
        print(f"telegram-userbot: файловые инструменты выключены: {exc}", file=sys.stderr)
    runtime.SERVER_ALLOWED_ROOTS[:] = roots
    os.environ["TELEGRAM_ALLOW_SERVER_ROOTS_FALLBACK"] = "1"
    within = runtime._path_is_within_root
    def allowed(candidate, root):
        candidate = candidate.resolve()
        if any(part == ".env" or part.startswith(".env.") or
               re.search(r"\.(session|token)(?:-|$)", part, re.IGNORECASE)
               for part in candidate.parts):
            return False
        return within(candidate, root) and any(within(candidate, item) for item in roots)

    runtime._path_is_within_root = allowed
    if roots:
        for client in runtime.clients.values():
            async def download(message, file, _download=client.download_media):
                # Telethon changes suffixes after upstream's path check. A fresh
                # private directory has no pre-existing filename or symlink to hit.
                target = Path(tempfile.mkdtemp(dir=roots[0])) / Path(file).name
                return await _download(message, file=str(target))
            client.download_media = download


def main() -> None:
    import asyncio

    # The SQLite session file holds the MTProto auth key (= full account access). Force
    # private perms on everything we create (0600 files / 0700 dirs) so a co-tenant on
    # the host can't read it — systemd's default umask is 022 (world-readable 0644).
    os.umask(0o077)

    host = os.getenv("TELEGRAM_MCP_HOST", "127.0.0.1")
    port = int(os.getenv("TELEGRAM_MCP_PORT", "8724"))
    token = _resolve_token()
    if not token:
        _fail("no proxy token — run `iva userbot setup` (writes data/telegram-userbot.token)")
    if not os.getenv("TELEGRAM_API_ID") or not os.getenv("TELEGRAM_API_HASH"):
        _fail("TELEGRAM_API_ID and TELEGRAM_API_HASH are required (create an app at my.telegram.org)")

    session_path = _seed_session_env()

    # Import AFTER seeding the session env — runtime builds `mcp` + the
    # Telethon client; importing the tools package fires every @mcp.tool decorator.
    from telegram_mcp import runtime
    from telegram_mcp.runtime import mcp, clients, get_client, _apply_exposed_tools_mode
    _configure_media_roots(runtime)
    import telegram_mcp.tools  # noqa: F401 — registers all tools with `mcp`

    # Honor TELEGRAM_EXPOSED_TOOLS (e.g. "read-only"); upstream normally does this in
    # its runner, which we bypass. Default "all".
    removed = _apply_exposed_tools_mode(mcp)
    if removed:
        print(f"telegram-userbot: read-only mode, pruned {len(removed)} write tools", file=sys.stderr)

    print(f"telegram-userbot: аккаунты: {', '.join(clients)}", file=sys.stderr)

    # Register onboarding tools AFTER pruning so QR login always works — you must be
    # able to connect the account even under read-only exposure.
    from onboarding import register_onboarding_tools

    register_onboarding_tools(mcp, clients["default"])

    # Enforce the anti-ban safety guide as server behavior (FloodWait compliance,
    # pacing, circuit-breaker) by wrapping the client's outbound methods in place.
    from guardrails import install_guardrails

    for client in clients.values():
        install_guardrails(client)

    import uvicorn
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse

    expected = f"Bearer {token}"

    class BearerAuthMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            if request.headers.get("authorization") != expected:
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            return await call_next(request)

    class EnsureConnectedMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            for label, client in clients.items():
                try:
                    if not client.is_connected():
                        await client.connect()
                except Exception as exc:  # noqa: BLE001
                    print(f"telegram-userbot: reconnect failed [{label}]: {exc}", file=sys.stderr)
            return await call_next(request)

    async def health(_request):
        return JSONResponse(await _health_payload(clients["default"]))

    async def amain() -> None:
        from tool_contracts import install_tool_contracts

        repaired = await install_tool_contracts(mcp, vars(telegram_mcp.tools), get_client)
        print(
            f"telegram-userbot: nullable signatures repaired for {len(repaired['nullable'])} tools",
            file=sys.stderr,
        )
        for label, client in clients.items():
            await client.connect()  # .start() would prompt for interactive login
            authorized = await client.is_user_authorized()
            print(
                f"telegram-userbot: session {label} {'authorized' if authorized else 'NOT authorized (onboarding mode)'}"
                f" [{session_path if label == 'default' else label}]",
                file=sys.stderr,
            )

        mcp.settings.host = host
        mcp.settings.port = port
        # Bound to localhost + bearer-protected; the DNS-rebinding validator only adds
        # 421s for the loopback/host aliases iva uses, so disable it here.
        from mcp.server.transport_security import TransportSecuritySettings

        mcp.settings.transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        )

        app = mcp.streamable_http_app()
        app.add_route("/healthz", health, methods=["GET"])
        # add_middleware stacks outermost-last: auth rejects before connectivity.
        # FastMCP owns input validation and both JSON/SSE transport unchanged.
        app.add_middleware(EnsureConnectedMiddleware)
        app.add_middleware(BearerAuthMiddleware)

        print(f"telegram-userbot: listening on http://{host}:{port}/mcp", file=sys.stderr)
        config = uvicorn.Config(app, host=host, port=port, log_level="warning", lifespan="on")
        await uvicorn.Server(config).serve()

    import nest_asyncio

    nest_asyncio.apply()
    asyncio.run(amain())


if __name__ == "__main__":
    main()
