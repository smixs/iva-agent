/* eslint-disable @typescript-eslint/no-floating-promises -- node:test owns the registrations. */
// Сетевые проверки мастера на подменном fetch: какой адрес спрошен, что значит ответ.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  createNetworkChecks,
  modelIds,
  OPENCODE_MODELS,
  telegramUsers,
  type TelegramUpdate,
} from "./network.ts";

const SEED = 20260918;

type Reply = Response | Error;

/** Проверки поверх fetch, который отвечает `reply(url)` и записывает спрошенные адреса. */
function checks(reply: (url: string) => Reply) {
  const urls: string[] = [];
  const printed: string[] = [];
  const fetchFn = ((input: string | URL) => {
    const url = input.toString();
    urls.push(url);
    const answer = reply(url);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  }) as typeof fetch;
  const net = createNetworkChecks({
    fetchFn,
    t: (en) => en,
    print: (...args) => printed.push(args.join(" ")),
  });
  return { net, urls, printed };
}

const status = (code: number) => () => new Response("{}", { status: code });

test("key checks: a working key passes, 401/403 is named, a network failure does not block", async () => {
  for (const name of [
    "opencodeCheck",
    "openrouterKeyCheck",
    "requestyKeyCheck",
    "deepgramCheck",
  ] as const) {
    assert.equal(await checks(status(200)).net[name]("k"), null, name);
    assert.equal(await checks(status(404)).net[name]("k"), null, name);
    assert.match(
      String(await checks(status(401)).net[name]("k")),
      /rejected the key \(401\/403\)/u,
      name,
    );
    assert.match(
      String(await checks(status(403)).net[name]("k")),
      /rejected the key/u,
      name,
    );
    assert.equal(
      await checks(() => new Error("offline")).net[name]("k"),
      null,
      name,
    );
  }
  const { net, urls } = checks(status(200));
  await net.opencodeCheck("k");
  await net.openrouterKeyCheck("k");
  await net.requestyKeyCheck("k");
  await net.deepgramCheck("k");
  assert.deepEqual(urls, [
    "https://opencode.ai/zen/go/v1/models",
    "https://openrouter.ai/api/v1/key",
    "https://router.requesty.ai/v1/models",
    "https://api.deepgram.com/v1/projects",
  ]);
});

test("ollamaModels: sorted ids on success", async () => {
  const { net, urls } = checks(() =>
    Response.json({ data: [{ id: "b" }, { id: "a" }] }),
  );
  assert.deepEqual(await net.ollamaModels("k"), ["a", "b"]);
  assert.deepEqual(urls, ["https://ollama.com/v1/models"]);
  assert.deepEqual(
    await checks(() => Response.json({})).net.ollamaModels("k"),
    [],
  );
});

test("ollamaModels: failure — a refused key is marked auth, any other status names it", async () => {
  await assert.rejects(checks(status(401)).net.ollamaModels("k"), {
    message: "key rejected",
    auth: true,
  });
  await assert.rejects(checks(status(500)).net.ollamaModels("k"), {
    message: "Ollama API returned 500",
  });
});

test("opencodeModels: the live list, else the built-in one", async () => {
  const live = checks(() => Response.json({ data: [{ id: "kimi-k3" }] }));
  assert.deepEqual(await live.net.opencodeModels("k"), ["kimi-k3"]);
  assert.deepEqual(
    await checks(() => Response.json({ data: [] })).net.opencodeModels("k"),
    OPENCODE_MODELS,
  );
  assert.deepEqual(
    await checks(status(500)).net.opencodeModels("k"),
    OPENCODE_MODELS,
  );
  assert.deepEqual(
    await checks(() => new Error("offline")).net.opencodeModels("k"),
    OPENCODE_MODELS,
  );
});

test("openrouterModelCheck: a model that answers passes, an empty answer is noted", async () => {
  const answered = checks(() =>
    Response.json({ choices: [{ message: { content: "pong" } }] }),
  );
  assert.equal(await answered.net.openrouterModelCheck("k", "a/b"), null);
  assert.deepEqual(answered.urls, [
    "https://openrouter.ai/api/v1/chat/completions",
  ]);
  assert.deepEqual(answered.printed, []);

  const empty = checks(() => Response.json({ choices: [{ message: {} }] }));
  assert.equal(await empty.net.openrouterModelCheck("k", "a/b"), null);
  assert.match(empty.printed.join("\n"), /model replied empty/u);
});

test("openrouterModelCheck: failure — refusals name the reason and the hint", async () => {
  const noTools = checks(
    () =>
      new Response(
        JSON.stringify({
          error: { message: "No endpoints found that support tool use" },
        }),
        { status: 404 },
      ),
  );
  assert.match(
    String(await noTools.net.openrouterModelCheck("k", "a/b")),
    /^the model can't be used: .*tool use.*Iva needs a chat model with tool\/function calling/u,
  );

  const badSlug = checks(
    () =>
      new Response(
        JSON.stringify({ error: { message: "not a valid model id" } }),
        { status: 400 },
      ),
  );
  assert.match(
    String(await badSlug.net.openrouterModelCheck("k", "nope")),
    /^the model can't be used: .*pick another model/u,
  );

  const offline = checks(() => new Error("socket hang up"));
  assert.match(
    String(await offline.net.openrouterModelCheck("k", "a/b")),
    /^request failed: /u,
  );
});

