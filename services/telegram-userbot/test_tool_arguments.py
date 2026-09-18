import asyncio
import json
import unittest

from serve import NormalizeToolArgumentsMiddleware, _normalize_tool_arguments


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

    def test_asgi_middleware_reinjects_a_normalized_body(self):
        """Deliver a normalized tools/call body and the original disconnect event."""
        payload = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "list_messages",
                    "arguments": {
                        "chat_id": "@example",
                        "limit": 1,
                        "account": None,
                    },
                },
            }
        ).encode()

        async def exercise():
            """Run the middleware against chunked ASGI input and capture its output."""
            events = [
                {"type": "http.request", "body": payload[:20], "more_body": True},
                {"type": "http.request", "body": payload[20:], "more_body": False},
                {"type": "http.disconnect"},
            ]
            captured = []
            sent = []

            async def receive():
                """Yield the next incoming ASGI event."""
                return events.pop(0)

            async def send(message):
                """Record outgoing ASGI events from the downstream application."""
                sent.append(message)

            async def downstream(scope, receive, send):
                """Capture the normalized request and its following disconnect event."""
                captured.extend([await receive(), await receive()])
                await send({"type": "http.response.start", "status": 204, "headers": []})
                await send({"type": "http.response.body", "body": b""})

            await NormalizeToolArgumentsMiddleware(downstream)(
                {"type": "http", "method": "POST"}, receive, send
            )
            return captured, sent

        captured, sent = asyncio.run(exercise())

        self.assertEqual(captured[1], {"type": "http.disconnect"})
        self.assertEqual(
            json.loads(captured[0]["body"])["params"]["arguments"],
            {"chat_id": "@example", "limit": 1},
        )
        self.assertEqual(sent[0]["status"], 204)


if __name__ == "__main__":
    unittest.main()
