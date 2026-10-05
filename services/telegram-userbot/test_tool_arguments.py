import asyncio
import json
import os
import random
import unittest

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from serve import NormalizeToolArgumentsMiddleware, _normalize_tool_arguments


def _call_arguments(arguments):
    """Normalize a tools/call request and return the arguments that reach the tool."""
    body = json.dumps({"method": "tools/call", "params": {"name": "t", "arguments": arguments}})
    return json.loads(_normalize_tool_arguments(body.encode()))["params"]["arguments"]


class NormalizeToolArgumentsTest(unittest.TestCase):
    """Cover JSON normalization and the ASGI request-body boundary."""

    def test_omits_null_optional_arguments_from_a_tool_call(self):
        """Keep populated tool arguments and omit nullable optional arguments."""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "list_messages",
                "arguments": {
                    "chat_id": "@example",
                    "limit": 100,
                    "search_query": None,
                    "from_date": None,
                    "to_date": None,
                    "account": None,
                },
            },
        }

        normalized = json.loads(_normalize_tool_arguments(json.dumps(payload).encode()))

        self.assertEqual(
            normalized["params"]["arguments"],
            {"chat_id": "@example", "limit": 100},
        )

    def test_preserves_non_tool_requests_and_invalid_json(self):
        """Preserve requests that the middleware does not own."""
        initialize = b'{"method":"initialize","params":{"clientInfo":null}}'

        self.assertEqual(_normalize_tool_arguments(initialize), initialize)
        self.assertEqual(_normalize_tool_arguments(b"not json"), b"not json")

    def test_drops_account_and_literal_null_strings(self):
        """One session owns this proxy: an invented account or a "null" string never reaches it."""
        normalized = _call_arguments(
            {"chat_id": "@example", "account": "main", "search_query": "null", "to_date": '"null"'}
        )

        self.assertEqual(normalized, {"chat_id": "@example"})

    def test_rewrites_public_tme_links_to_usernames(self):
        """Upstream accepts ids and usernames only; a pasted channel link becomes @name."""
        cases = {
            "https://t.me/soldat_udachi": "@soldat_udachi",
            "t.me/dyadyaslava/123": "@dyadyaslava",
            "http://telegram.me/example_channel/?single": "@example_channel",
            "https://t.me/+AbCdEf123": "https://t.me/+AbCdEf123",
            "https://t.me/c/1234567/89": "https://t.me/c/1234567/89",
        }
        for link, expected in cases.items():
            with self.subTest(link=link):
                self.assertEqual(_call_arguments({"chat_id": link}), {"chat_id": expected})

    def test_random_arguments_keep_every_real_value(self):
        """Property: only nulls and account vanish; non-link values pass through unchanged."""
        seed = int(os.environ.get("SEED", random.randrange(2**32)))
        rng = random.Random(seed)
        pool = [None, "null", '"null"', "", "main", "@user_name", 0, -1001234567890, True, [1, 2], {"a": None}]
        for _ in range(500):
            keys = rng.sample(["chat_id", "limit", "search_query", "from_date", "account", "x"], rng.randint(0, 6))
            arguments = {key: rng.choice(pool) for key in keys}
            expected = {
                key: value
                for key, value in arguments.items()
                if key != "account" and value not in (None, "null", '"null"')
            }
            self.assertEqual(_call_arguments(arguments), expected, f"SEED={seed} {arguments!r}")

    def test_asgi_middleware_reaches_a_real_fastmcp_tool(self):
        """Deliver a null optional argument to FastMCP as an omitted argument."""
        async def exercise():
            """Call the production FastMCP HTTP app through the middleware stack."""
            received = []
            mcp = FastMCP("test")
            mcp.settings.transport_security = TransportSecuritySettings(
                enable_dns_rebinding_protection=False
            )

            @mcp.tool()
            def optional_argument(value: str = None):
                """Record the value that FastMCP passes to the tool handler."""
                received.append(value)
                return "called"

            app = mcp.streamable_http_app()
            app.add_middleware(NormalizeToolArgumentsMiddleware)
            headers = {
                "accept": "application/json, text/event-stream",
                "content-type": "application/json",
            }
            initialize = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            }
            call = {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "optional_argument", "arguments": {"value": None}},
            }
            async with app.router.lifespan_context(app):
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(
                    transport=transport, base_url="http://test"
                ) as client:
                    initialized = await client.post(
                        "/mcp", headers=headers, content=json.dumps(initialize)
                    )
                    self.assertEqual(initialized.status_code, 200)
                    headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
                    ready = await client.post(
                        "/mcp",
                        headers=headers,
                        content=json.dumps(
                            {"jsonrpc": "2.0", "method": "notifications/initialized"}
                        ),
                    )
                    self.assertEqual(ready.status_code, 202)
                    response = await client.post(
                        "/mcp", headers=headers, content=json.dumps(call)
                    )
            return response, received

        response, received = asyncio.run(exercise())

        self.assertEqual(response.status_code, 200)
        self.assertIn('"isError":false', response.text)
        self.assertEqual(received, [None])


if __name__ == "__main__":
    unittest.main()