test("requestyModelCheck: an answer passes, refusals point to the Requesty model list", async () => {
  const answered = checks(() =>
    Response.json({ choices: [{ message: { tool_calls: [{ id: "1" }] } }] }),
  );
  assert.equal(await answered.net.requestyModelCheck("k", "gpt-5.5"), null);
  assert.deepEqual(answered.urls, [
    "https://router.requesty.ai/v1/chat/completions",
  ]);
  assert.deepEqual(answered.printed, []);

  const empty = checks(() => Response.json({ choices: [{ message: {} }] }));
  assert.equal(await empty.net.requestyModelCheck("k", "gpt-5.5"), null);
  assert.match(empty.printed.join("\n"), /model replied empty/u);

  const unknown = checks(
    () =>
      new Response(
        JSON.stringify({
          error: { origin: "router", message: "no such model" },
        }),
        { status: 404 },
      ),
  );
  assert.match(
    String(await unknown.net.requestyModelCheck("k", "openai/nope")),
    /^the model can't be used: .*no such model.*requesty\.ai\/models/u,
  );

  const offline = checks(() => new Error("socket hang up"));
  assert.match(
    String(await offline.net.requestyModelCheck("k", "gpt-5.5")),
    /^request failed: /u,
  );
});

test("telegramGetMe: the bot on success, the reason on refusal", async () => {
  const ok = checks(() =>
    Response.json({ ok: true, result: { username: "ivabot" } }),
  );
  assert.deepEqual(await ok.net.telegramGetMe("123:t"), { username: "ivabot" });
  assert.deepEqual(ok.urls, ["https://api.telegram.org/bot123:t/getMe"]);
  await assert.rejects(
    checks(() =>
      Response.json({ ok: false, description: "Unauthorized" }),
    ).net.telegramGetMe("x"),
    { message: "Unauthorized" },
  );
  await assert.rejects(
    checks(() => Response.json({ ok: false })).net.telegramGetMe("x"),
    { message: "token rejected" },
  );
});

test("fetchTelegramUserIds: who wrote to the bot, once per id", async () => {
  const { net, urls } = checks(() =>
    Response.json({
      ok: true,
      result: [
        { message: { from: { id: 7, first_name: "Ann", username: "ann" } } },
        { edited_message: { from: { id: 8 } } },
        { message: { from: { id: 7, first_name: "Other" } } },
        { callback_query: {} },
      ],
    }),
  );
  assert.deepEqual(await net.fetchTelegramUserIds("123:t"), [
    { id: "7", name: "Ann @ann" },
    { id: "8", name: "(no name)" },
  ]);
  assert.deepEqual(urls, ["https://api.telegram.org/bot123:t/getUpdates"]);
});

test("fetchTelegramUserIds: failure — a refused request names its reason", async () => {
  await assert.rejects(
    checks(() =>
      Response.json({ ok: false, description: "Conflict: webhook is active" }),
    ).net.fetchTelegramUserIds("x"),
    { message: "Conflict: webhook is active" },
  );
  await assert.rejects(
    checks(() => Response.json({ ok: false })).net.fetchTelegramUserIds("x"),
    { message: "getUpdates failed" },
  );
  assert.deepEqual(
    await checks(() => Response.json({ ok: true })).net.fetchTelegramUserIds(
      "x",
    ),
    [],
  );
});

test("modelIds tolerates a body without data", () => {
  assert.deepEqual(modelIds({}), []);
});

const sender = fc.record(
  {
    id: fc.oneof(fc.integer(), fc.string({ maxLength: 4 })),
    first_name: fc.string(),
    last_name: fc.string(),
    username: fc.string(),
  },
  { requiredKeys: ["id"] },
);
const update: fc.Arbitrary<TelegramUpdate> = fc.record(
  {
    message: fc.record({ from: sender }, { requiredKeys: [] }),
    edited_message: fc.record({ from: sender }, { requiredKeys: [] }),
  },
  { requiredKeys: [] },
);

test(`telegramUsers: one entry per sender id, in order of first message, never throws (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.array(update, { maxLength: 30 }), (updates) => {
      const users = telegramUsers(updates, "(no name)");
      const ids = users.map((u) => u.id);
      const senders = updates
        .map((u) => (u.message || u.edited_message)?.from)
        .filter((from) => from !== undefined)
        .map((from) => String(from.id));
      assert.deepEqual(ids, [...new Set(senders)]);
      for (const user of users) assert.ok(user.name.length > 0);
    }),
    { seed: SEED, numRuns: 300 },
  );
  assert.deepEqual(telegramUsers(undefined, "-"), []);
});
