import io
import os
import tempfile
import unittest
from contextlib import contextmanager, redirect_stderr
from pathlib import Path
from unittest import mock

import serve
from serve import SESSION_NAME, _root_dir, _session_file

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


class OldPlaceTest(unittest.TestCase):
    """specs/UpdateFloor.tla, NoSilentLoss: releases before 0.3.21 kept the session in the
    unit's working directory, 0.3.21 to 0.3.23 under <root>/data whatever the data dir."""

    def test_a_session_at_an_older_place_is_left_as_it_was(self):
        with tempfile.TemporaryDirectory() as tmp:
            cwd = Path(tmp) / "services" / "telegram-userbot"
            data = Path(tmp) / "state"
            cwd.mkdir(parents=True)
            data.mkdir()
            old = [cwd / SESSION_NAME, cwd / (SESSION_NAME + "-journal")]
            for file in old:
                file.write_bytes(b"auth key")
                os.chmod(file, 0o644)
            before = [(file.read_bytes(), file.stat().st_mode, file.stat().st_ino) for file in old]
            errors = io.StringIO()
            with env(ASSISTANT_DATA_DIR=str(data)), working_directory(cwd), redirect_stderr(errors):
                path = serve._seed_session_env()

            self.assertEqual(path, data / SESSION_NAME)
            self.assertFalse(path.exists())
            self.assertEqual(
                [(file.read_bytes(), file.stat().st_mode, file.stat().st_ino) for file in old],
                before,
            )
            self.assertEqual(sorted(item.name for item in cwd.iterdir()), sorted(file.name for file in old))
            self.assertEqual(errors.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
