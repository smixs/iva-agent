"""Local MCP fixture: real FastMCP transport, no Telegram or owner data."""
import asyncio
import json
import socket
import sys
from pathlib import Path

import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tool_contracts import install_tool_contracts


class Nested(BaseModel):
    required: str
    nullable: str | None


async def main():
    mcp = FastMCP("contract-test", json_response="--json" in sys.argv)
    mcp.settings.transport_security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
    calls = []

    def account_lookup(account):
        # Upstream get_client with one session: None is that session.
        if account is not None and account.lower() != "default":
            raise ValueError(f"Unknown account '{account}'. Available accounts: default")

    @mcp.tool()
    def list_messages(chat_id: str, limit: int = 20, search_query: str = None,
                      from_date: str = None, to_date: str = None, account: str = None) -> str:
        args = {key: value for key, value in locals().items() if key != "calls"}
        calls.append(args)
        return json.dumps(args)

    @mcp.tool()
    def probe(required: str, nested: Nested, required_nullable: str | None,
              value: str = None, count: int = None, flag: bool = None,
              rights: dict = None, values: list[str] | None = None,
              with_about: bool = False) -> str:
        args = {key: value for key, value in locals().items() if key != "calls"}
        args["nested"] = nested.model_dump()
        calls.append(args)
        return json.dumps(args)

    @mcp.tool()
    def inspect_calls() -> int:
        return len(calls)

    await install_tool_contracts(mcp, {"list_messages": list_messages, "probe": probe}, account_lookup)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(mcp.streamable_http_app(), log_level="error", lifespan="on"))

    async def announce():
        while not server.started:
            await asyncio.sleep(0.01)
        print(f"http://127.0.0.1:{port}/mcp", flush=True)

    await asyncio.gather(server.serve(sockets=[listener]), announce())


if __name__ == "__main__":
    asyncio.run(main())
