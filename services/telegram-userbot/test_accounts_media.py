"""Exercise the pinned upstream with dummy SQLite sessions and no Telegram traffic."""
import asyncio
from datetime import datetime, timezone
import importlib
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

import serve


class AccountsMediaTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.data = self.root / "data"
        self.data.mkdir()
        self.downloads = self.root / "tmp"
        self.vault = self.root / "vault"
        self.vault.mkdir()
        self.environment = patch.dict(os.environ, {
            "TELEGRAM_API_ID": "12345", "TELEGRAM_API_HASH": "test-api-hash",
            "ASSISTANT_DATA_DIR": str(self.data), "ASSISTANT_TMP": str(self.downloads),
            "ASSISTANT_VAULT_DIR": str(self.vault),
        }, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def discover(self):
        serve._seed_session_env()
        with patch("dotenv.load_dotenv"):
            runtime = importlib.import_module("telegram_mcp.runtime")
        clients = runtime._discover_accounts()
        self.addCleanup(lambda: [client.session.close() for client in clients.values()])
        return runtime, clients

    async def test_two_empty_sessions_are_discovered_without_bare_variable(self):
        for name in ("telegram-userbot.session", "telegram-userbot-second.session"):
            (self.data / name).touch()
        runtime, clients = self.discover()
        self.assertEqual(set(clients), {"default", "second"})
        self.assertEqual(os.environ["TELEGRAM_SESSION_NAME"], "")
        with patch.object(runtime, "clients", clients):
            self.assertIs(runtime.get_client("second"), clients["second"])

    async def test_single_session_keeps_legacy_environment(self):
        (self.data / "telegram-userbot.session").touch()
        runtime, clients = self.discover()
        self.assertEqual(set(clients), {"default"})
        self.assertEqual(os.environ["TELEGRAM_SESSION_NAME"], str(self.data / "telegram-userbot"))
        with patch.object(runtime, "clients", clients):
            self.assertIs(runtime.get_client(), clients["default"])

    def check_dotenv_accounts(self, values, labels):
        """A clean import reloads the same real .env that supplied the unit's env."""
        (self.data / "telegram-userbot.session").touch()
        (self.root / ".env").write_text("\n".join(f"{key}={value}" for key, value in values.items()))
        script = "\n".join([
            "import json, os, serve",
            "from dotenv import load_dotenv",
            "assert load_dotenv()",  # systemd EnvironmentFile equivalent, no mock
            "serve._seed_session_env()",
            "from telegram_mcp import runtime",  # calls real load_dotenv again
            "print(json.dumps({'sessions': {label: getattr(client.session, 'filename', None) for label, client in runtime.clients.items()}, 'env': {key: os.environ.get(key) for key in json.loads(os.environ['TEST_SESSION_KEYS'])}}))",
            "for client in runtime.clients.values(): client.session.close()",
        ])
        environment = dict(os.environ, PYTHONPATH=str(Path(serve.__file__).parent.resolve()),
                           TEST_SESSION_KEYS=json.dumps(list(values)))
        result = subprocess.run([sys.executable, "-c", script], cwd=self.root, env=environment,
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["sessions"], {
            label: str(self.data / f"telegram-userbot{'' if label == 'default' else '-' + label}.session")
            for label in labels
        })
        for key in values:
            self.assertEqual(payload["env"][key], "", key)
        return result.stderr

    async def test_real_dotenv_cannot_restore_stale_session_variables(self):
        from telethon.crypto import AuthKey
        from telethon.sessions import StringSession

        string = StringSession()
        string.set_dc(2, "149.154.167.50", 443)
        string.auth_key = AuthKey(bytes(range(256)))
        for key, multi in (("TELEGRAM_SESSION_NAME_DEFAULT", False),
                           ("TELEGRAM_SESSION_STRING_DEFAULT", False),
                           ("TELEGRAM_SESSION_STRING_WORK", True),
                           ("TELEGRAM_SESSION_STRING", False),
                           ("TELEGRAM_SESSION_NAME", True)):
            with self.subTest(key=key):
                extra = self.data / "telegram-userbot-work.session"
                if multi:
                    extra.touch()
                else:
                    extra.unlink(missing_ok=True)
                value = str(self.root / "missing/stale") if "NAME" in key else string.save()
                self.check_dotenv_accounts({key: value}, {"default", "work"} if multi else {"default"})

    async def test_real_dotenv_file_aliases_do_not_open_a_second_client(self):
        session = self.data / "telegram-userbot.session"
        session.touch()
        (self.root / "session-alias.session").symlink_to(session)
        for value in (str(session), str(session.with_suffix("")),
                      str(self.data / "../data/telegram-userbot"), str(self.root / "session-alias")):
            with self.subTest(value=value):
                errors = self.check_dotenv_accounts({"TELEGRAM_SESSION_NAME_MAIN": value}, {"default"})
                self.assertEqual(errors.count("main"), 1)
                self.assertIn("дубль", errors)

    async def test_saved_sessions_replace_stale_variables_without_duplicate_clients(self):
        (self.data / "telegram-userbot-second.session").touch()
        serve._seed_session_env()
        runtime = importlib.import_module("telegram_mcp.runtime")
        external = str(self.root / "manual")
        with patch.dict(os.environ, {
            "TELEGRAM_SESSION_NAME_default": "stale-default",
            "TELEGRAM_SESSION_STRING_DEFAULT": "invalid-stale-string",
            "TELEGRAM_SESSION_NAME_SECOND": "stale-second",
            "TELEGRAM_SESSION_STRING_second": "invalid-stale-string",
            "TELEGRAM_SESSION_NAME_MANUAL": external,
        }), patch.object(runtime, "_build_client", return_value=object()) as build:
            errors = io.StringIO()
            with redirect_stderr(errors):
                serve._seed_session_env()
            accounts = runtime._discover_accounts()
            self.assertEqual(set(accounts), {"default", "second", "manual"})
            self.assertEqual(build.call_count, 3)
            self.assertEqual({args[0] for args, _ in build.call_args_list}, {
                str(self.data / "telegram-userbot"),
                str(self.data / "telegram-userbot-second"), external,
            })
            self.assertIn("manual", errors.getvalue())
            self.assertNotIn("invalid-stale-string", errors.getvalue())

    async def test_external_account_is_preserved_with_one_saved_session(self):
        with patch.dict(os.environ, {
            "TELEGRAM_SESSION_STRING_DEFAULT": "invalid-stale-string",
            "TELEGRAM_SESSION_NAME_MANUAL": str(self.root / "manual"),
        }):
            _, clients = self.discover()
            self.assertEqual(set(clients), {"default", "manual"})
            self.assertEqual(os.environ["TELEGRAM_SESSION_NAME"], "")
            self.assertEqual(os.environ["TELEGRAM_SESSION_STRING_DEFAULT"], "")

    async def test_explicit_session_filename_keeps_its_suffix(self):
        with patch.dict(os.environ, {"TELEGRAM_SESSION_FILE": str(self.data / "custom.name")}):
            serve._seed_session_env()
            self.assertEqual(os.environ["TELEGRAM_SESSION_NAME"], str(self.data / "custom.name"))

    async def test_proxy_starts_and_lists_both_empty_accounts_over_http(self):
        await self.check_proxy()

    async def test_proxy_still_serves_accounts_with_an_unsafe_file_root(self):
        (self.data / "userbot-files").symlink_to(self.vault, target_is_directory=True)
        await self.check_proxy(disabled_files=True)

    async def check_proxy(self, disabled_files=False):
        for name in ("telegram-userbot.session", "telegram-userbot-second.session"):
            (self.data / name).touch()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        environment = dict(os.environ, TELEGRAM_MCP_TOKEN="test-only-token", TELEGRAM_MCP_PORT=str(port))
        fixture = Path(__file__).parent / "fixtures" / "accounts_server.py"
        with (self.root / "server.log").open("w+") as logs:
            child = subprocess.Popen([sys.executable, str(fixture)], env=environment,
                                     cwd=self.root, stdout=logs, stderr=logs)
            try:
                headers = {"Authorization": "Bearer test-only-token"}
                async with httpx.AsyncClient() as http:
                    for _ in range(100):
                        try:
                            response = await http.get(f"http://127.0.0.1:{port}/healthz", headers=headers)
                            if response.status_code == 200:
                                break
                        except httpx.ConnectError:
                            pass
                        if child.poll() is not None:
                            logs.seek(0)
                            self.fail(logs.read())
                        await asyncio.sleep(0.05)
                    else:
                        self.fail("proxy did not start")
                    self.assertEqual(response.json(), {"state": "unauthorized"})
                    denied = await http.get(f"http://127.0.0.1:{port}/healthz")
                    self.assertEqual(denied.status_code, 401)
                async with streamablehttp_client(f"http://127.0.0.1:{port}/mcp", headers=headers) as (read, write, _):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        result = await session.call_tool("list_accounts", {})
                        self.assertFalse(result.isError)
                        text = "\n".join(item.text for item in result.content if hasattr(item, "text"))
                        self.assertIn("default:", text)
                        self.assertIn("second:", text)
                        print(f"local proxy list_accounts:\n{text}")
            finally:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
            logs.seek(0)
            output = logs.read()
            if disabled_files:
                self.assertEqual(output.count("файловые инструменты выключены"), 1)
            self.assertIn("аккаунты: default, second", output)
            for name in ("telegram-userbot.session", "telegram-userbot-second.session"):
                self.assertIn(f"TEST guarded {name}", output)
                self.assertGreaterEqual(output.count(f"TEST connected {name}"), 2)

    async def test_invalid_and_duplicate_default_labels_are_skipped(self):
        for label in ("UPPER", "two-words", "", "default", "два"):
            (self.data / f"telegram-userbot-{label}.session").touch()
        errors = io.StringIO()
        with redirect_stderr(errors):
            _, clients = self.discover()
        self.assertEqual(set(clients), {"default"})
        self.assertEqual(errors.getvalue().count("пропуск"), 5)

    async def test_unsafe_media_root_disables_files_without_stopping_service(self):
        root = self.data / "userbot-files"
        for unsafe in ("symlink", "permissions", "owner", "file"):
            with self.subTest(unsafe=unsafe):
                if unsafe == "symlink":
                    root.symlink_to(self.vault, target_is_directory=True)
                elif unsafe == "file":
                    root.touch()
                else:
                    root.mkdir(mode=0o755 if unsafe == "permissions" else 0o700)
                runtime = SimpleNamespace(SERVER_ALLOWED_ROOTS=[self.vault], clients={},
                                          _path_is_within_root=lambda candidate, base: candidate.is_relative_to(base))
                errors = io.StringIO()
                with patch.object(serve.os, "getuid", return_value=-1 if unsafe == "owner" else os.getuid()), \
                     redirect_stderr(errors):
                    serve._configure_media_roots(runtime)
                self.assertEqual(runtime.SERVER_ALLOWED_ROOTS, [])
                self.assertFalse(runtime._path_is_within_root(self.vault / "file", self.vault))
                self.assertEqual(len(errors.getvalue().splitlines()), 1)
                self.assertIn("выключены", errors.getvalue())
                if root.is_symlink() or root.is_file():
                    root.unlink()
                else:
                    root.rmdir()

    async def test_telethon_suffix_symlink_cannot_overwrite_session(self):
        await self.check_telethon_download("lecture")

    async def test_telethon_dangling_symlink_cannot_create_session(self):
        await self.check_telethon_download("voice")

    async def check_telethon_download(self, stem):
        runtime, clients = self.discover()
        import telegram_mcp.tools.media as media
        from telethon.tl import types

        with patch.object(runtime, "clients", clients), \
             patch.object(runtime, "SERVER_ALLOWED_ROOTS", []), \
             patch.object(runtime, "_path_is_within_root", runtime._path_is_within_root):
            serve._configure_media_roots(runtime)
            root = runtime.SERVER_ALLOWED_ROOTS[0]
            session = self.data / "telegram-userbot.session"
            before = session.read_bytes()
            evil = self.data / "telegram-userbot-evil.session"
            (root / "lecture").symlink_to(session)
            (root / "voice.oga").symlink_to(evil)
            document = types.Document(id=1, access_hash=1, file_reference=b"", date=datetime.now(timezone.utc),
                                      mime_type="audio/ogg", size=146 * 1024 * 1024,
                                      dc_id=1, attributes=[])
            message = types.Message(id=1, peer_id=types.PeerUser(1),
                                    media=types.MessageMediaDocument(document=document))

            async def transfer(_location, file, **_kwargs):
                Path(file).write_bytes(b"downloaded audio")

            context = SimpleNamespace(session=SimpleNamespace(list_roots=AsyncMock(
                return_value=SimpleNamespace(roots=[]))))
            with patch.object(media, "resolve_entity", AsyncMock(return_value="chat")), \
                 patch.object(clients["default"], "get_messages", AsyncMock(return_value=message)), \
                 patch.object(clients["default"], "_download_file", AsyncMock(side_effect=transfer)):
                saved = []
                for request in (root / f"{stem}.ogg", root / f"{stem}.ogg"):
                    with self.subTest(request=request):
                        result = await media.download_media(1, 1, str(request), context)
                        self.assertFalse(evil.exists())
                        self.assertEqual(session.read_bytes(), before)
                        self.assertIn("Media downloaded to", result)
                        path = Path(result.removeprefix("Media downloaded to ").removesuffix("."))
                        self.assertTrue(path.is_relative_to(root))
                        self.assertNotEqual(path.parent, root)
                        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
                        self.assertEqual(path.read_bytes(), b"downloaded audio")
                        saved.append(path.parent)
                self.assertEqual(len(set(saved)), 2)

    async def test_empty_roots_allow_media_and_reject_secrets_and_escapes(self):
        runtime, clients = self.discover()
        import telegram_mcp.tools.media as media

        original_check = runtime._path_is_within_root
        original_roots = runtime.SERVER_ALLOWED_ROOTS[:]
        self.addCleanup(setattr, runtime, "_path_is_within_root", original_check)
        self.addCleanup(lambda: runtime.SERVER_ALLOWED_ROOTS.__setitem__(slice(None), original_roots))
        serve._configure_media_roots(runtime)
        self.downloads = self.data / "userbot-files"
        self.assertEqual(runtime.SERVER_ALLOWED_ROOTS, [self.downloads])
        self.assertEqual(self.downloads.stat().st_mode & 0o777, 0o700)
        context = SimpleNamespace(session=SimpleNamespace(list_roots=AsyncMock(
            return_value=SimpleNamespace(roots=[]))))
        client = clients["default"]
        message = SimpleNamespace(media=True, file=SimpleNamespace(size=146 * 1024 * 1024))

        async def download(_message, file):
            target = Path(file + ".ogg")
            target.write_bytes(b"media")
            return str(target)

        with patch.object(runtime, "clients", clients), \
             patch.object(media, "resolve_entity", AsyncMock(return_value="chat")), \
             patch.object(client, "get_messages", AsyncMock(return_value=message)), \
             patch.object(client, "download_media", AsyncMock(side_effect=download)), \
             patch.object(client, "send_file", AsyncMock()) as send:
            for directory in (self.downloads,):
                result = await media.download_media(1, 1, str(directory / "lecture.ogg"), context)
                self.assertIn("Media downloaded to", result)
                self.assertIn("File sent", await media.send_file(1, str(directory / "lecture.ogg"), ctx=context))
            for forbidden in (self.data / "telegram-userbot.session", self.data / "telegram-userbot.token",
                              self.root / ".env", self.downloads / "copy.session",
                              self.vault / "copy.token", self.downloads / ".env",
                              self.root / "outside.ogg", self.vault / "copy.session-wal",
                              self.vault / "outside.ogg", self.root / "tmp/outside.ogg"):
                forbidden.parent.mkdir(exist_ok=True)
                forbidden.touch(exist_ok=True)
                before = send.await_count
                result = await media.send_file(1, str(forbidden), ctx=context)
                self.assertNotIn("File sent", result)
                self.assertEqual(send.await_count, before)
                result = await media.download_media(1, 1, str(forbidden), context)
                self.assertNotIn("Media downloaded to", result)
            link = self.downloads / "innocent.ogg"
            link.symlink_to(self.data / "telegram-userbot.session")
            for path in (str(link), str(self.downloads / "../data/telegram-userbot.session")):
                self.assertNotIn("File sent", await media.send_file(1, path, ctx=context))
            # Client Roots cannot widen the server's fixed boundary.
            context.session.list_roots.return_value = SimpleNamespace(roots=[SimpleNamespace(uri=self.root.as_uri())])
            self.assertNotIn("File sent", await media.send_file(1, str(self.root / ".env"), ctx=context))
            self.assertNotIn("File sent", await media.send_file(1, str(self.root / "outside.ogg"), ctx=context))
            self.assertNotIn("Album sent", await media.send_album(1, [str(self.vault / "lecture.ogg"), str(link)], ctx=context))
            self.assertIn("File sent", await media.send_file(1, str(self.downloads / "lecture.ogg"), ctx=context))


if __name__ == "__main__":
    unittest.main()
