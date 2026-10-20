import io
import os
import tempfile
import unittest
from contextlib import contextmanager, redirect_stderr
from pathlib import Path
from unittest import mock

import serve
from serve import (
    SESSION_NAME,
    _adopt_legacy_session,
    _legacy_session_candidates,
    _root_dir,
    _session_file,
)

# Pinned by a landmark below, never by the number of directories walked: every
# expectation here is written against a root that has been proved to be the
# installation, so an off-by-one in serve.py's anchor fails a test instead of moving
# the MTProto auth key into a directory the next `iva update` retires.
IVA_ROOT = Path(__file__).resolve().parents[2]


@contextmanager
def working_directory(path: Path):
    previous = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def env(**values: str):
    return mock.patch.dict(os.environ, values, clear=True)


class AnchorTest(unittest.TestCase):
    def test_the_expected_root_is_an_iva_installation(self):
        manifest = IVA_ROOT / "package.json"
        self.assertTrue(manifest.is_file(), f"no package.json at {IVA_ROOT}")
        self.assertIn('"name": "iva"', manifest.read_text(encoding="utf-8"))

    def test_serve_anchors_on_that_root_and_not_a_level_off(self):
        self.assertEqual(_root_dir(), IVA_ROOT)
        self.assertEqual(
            Path(serve.__file__).resolve(),
            IVA_ROOT / "services" / "telegram-userbot" / "serve.py",
        )


class SessionFileTest(unittest.TestCase):
    def test_an_explicit_path_wins(self):
        with env(TELEGRAM_SESSION_FILE="/srv/keys/iva.session"):
            self.assertEqual(_session_file(), Path("/srv/keys/iva.session"))

    def test_a_relative_data_dir_fails_closed(self):
        errors = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, working_directory(Path(tmp)):
            alternate = Path(tmp) / "runtime" / SESSION_NAME
            with (
                env(ASSISTANT_DATA_DIR=" runtime "),
                redirect_stderr(errors),
                self.assertRaises(SystemExit),
            ):
                _session_file()
            self.assertFalse(alternate.exists())
        self.assertIn("must be a canonical absolute path", errors.getvalue())

    def test_no_data_dir_resolves_beside_the_installation(self):
        with tempfile.TemporaryDirectory() as tmp, working_directory(Path(tmp)):
            with env():
                self.assertEqual(_session_file(), IVA_ROOT / "data" / SESSION_NAME)

    def test_an_absolute_data_dir_is_honored(self):
        with env(ASSISTANT_DATA_DIR="/mnt/state"):
            self.assertEqual(_session_file(), Path("/mnt/state") / SESSION_NAME)


class LegacyCandidateTest(unittest.TestCase):
    def test_a_relative_data_dir_is_tried_before_the_bare_working_directory(self):
        with tempfile.TemporaryDirectory() as tmp, working_directory(Path(tmp)):
            with env(ASSISTANT_DATA_DIR="data"):
                here = Path(os.getcwd())
                self.assertEqual(
                    _legacy_session_candidates(),
                    (here / "data" / SESSION_NAME, here / SESSION_NAME),
                )

    def test_an_absolute_data_dir_leaves_only_the_working_directory(self):
        with tempfile.TemporaryDirectory() as tmp, working_directory(Path(tmp)):
            with env(ASSISTANT_DATA_DIR="/mnt/state"):
                self.assertEqual(
                    _legacy_session_candidates(),
                    (
                        IVA_ROOT / "data" / SESSION_NAME,
                        Path(os.getcwd()) / SESSION_NAME,
                    ),
                )


class AdoptLegacySessionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = Path(self.tmp.name) / "services" / "telegram-userbot"
        self.new = Path(self.tmp.name) / "data" / SESSION_NAME
        self.old.mkdir(parents=True)
        self.new.parent.mkdir(parents=True)
        self.addCleanup(self.tmp.cleanup)

    def adopt(self, **environment: str) -> str:
        errors = io.StringIO()
        with env(**environment), working_directory(self.old), redirect_stderr(errors):
            _adopt_legacy_session(self.new)
        return errors.getvalue()

    def test_moves_the_session_and_its_journal(self):
        (self.old / SESSION_NAME).write_text("auth key")
        (self.old / f"{SESSION_NAME}-journal").write_text("journal")

        message = self.adopt()

        self.assertEqual(self.new.read_text(), "auth key")
        self.assertEqual(
            (self.new.parent / f"{SESSION_NAME}-journal").read_text(), "journal"
        )
        self.assertFalse((self.old / SESSION_NAME).exists())
        self.assertIn("session moved from", message)
        # Absolute on both sides: a relative path in the log is unusable to whoever
        # has to finish a half-done move by hand.
        self.assertIn(str(self.old.resolve()), message)
        self.assertIn(str(self.new.parent.resolve()), message)

    def test_the_adopted_session_lands_private_however_it_was_stored(self):
        # The sessions worth adopting are the old ones, written before the proxy set
        # umask 0077 — 0644, readable by every other account on the box. Carrying that
        # mode to the anchor would keep the account key world-readable exactly for the
        # installations this migration exists for.
        legacy = self.old / SESSION_NAME
        legacy.write_text("auth key")
        legacy.chmod(0o644)
        (self.old / f"{SESSION_NAME}-journal").write_text("journal")
        (self.old / f"{SESSION_NAME}-journal").chmod(0o644)

        self.adopt()

        self.assertEqual(self.new.stat().st_mode & 0o777, 0o600)
        self.assertEqual(
            (self.new.parent / f"{SESSION_NAME}-journal").stat().st_mode & 0o777,
            0o600,
        )

    def test_adopts_a_session_left_before_assistant_data_dir_existed(self):
        # The variable arrived later; the account was linked while the session still
        # resolved to the bare working directory.
        (self.old / SESSION_NAME).write_text("auth key")

        self.adopt(ASSISTANT_DATA_DIR="data")

        self.assertEqual(self.new.read_text(), "auth key")

    def test_a_relative_data_dir_under_the_old_cwd_is_adopted_first(self):
        legacy_dir = self.old / "data"
        legacy_dir.mkdir()
        (legacy_dir / SESSION_NAME).write_text("newer")
        (self.old / SESSION_NAME).write_text("older")

        self.adopt(ASSISTANT_DATA_DIR="data")

        self.assertEqual(self.new.read_text(), "newer")
        self.assertEqual((self.old / SESSION_NAME).read_text(), "older")

    def test_canonical_custom_data_adopts_the_previous_fixed_anchor(self):
        self.new.write_text("auth key")
        custom = Path(self.tmp.name) / "runtime" / SESSION_NAME
        custom.parent.mkdir()
        errors = io.StringIO()

        with (
            mock.patch.object(serve, "_root_dir", return_value=Path(self.tmp.name)),
            env(ASSISTANT_DATA_DIR=str(custom.parent)),
            working_directory(self.old),
            redirect_stderr(errors),
        ):
            _adopt_legacy_session(custom)

        self.assertEqual(custom.read_text(), "auth key")
        self.assertFalse(self.new.exists())
        self.assertIn("session moved from", errors.getvalue())

    def test_keeps_the_anchored_session_when_both_exist(self):
        (self.old / SESSION_NAME).write_text("stale")
        self.new.write_text("live")

        self.adopt()

        self.assertEqual(self.new.read_text(), "live")
        self.assertEqual((self.old / SESSION_NAME).read_text(), "stale")

    def test_leaves_a_legacy_session_alone_when_the_path_is_explicit(self):
        (self.old / SESSION_NAME).write_text("auth key")

        self.adopt(TELEGRAM_SESSION_FILE=str(self.new))

        self.assertFalse(self.new.exists())
        self.assertEqual((self.old / SESSION_NAME).read_text(), "auth key")

    def test_a_second_run_changes_nothing(self):
        (self.old / SESSION_NAME).write_text("auth key")

        self.adopt()
        second = self.adopt()

        self.assertEqual(self.new.read_text(), "auth key")
        self.assertEqual(second, "")

    def test_nothing_to_adopt_leaves_the_target_missing_and_says_nothing(self):
        message = self.adopt()

        self.assertFalse(self.new.exists())
        self.assertEqual(message, "")

    def test_a_session_that_vanishes_mid_flight_is_not_announced_as_moved(self):
        # Two proxies starting at once: the loser finds the files already gone, and a
        # "session moved" line it did not earn sends the reader to the wrong directory.
        legacy = self.old / SESSION_NAME
        legacy.write_text("auth key")
        real_exists = Path.exists

        def vanishing(candidate: Path) -> bool:
            present = real_exists(candidate)
            # resolve(), not ==: the working directory comes back physical (/private
            # on macOS), so the plain paths never compare equal.
            if present and candidate.resolve() == legacy.resolve():
                legacy.unlink()
            return present

        with mock.patch.object(Path, "exists", vanishing):
            message = self.adopt()

        self.assertFalse(self.new.exists())
        self.assertEqual(message, "")

    def anchored_files(self) -> list[str]:
        """Everything sitting in the destination directory, temporaries included."""
        return sorted(entry.name for entry in self.new.parent.iterdir())

    def test_a_copy_that_dies_mid_file_leaves_no_stump_at_the_anchor(self):
        # The destructive shape: across filesystems a copy is what actually runs, and a
        # half-written file at the anchor would be read as "already adopted" forever,
        # hiding the whole session at the old path behind a corpse Telethon cannot use.
        legacy = self.old / SESSION_NAME
        legacy.write_bytes(b"SQLite format 3\x00auth key")
        original = legacy.read_bytes()

        def half_written_copy(source, target, *args, **kwargs):
            payload = Path(source).read_bytes()
            Path(target).write_bytes(payload[: len(payload) // 2])
            raise OSError(28, "No space left on device")

        with mock.patch.object(serve.shutil, "copy2", half_written_copy):
            message = self.adopt()

        self.assertEqual(self.anchored_files(), [])
        self.assertEqual(legacy.read_bytes(), original)
        self.assertIn("could not copy", message)
        self.assertNotIn("session moved from", message)

        # And the retry is not blocked by anything the failed attempt left behind.
        retry = self.adopt()

        self.assertEqual(self.new.read_bytes(), original)
        self.assertFalse(legacy.exists())
        self.assertIn("session moved from", retry)

    def test_a_copy_that_fails_outright_keeps_the_database_and_its_journal(self):
        legacy = self.old / SESSION_NAME
        legacy.write_text("auth key")
        journal = self.old / f"{SESSION_NAME}-journal"
        journal.write_text("journal")

        def failing_copy(source, target, *args, **kwargs):
            raise OSError(13, "Permission denied")

        with mock.patch.object(serve.shutil, "copy2", failing_copy):
            message = self.adopt()

        self.assertEqual(legacy.read_text(), "auth key")
        self.assertEqual(journal.read_text(), "journal")
        self.assertEqual(self.anchored_files(), [])
        self.assertIn("could not copy", message)
        self.assertIn(str(legacy.resolve()), message)
        self.assertNotIn("session moved from", message)

    def test_a_failed_publish_rolls_back_every_file_it_had_replaced(self):
        # os.replace is atomic per file, not across them: if the journal lands and the
        # database does not, the anchor must go back to empty rather than keep a pair
        # the originals no longer match.
        legacy = self.old / SESSION_NAME
        legacy.write_text("auth key")
        (self.old / f"{SESSION_NAME}-journal").write_text("journal")
        real_replace = serve.os.replace

        def failing_replace(source, target, *args, **kwargs):
            if str(target).endswith("-journal"):
                raise OSError(5, "Input/output error")
            return real_replace(source, target, *args, **kwargs)

        with mock.patch.object(serve.os, "replace", failing_replace):
            message = self.adopt()

        self.assertEqual(self.anchored_files(), [])
        self.assertEqual(legacy.read_text(), "auth key")
        self.assertEqual((self.old / f"{SESSION_NAME}-journal").read_text(), "journal")
        self.assertNotIn("session moved from", message)

    def test_an_original_a_racing_start_removed_is_not_announced_as_a_leftover(self):
        # Two starts adopting at once: by the time this one drops the originals they
        # can already be gone, and "still holds a copy of the account key, delete it by
        # hand" about a file that no longer exists sends the owner hunting for nothing.
        legacy = self.old / SESSION_NAME
        legacy.write_text("auth key")
        real_replace = serve.os.replace

        def replace_and_lose_the_original(source, target, *args, **kwargs):
            result = real_replace(source, target, *args, **kwargs)
            legacy.unlink(missing_ok=True)
            return result

        with mock.patch.object(serve.os, "replace", replace_and_lose_the_original):
            message = self.adopt()

        self.assertEqual(self.new.read_text(), "auth key")
        self.assertNotIn("delete it by hand", message)
        self.assertIn("session moved from", message)

    def test_an_original_that_cannot_be_removed_is_named_but_not_a_failure(self):
        legacy = self.old / SESSION_NAME
        legacy.write_text("auth key")
        real_unlink = Path.unlink

        def failing_unlink(target: Path, *args, **kwargs):
            if target.resolve() == legacy.resolve():
                raise OSError(1, "Operation not permitted")
            return real_unlink(target, *args, **kwargs)

        with mock.patch.object(Path, "unlink", failing_unlink):
            message = self.adopt()

        # The anchor holds the whole session, so this is a leftover copy of the key.
        self.assertEqual(self.new.read_text(), "auth key")
        self.assertEqual(legacy.read_text(), "auth key")
        self.assertIn("delete it by hand", message)
        self.assertIn("session moved from", message)


class ExtractAccountLabelTest(unittest.TestCase):
    def test_extract_various_formats(self):
        from serve import _extract_account_label
        self.assertEqual(_extract_account_label("telegram-userbot.session"), "default")
        self.assertEqual(_extract_account_label("telegram-userbot-work.session"), "work")
        self.assertEqual(_extract_account_label("telegram-userbot_personal.session"), "personal")
        self.assertEqual(_extract_account_label("telegram-userbot.alerts.session"), "alerts")
        self.assertEqual(_extract_account_label("finance.session"), "finance")
        # Non-sessions and sidecars
        self.assertIsNone(_extract_account_label("telegram-userbot.session-journal"))
        self.assertIsNone(_extract_account_label("work.session-wal"))
        self.assertIsNone(_extract_account_label("notes.txt"))


class DiscoverSavedSessionsTest(unittest.TestCase):
    def test_discovers_multiple_sessions(self):
        from serve import _discover_saved_sessions
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / "telegram-userbot.session").write_text("default auth")
            (data / "telegram-userbot-work.session").write_text("work auth")
            (data / "personal.session").write_text("personal auth")
            (data / "telegram-userbot.session-journal").write_text("sidecar")

            with env(ASSISTANT_DATA_DIR=str(data)):
                sessions = _discover_saved_sessions()
                self.assertIn("default", sessions)
                self.assertIn("work", sessions)
                self.assertIn("personal", sessions)
                self.assertEqual(sessions["default"], data / "telegram-userbot.session")
                self.assertEqual(sessions["work"], data / "telegram-userbot-work.session")
                self.assertEqual(sessions["personal"], data / "personal.session")

    def test_seeds_session_env_for_multiple_accounts(self):
        from serve import _seed_session_env
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / "telegram-userbot.session").write_text("default auth")
            (data / "telegram-userbot-work.session").write_text("work auth")

            with env(ASSISTANT_DATA_DIR=str(data)):
                _seed_session_env()
                self.assertEqual(os.environ.get("TELEGRAM_SESSION_NAME"), str(data / "telegram-userbot"))
                self.assertEqual(os.environ.get("TELEGRAM_SESSION_NAME_WORK"), str(data / "telegram-userbot-work"))


class AllowedRootsTest(unittest.TestCase):
    def test_configures_temp_and_vault_roots_and_fallback(self):
        from serve import _configure_allowed_roots
        class FakeRuntime:
            SERVER_ALLOWED_ROOTS = []
        with tempfile.TemporaryDirectory() as tmp_vault:
            with env(ASSISTANT_VAULT_DIR=tmp_vault):
                fake_runtime = FakeRuntime()
                roots = _configure_allowed_roots(runtime_module=fake_runtime)
                self.assertTrue(any(str(Path(tempfile.gettempdir()).resolve()) in str(r) for r in roots))
                self.assertTrue(any(str(Path(tmp_vault).resolve()) in str(r) for r in roots))
                self.assertEqual(os.environ.get("TELEGRAM_ALLOW_SERVER_ROOTS_FALLBACK"), "1")
                self.assertEqual(fake_runtime.SERVER_ALLOWED_ROOTS, roots)


if __name__ == "__main__":
    unittest.main()
