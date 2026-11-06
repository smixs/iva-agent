"""Run the production proxy with Telethon network methods replaced, for local HTTP tests."""
import sys
from pathlib import Path
from unittest.mock import patch

from telethon import TelegramClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import serve
import guardrails
import onboarding

install_guardrails = guardrails.install_guardrails
register_onboarding_tools = onboarding.register_onboarding_tools


def guard(client):
    install_guardrails(client)
    print(f"TEST guarded {Path(client.session.filename).name}", file=sys.stderr)


def onboard(mcp, client):
    assert Path(client.session.filename).name == "telegram-userbot.session"
    register_onboarding_tools(mcp, client)


async def connect(client):
    print(f"TEST connected {Path(client.session.filename).name}", file=sys.stderr)


async def authorized(client):
    return False


async def get_me(client):
    return None


with patch.object(TelegramClient, "connect", connect), \
     patch.object(TelegramClient, "is_connected", lambda client: False), \
     patch.object(TelegramClient, "is_user_authorized", authorized), \
     patch.object(TelegramClient, "get_me", get_me), \
     patch.object(guardrails, "install_guardrails", guard), \
     patch.object(onboarding, "register_onboarding_tools", onboard), \
     patch("dotenv.load_dotenv"):
    serve.main()
