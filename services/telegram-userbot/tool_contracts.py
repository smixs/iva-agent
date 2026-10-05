"""Repair the pinned Telegram tool source contract through public registration APIs.

Remove the nullable-signature repair when telegram-mcp declares its optional None
defaults as nullable types. Remove account preflight when its handlers expose
Unknown account errors directly. The upstream boundary tests detect those changes.
No JSON Schema default is interpreted as permission to accept null.
Tracking: https://github.com/smixs/iva-agent/issues/271 and /issues/248.

Arguments a model gets wrong in a known way are adapted after FastMCP validation,
only in the fields they belong to: "null" text in an optional field, an account
label invented for a one-session proxy, a public t.me link in an id field
(issues 248 and 281). Message text and search queries keep their links.
"""
import inspect
import re
from functools import wraps

# The parameters upstream's @validate_id accepts as an integer id or a username.
ENTITY_FIELDS = frozenset({
    "allow_users", "channel", "chat_id", "contact_id", "disallow_users",
    "from_chat_id", "group_id", "to_chat_id", "user_id", "user_ids",
})
# A model that cannot send null writes it as text; in an optional field it is not a value.
NULL_TEXTS = ("null", '"null"')
# t.me/<name>, t.me/s/<name> and links to its posts; invite and t.me/c/ links do not match.
PUBLIC_LINK = re.compile(
    r"(?:https?://)?(?:www\.)?(?:t|telegram)\.me/(?:s/)?@?([a-z][a-z0-9_]{4,})(?:/\d+){0,2}/?(?:\?\S*)?",
    re.IGNORECASE,
)
# t.me paths that open a Telegram service, never a chat.
SERVICE_PATHS = frozenset({
    "addemoji", "addlist", "addstickers", "addtheme", "boost", "confirmphone", "contact",
    "giftcode", "invoice", "joinchat", "login", "proxy", "setlanguage", "share", "socks",
})


async def install_tool_contracts(mcp, functions, account_lookup):
    """Keep the same server/client and re-register only exposed Telegram functions.

    The userbot formerly omitted every top-level null before FastMCP validation.
    Instead fix plain optional source annotations with a None default: calling the
    Python function with that None is identical to its default. Required fields,
    nested models, already-nullable annotations and return types are untouched.
    """
    nullable = {}
    accounts = []
    primitive_types = {str: "string", int: "integer", bool: "boolean", dict: "object"}
    for tool in await mcp.list_tools():
        fn = functions.get(tool.name)
        if not callable(fn):
            continue
        signature = inspect.signature(fn, eval_str=True)
        properties = tool.inputSchema.get("properties", {})
        required = tool.inputSchema.get("required", [])
        fields = [
            parameter.name
            for parameter in signature.parameters.values()
            if parameter.default is None
            and parameter.annotation in primitive_types
            and parameter.name not in required
            and properties.get(parameter.name, {}).get("type")
            == primitive_types[parameter.annotation]
        ]
        optional = [
            parameter.name
            for parameter in signature.parameters.values()
            if parameter.default is None and parameter.name in properties
        ]
        entities = [name for name in signature.parameters if name in ENTITY_FIELDS and name in properties]
        check_account = "account" in signature.parameters and "account" in properties
        if not optional and not entities and not check_account:
            continue
        repaired = signature.replace(parameters=[
            parameter.replace(annotation=parameter.annotation | None)
            if parameter.name in fields else parameter
            for parameter in signature.parameters.values()
        ])
        wrapped = _contract_function(fn, repaired, account_lookup, check_account, optional, entities)
        mcp.remove_tool(tool.name)
        mcp.add_tool(
            wrapped,
            name=tool.name,
            title=tool.title,
            description=tool.description,
            annotations=tool.annotations,
            icons=tool.icons,
            meta=tool.meta,
            structured_output=tool.outputSchema is not None,
        )
        if fields:
            nullable[tool.name] = fields
        if check_account:
            accounts.append(tool.name)
    return {"nullable": nullable, "accounts": accounts}


def _contract_function(fn, signature, account_lookup, check_account, optional, entities):
    """Preserve the function's guards, context injection and output conversion."""
    @wraps(fn)
    async def call(*args, **kwargs):
        for name in optional:
            if isinstance(kwargs.get(name), str) and kwargs[name] in NULL_TEXTS:
                kwargs[name] = None
        for name in entities:
            if name in kwargs:
                kwargs[name] = _entity(kwargs[name])
        if check_account and kwargs.get("account") is not None:
            kwargs["account"] = _known_account(kwargs["account"], account_lookup)
        result = fn(*args, **kwargs)
        return await result if inspect.isawaitable(result) else result

    call.__signature__ = signature
    call.__annotations__ = {
        parameter.name: parameter.annotation
        for parameter in signature.parameters.values()
    }
    call.__annotations__["return"] = signature.return_annotation
    return call


def _known_account(account, account_lookup):
    """Keep a configured account; with one session, an invented label means that session.

    A supported lookup of the existing client, never another session. With several
    accounts let FastMCP return its normal isError result before the handler masks
    Unknown account as GEN-ERR. None preserves upstream read-only fanout, and the
    lookup resolves None only when exactly one account exists.
    """
    try:
        account_lookup(account)
    except ValueError as unknown:
        try:
            account_lookup(None)
        except ValueError:
            raise unknown from None
        return None
    return account


def _entity(value):
    """Name the chat of a public t.me link as @name, the form upstream accepts."""
    if isinstance(value, list):
        return [_entity(item) for item in value]
    if isinstance(value, str):
        match = PUBLIC_LINK.fullmatch(value.strip())
        if match and match.group(1).lower() not in SERVICE_PATHS:
            return "@" + match.group(1)
    return value
