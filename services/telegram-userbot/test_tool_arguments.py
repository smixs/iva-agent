import inspect
import os
import random
import re
import tempfile
import time
import unittest
from pathlib import Path
from typing import Union
from unittest.mock import patch

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from pydantic import BaseModel

from tool_contracts import ENTITY_FIELDS, SERVICE_PATHS, install_tool_contracts


class Nested(BaseModel):
    required: str
    nullable: str | None


def accounts(*labels, lookups=None):
    """Model upstream get_client: None resolves only when exactly one account exists."""
    def lookup(account):
        if lookups is not None:
            lookups.append(account)
        if account is None:
            if len(labels) != 1:
                raise ValueError(f"Account is required. Available accounts: {', '.join(labels)}")
        elif account.lower() not in labels:
            raise ValueError(f"Unknown account '{account}'. Available accounts: {', '.join(labels)}")
    return lookup


class FakeClient:
    """Stands in for the one Telethon client and records that a handler reached it."""
    def __init__(self):
        self.reached = []

    def __getattr__(self, name):
        self.reached.append(name)
        raise RuntimeError("fake client: no Telegram in tests")


USERNAME = re.compile(r"^@[a-zA-Z0-9_]{5,}$")  # upstream validate_id, with the @


class ToolContractsTest(unittest.IsolatedAsyncioTestCase):
    async def test_source_semantics_do_not_infer_nullability_from_schema_default(self):
        mcp = FastMCP("test")

        @mcp.tool()
        def source(required: str, nested: Nested, nullable: str | None,
                   value: str = None, count: int = None, flag: bool = None,
                   rights: dict = None, values: list[str] | None = None,
                   with_about: bool = False) -> str:
            return repr((required, nested, nullable, value, count, flag, rights, values, with_about))

        @mcp.tool()
        def unrelated(value: str = None) -> str:
            return "unrelated"

        before = {tool.name: tool for tool in await mcp.list_tools()}
        changed = await install_tool_contracts(mcp, {"source": source}, lambda _: None)
        after = {tool.name: tool for tool in await mcp.list_tools()}
        self.assertEqual(changed["nullable"], {"source": ["value", "count", "flag", "rights"]})
        self.assertEqual(before["unrelated"], after["unrelated"])
        expected = before["source"].model_dump()
        for name in changed["nullable"]["source"]:
            expected["inputSchema"]["properties"][name] = after["source"].inputSchema["properties"][name]
        self.assertEqual(expected, after["source"].model_dump())
        self.assertIs(inspect.signature(source).parameters["value"].annotation, str)
        accepted = {"required": "yes", "nested": {"required": "yes", "nullable": None}, "nullable": None}
        await mcp.call_tool("source", {**accepted, "value": None, "count": None, "flag": None, "rights": None})
        for invalid in ({**accepted, "required": None}, {**accepted, "nested": {"required": None, "nullable": None}}, {**accepted, "value": 9}):
            with self.assertRaises(ToolError):
                await mcp.call_tool("source", invalid)

    async def test_known_account_preflight_keeps_omission_and_fanout(self):
        mcp = FastMCP("test")
        calls = []
        lookups = []

        @mcp.tool()
        async def source(account: str = None) -> str:
            calls.append(account)
            return "fanout" if account is None else account

        await install_tool_contracts(mcp, {"source": source}, accounts("first", "second", lookups=lookups))
        await mcp.call_tool("source", {})
        await mcp.call_tool("source", {"account": None})
        await mcp.call_tool("source", {"account": "SECOND"})
        with self.assertRaisesRegex(ToolError, "Unknown account 'main'. Available accounts: first, second"):
            await mcp.call_tool("source", {"account": "main"})
        self.assertEqual(calls, [None, None, "SECOND"])
        self.assertEqual(lookups, ["SECOND", "main", None])

    async def test_one_session_drops_an_invented_account_and_null_text(self):
        """Issue 248: "main" or '"null"' on a one-account proxy reaches that account."""
        mcp = FastMCP("test")
        calls = []
        lookups = []

        @mcp.tool()
        async def source(chat_id: str, account: str = None) -> str:
            calls.append(account)
            return "ok"

        await install_tool_contracts(mcp, {"source": source}, accounts("default", lookups=lookups))
        for account in ("main", '"null"', "null", "", "DEFAULT"):
            await mcp.call_tool("source", {"chat_id": "@example", "account": account})
        self.assertEqual(calls, [None, None, None, None, "DEFAULT"])
        self.assertEqual(lookups, ["main", None, "", None, "DEFAULT"])

    async def test_null_text_and_public_links_change_only_their_own_fields(self):
        """Issue 281: "null" text omits an optional field; a t.me link in an id field is @name."""
        mcp = FastMCP("test")
        calls = []

        @mcp.tool()
        def source(chat_id: Union[int, str], message: str = "", search_query: str = None,
                   to_date: str = None, user_ids: list[Union[int, str]] | None = None) -> str:
            calls.append({"chat_id": chat_id, "message": message, "search_query": search_query,
                          "to_date": to_date, "user_ids": user_ids})
            return "ok"

        await install_tool_contracts(mcp, {"source": source}, accounts("default"))

        async def call(**arguments):
            await mcp.call_tool("source", arguments)
            return calls[-1]

        received = await call(chat_id="@example", message="null", search_query="null", to_date='"null"')
        self.assertEqual(received, {"chat_id": "@example", "message": "null", "search_query": None,
                                    "to_date": None, "user_ids": None})
        link = "https://t.me/example_news"
        received = await call(chat_id=-1001234567890, message=link, search_query=link,
                              user_ids=["t.me/first_user", 42, "@second_user"])
        self.assertEqual(received["message"], link)
        self.assertEqual(received["search_query"], link)
        self.assertEqual(received["user_ids"], ["@first_user", 42, "@second_user"])
        self.assertEqual(received["chat_id"], -1001234567890)
        cases = {
            "https://t.me/soldat_udachi": "@soldat_udachi",
            "t.me/dyadyaslava/123": "@dyadyaslava",
            "http://telegram.me/example_news/?single": "@example_news",
            "https://t.me/s/durov_news": "@durov_news",
            " HTTPS://T.ME/Example_News/12/345?comment=1 ": "@Example_News",
            "https://t.me/@example_news": "@example_news",
            "@x": "@x",
            "@example_news": "@example_news",
            "https://t.me/x": "https://t.me/x",
            "t.me/x/123": "t.me/x/123",
            "https://t.me/+AbCdEf123": "https://t.me/+AbCdEf123",
            "https://t.me/c/1234567/89": "https://t.me/c/1234567/89",
            "https://t.me/joinchat/123456": "https://t.me/joinchat/123456",
            "https://t.me/proxy?server=1.2.3.4&port=443": "https://t.me/proxy?server=1.2.3.4&port=443",
            "https://t.me/example_news/post": "https://t.me/example_news/post",
            "https://evil.example/t.me/example_news": "https://evil.example/t.me/example_news",
            "https://t.me.evil.example/example_news": "https://t.me.evil.example/example_news",
            "https://t.me/12345678": "https://t.me/12345678",
        }
        for link, expected in cases.items():
            with self.subTest(link=link):
                self.assertEqual((await call(chat_id=link))["chat_id"], expected)
        # FastMCP reads "null" in a non-string field as JSON null: a required id is refused.
        with self.assertRaisesRegex(ToolError, "chat_id"):
            await call(chat_id="null")

    async def test_random_arguments_keep_every_real_value(self):
        """Property: a link becomes @name only when built as a public t.me link; nothing else changes."""
        seed = int(os.environ.get("SEED", random.randrange(2**32)))
        rng = random.Random(seed)
        mcp = FastMCP("test")
        calls = []

        @mcp.tool()
        def source(chat_id: Union[int, str], message: str = "", search_query: str = None,
                   account: str = None) -> str:
            calls.append({"chat_id": chat_id, "message": message, "search_query": search_query,
                          "account": account})
            return "ok"

        await install_tool_contracts(mcp, {"source": source}, accounts("default"))
        letters = "abcdefXYZ"
        word = letters + "0189_"

        def part(valid, invalid):
            """Pick a link part and remember whether it keeps the link public."""
            return (rng.choice(valid), True) if rng.random() < 0.8 else (rng.choice(invalid), False)

        def link():
            """A t.me-shaped string and the chat id it names; an unchanged string names none."""
            if rng.random() < 0.7:
                name = rng.choice(letters) + "".join(rng.choice(word) for _ in range(rng.randint(4, 10)))
            else:
                name = "".join(rng.choice(word + "-.+") for _ in range(rng.randint(0, 6)))
            # Telegram's username rule, not the adapter's pattern: letter first, 5+ characters.
            public = re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{4,}", name) and name.lower() not in SERVICE_PATHS
            parts = [
                part(["", " ", "https://", "http://", "HTTPS://", "www.", "https://www."], ["tg://", "ftp://", "x"]),
                part(["t.me/", "telegram.me/", "T.ME/"], ["", "t.me.evil.example/", "x.t.me/", "tme/"]),
                part(["", "s/", "@"], ["+", "c/", "joinchat/", "share?url="]),
                (name, bool(public)),
                part(["", "/", "/123", "/12/345", "/12/345/"], ["/abc", "/1/2/3", "/-1"]),
                part(["", "?single", "?comment=5", "?", " "], ["?a b", "#top"]),
            ]
            value = "".join(item for item, _ in parts)
            return value, "@" + name if all(valid for _, valid in parts) else value

        def text():
            if rng.random() < 0.3:
                return rng.choice(["null", '"null"', "", "main", "default", "DEFAULT", "@user_name", "NULL"])
            return link()[0]

        rewrites = 0
        for _ in range(400):
            chat_id, expected = link() if rng.random() < 0.7 else rng.choice([(-1001234567890,) * 2, ("@x",) * 2])
            arguments = {"chat_id": chat_id, "message": text(), "search_query": text(), "account": text()}
            arguments = {key: value for key, value in arguments.items() if rng.random() < 0.85 or key == "chat_id"}
            await mcp.call_tool("source", arguments)
            received = calls[-1]
            context = f"SEED={seed} {arguments!r} -> {received!r}"
            self.assertEqual(received["chat_id"], expected, context)
            if expected != chat_id:
                rewrites += 1
                self.assertRegex(expected, USERNAME, context)
            self.assertEqual(received["message"], arguments.get("message", ""), context)
            query = arguments.get("search_query")
            self.assertEqual(received["search_query"], None if query in ("null", '"null"') else query, context)
            account = arguments.get("account")
            self.assertEqual(received["account"], account if account and account.lower() == "default" else None, context)
        self.assertGreater(rewrites, 20, f"SEED={seed}: the generator stopped building public links")

    async def test_pinned_upstream_contract_metadata_pruning_and_account_error(self):
        # No real Telegram network, login or owner session. The upstream module
        # constructs its one client against a fresh temporary SQLite session.
        old_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as temporary:
            os.chdir(temporary)
            try:
                with patch.dict(os.environ, {
                    "TELEGRAM_API_ID": "12345", "TELEGRAM_API_HASH": "0" * 32,
                    "TELEGRAM_SESSION_NAME": str(Path(temporary) / "session"),
                    "TELEGRAM_EXPOSED_TOOLS": "read-only",
                }):
                    import telegram_mcp.runtime as runtime
                    import telegram_mcp.tools as source
                    before = {tool.name: tool for tool in await runtime.mcp.list_tools()}
                    self.assertEqual(len(before), 116)
                    self.assertEqual(before["list_messages"].inputSchema["properties"]["account"]["type"], "string")
                    removed = runtime._apply_exposed_tools_mode(runtime.mcp)
                    exposed = {tool.name: tool for tool in await runtime.mcp.list_tools()}
                    with patch.dict(runtime.clients, {"default": object()}, clear=True):
                        masked = await runtime.mcp.call_tool("list_messages", {"chat_id": "@example", "account": "main"})
                        refused = await runtime.mcp.call_tool("list_messages", {"chat_id": "https://t.me/example_news"})
                    self.assertIn("GEN-ERR-", str(masked))
                    self.assertNotIn("Unknown account", str(masked))
                    self.assertIn("Invalid chat_id", str(refused))
                    started = time.perf_counter()
                    changed = await install_tool_contracts(runtime.mcp, vars(source), runtime.get_client)
                    duration = time.perf_counter() - started
                    after = {tool.name: tool for tool in await runtime.mcp.list_tools()}
                    self.assertEqual(set(exposed), set(after))
                    self.assertTrue(set(removed).isdisjoint(after))
                    for name, descriptor in exposed.items():
                        expected = descriptor.model_dump()
                        for field in changed["nullable"].get(name, []):
                            expected["inputSchema"]["properties"][field] = after[name].inputSchema["properties"][field]
                        self.assertEqual(expected, after[name].model_dump(), name)
                    for field in ("account", "from_date", "to_date", "search_query"):
                        self.assertIn({"type": "null"}, after["list_messages"].inputSchema["properties"][field]["anyOf"])
                    with patch.dict(runtime.clients, {"default": object(), "second": object()}, clear=True):
                        with self.assertRaisesRegex(ToolError, "Unknown account 'main'. Available accounts: default, second"):
                            await runtime.mcp.call_tool("list_messages", {"chat_id": "@example", "account": "main"})
                    # One session: an invented account and a public link both reach the client,
                    # which upstream alone answered with Unknown account and Invalid chat_id.
                    client = FakeClient()
                    with patch.dict(runtime.clients, {"default": client}, clear=True):
                        reached = await runtime.mcp.call_tool("list_messages", {
                            "chat_id": "https://t.me/example_news/42", "account": '"null"', "search_query": "null",
                        })
                        self.assertNotIn("Invalid chat_id", str(reached))
                        self.assertEqual(client.reached, ["is_connected"])
                        reached = await runtime.mcp.call_tool("list_messages", {"chat_id": "@example", "account": "main"})
                        self.assertNotIn("Unknown account", str(reached))
                        self.assertEqual(client.reached, ["is_connected", "is_connected"])
                    validated = set()
                    for function in vars(source).values():
                        while callable(function) and hasattr(function, "__code__"):
                            validated |= set(inspect.getclosurevars(function).nonlocals.get("param_names_to_validate", ()))
                            function = getattr(function, "__wrapped__", None)
                    self.assertEqual(validated, ENTITY_FIELDS)
                    print(f"read-only source adapter: {len(changed['nullable'])} nullable tools, {len(changed['accounts'])} account preflights, {duration * 1000:.1f} ms")
            finally:
                os.chdir(old_cwd)


if __name__ == "__main__":
    unittest.main()
