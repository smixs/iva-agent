import json
import unittest

from serve import _normalize_tool_arguments


class NormalizeToolArgumentsTest(unittest.TestCase):
    def test_omits_null_optional_arguments_from_a_tool_call(self):
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
        initialize = b'{"method":"initialize","params":{"clientInfo":null}}'

        self.assertEqual(_normalize_tool_arguments(initialize), initialize)
        self.assertEqual(_normalize_tool_arguments(b"not json"), b"not json")


if __name__ == "__main__":
    unittest.main()
