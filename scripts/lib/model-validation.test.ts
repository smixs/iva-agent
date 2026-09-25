import assert from "node:assert/strict";
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */
import { test } from "node:test";
import { ClaudeCliError } from "./claude-cli-status.ts";
import {
  ModelValidationError,
  validateModelSelection,
} from "./model-validation.ts";

const response = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("catalog providers require exact live membership", async () => {
  for (const provider of ["ollama", "opencode"]) {
    const selected = await validateModelSelection(
      { provider, model: "live/model", key: "secret" },
      {
        fetchFn: async () => response({ data: [{ id: "live/model" }] }),
      },
    );
    assert.equal(selected.id, "live/model");
    await assert.rejects(
      validateModelSelection(
        { provider, model: "retired", key: "secret" },
        { fetchFn: async () => response({ data: [{ id: "live/model" }] }) },
      ),
      (error) =>
        error instanceof ModelValidationError &&
        error.code === "model_unavailable",
    );
  }

  await assert.rejects(
    validateModelSelection(
      { provider: "codex", model: "retired" },
      {
        listCodexCatalog: async () => [
          { id: "live", reasoningLevels: ["high"] },
        ],
      },
    ),
    (error) =>
      error instanceof ModelValidationError &&
      error.code === "model_unavailable",
  );
});

test("catalog outage, auth, empty and malformed responses fail closed", async () => {
  const cases = [
    {
      code: "catalog_unavailable",
      fetchFn: async () => {
        throw new Error("offline");
      },
    },
    { code: "auth_rejected", fetchFn: async () => response({}, 401) },
    { code: "auth_rejected", fetchFn: async () => response({}, 403) },
    { code: "catalog_invalid", fetchFn: async () => response({ data: [] }) },
    {
      code: "catalog_invalid",
      fetchFn: async () => response({ data: "broken" }),
    },
    {
      code: "catalog_invalid",
      fetchFn: async () => response({ data: [{ name: "missing-id" }] }),
    },
    { code: "catalog_invalid", fetchFn: async () => response("{", 200) },
  ];
  for (const item of cases) {
    await assert.rejects(
      validateModelSelection(
        { provider: "ollama", model: "live", key: "secret" },
        { fetchFn: item.fetchFn },
      ),
      (error) =>
        error instanceof ModelValidationError && error.code === item.code,
    );
  }
  await assert.rejects(
    validateModelSelection(
      { provider: "codex", model: "live" },
      { listCodexCatalog: async () => [] },
    ),
    (error) =>
      error instanceof ModelValidationError && error.code === "catalog_invalid",
  );
});

test("OpenRouter validation sends a minimal tool-call request", async () => {
  let request:
    { url: string | URL | Request; body: Record<string, unknown> } | undefined;
  const result = await validateModelSelection(
    { provider: "openrouter", model: "vendor/model", key: "secret" },
    {
      fetchFn: async (url, init) => {
        const requestUrl =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        const requestBody = typeof init?.body === "string" ? init.body : "";
        request = {
          url: requestUrl,
          body: JSON.parse(requestBody) as Record<string, unknown>,
        };
        return response({
          choices: [{ message: { tool_calls: [{ id: "1" }] } }],
        });
      },
    },
  );
  assert.equal(result.id, "vendor/model");
  assert.ok(request);
  assert.match(
    typeof request.url === "string"
      ? request.url
      : request.url instanceof URL
        ? request.url.href
        : request.url.url,
    /chat\/completions$/,
  );
  assert.equal(request.body.model, "vendor/model");
  assert.equal(
    (request.body.tools as { function: { name: string } }[])[0].function.name,
    "ping",
  );
  assert.equal(request.body.max_tokens, 32);

  const exhausted = await validateModelSelection(
    { provider: "openrouter", model: "vendor/reasoning", key: "secret" },
    {
      fetchFn: async () =>
        response({
          choices: [
            {
              finish_reason: "length",
              message: { content: "", reasoning: "hidden budget exhausted" },
            },
          ],
        }),
    },
  );
  assert.equal(exhausted.id, "vendor/reasoning");

  await assert.rejects(
    validateModelSelection(
      { provider: "openrouter", model: "vendor/no-tools", key: "secret" },
      {
        fetchFn: async () =>
          response({ error: { message: "No tool use" } }, 400),
      },
    ),
    (error) =>
      error instanceof ModelValidationError &&
      error.code === "model_unavailable",
  );
});

test("OpenRouter classifies non-JSON auth failures before parsing the body", async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      validateModelSelection(
        { provider: "openrouter", model: "vendor/model", key: "bad" },
        {
          fetchFn: async () =>
            new Response("unauthorized", {
              status,
              headers: { "content-type": "text/plain" },
            }),
        },
      ),
      (error) =>
        error instanceof ModelValidationError &&
        error.code === "auth_rejected" &&
        error.status === status,
    );
  }
});

test("Requesty validation sends the same tool-call probe to its own endpoint", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  let auth: string | null = null;
  const result = await validateModelSelection(
    { provider: "requesty", model: "gpt-5.5", key: "secret" },
    {
      fetchFn: async (url, init) => {
        requestUrl = url instanceof Request ? url.url : url.toString();
        auth = new Headers(init?.headers).get("authorization");
        requestBody = JSON.parse(
          typeof init?.body === "string" ? init.body : "",
        ) as Record<string, unknown>;
        return response({
          model: "gpt-5.5-2026-04-23",
          choices: [{ message: { tool_calls: [{ id: "1" }] } }],
        });
      },
    },
  );
  assert.equal(result.id, "gpt-5.5");
  assert.equal(requestUrl, "https://router.requesty.ai/v1/chat/completions");
  assert.equal(auth, "Bearer secret");
  assert.equal(requestBody.model, "gpt-5.5");
  assert.equal(requestBody.max_tokens, 32);

  for (const [status, code] of [
    [403, "auth_rejected"],
    [404, "model_unavailable"],
  ] as const) {
    await assert.rejects(
      validateModelSelection(
        { provider: "requesty", model: "openai/nope", key: "secret" },
        {
          fetchFn: async () =>
            response(
              { error: { origin: "router", message: "rejected" } },
              status,
            ),
        },
      ),
      (error) => error instanceof ModelValidationError && error.code === code,
    );
  }
});

// ─── custom: чужой эндпоинт ничего не обещал ──────────────────────────────────────────
// GET /models спецификацией OpenAI-совместимости не требуется. Отсутствие каталога — не
// поломка конфигурации, а её нормальный вид; отказ по ключу остаётся отказом.

test("custom accepts a typed model when the endpoint has no catalog", async () => {
  const cases = [
    { name: "404", fetchFn: async () => response({}, 404) },
    { name: "500", fetchFn: async () => response({}, 500) },
    { name: "not json", fetchFn: async () => response("<html>", 200) },
    { name: "empty list", fetchFn: async () => response({ data: [] }) },
    {
      name: "offline",
      fetchFn: async () => {
        throw new Error("offline");
      },
    },
  ];
  for (const item of cases) {
    const selected = await validateModelSelection(
      {
        provider: "custom",
        model: "  vendor/typed  ",
        base: "https://api.example.com/v1",
      },
      { fetchFn: item.fetchFn },
    );
    assert.deepEqual(
      selected,
      { id: "vendor/typed", reasoningLevels: [] },
      item.name,
    );
  }
});

test("custom still fails on a rejected key and on a model the live catalog denies", async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      validateModelSelection(
        {
          provider: "custom",
          model: "vendor/typed",
          key: "bad",
          base: "https://api.example.com/v1",
        },
        { fetchFn: async () => response({}, status) },
      ),
      (error) =>
        error instanceof ModelValidationError &&
        error.code === "auth_rejected" &&
        error.status === status,
      String(status),
    );
  }
  // Каталог живой и модели в нём нет — значит и в .env ей не место.
  await assert.rejects(
    validateModelSelection(
      {
        provider: "custom",
        model: "vendor/typo",
        base: "https://api.example.com/v1",
      },
      { fetchFn: async () => response({ data: [{ id: "vendor/real" }] }) },
    ),
    (error) =>
      error instanceof ModelValidationError &&
      error.code === "model_unavailable",
  );
  // Живой каталог принимается как есть.
  assert.deepEqual(
    await validateModelSelection(
      {
        provider: "custom",
        model: "vendor/real",
        base: "https://api.example.com/v1",
      },
      { fetchFn: async () => response({ data: [{ id: "vendor/real" }] }) },
    ),
    { id: "vendor/real", reasoningLevels: [] },
  );
});

test("custom without an endpoint address never reaches the network", async () => {
  let calls = 0;
  await assert.rejects(
    validateModelSelection(
      { provider: "custom", model: "vendor/typed" },
      {
        fetchFn: async () => {
          calls += 1;
          return response({ data: [{ id: "vendor/typed" }] });
        },
      },
    ),
    (error) =>
      error instanceof ModelValidationError && error.code === "base_missing",
  );
  assert.equal(calls, 0);
});

test("empty and malformed selections are rejected before provider I/O", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return response({ data: [{ id: "x" }] });
  };
  for (const model of ["", " \n ", null]) {
    await assert.rejects(
      validateModelSelection(
        { provider: "ollama", model, key: "secret" },
        { fetchFn },
      ),
      (error) =>
        error instanceof ModelValidationError &&
        error.code === "invalid_selection",
    );
  }
  await assert.rejects(
    validateModelSelection(
      { provider: "__proto__", model: "x", key: "secret" },
      { fetchFn },
    ),
    (error) =>
      error instanceof ModelValidationError &&
      error.code === "invalid_selection",
  );
  assert.equal(calls, 0);
});

// ─── claude: ключа нет, проверка — живой запрос через чужой CLI ──────────────────────
// В .env у вендора одна строка (имя модели), поэтому «ключ принят» тут не проверяется
// вовсе: проверяется, что модель вообще есть у подписки. Проба ходит через
// scripts/lib/claude-cli-status.ts, а рантайм — своей рукой.
test("the claude selection is probed through the CLI, not through a catalog", async () => {
  const seen: string[] = [];
  const selected = await validateModelSelection(
    { provider: "claude", model: "  claude-fable-5-1  " },
    {
      fetchFn: () => {
        throw new Error("сеть не при чём: у этого вендора её нет");
      },
      probeClaude: async (model) => {
        seen.push(model);
        return { id: model, reasoningLevels: [], answered: true };
      },
    },
  );
  assert.deepEqual(seen, ["claude-fable-5-1"]);
  assert.equal(selected.id, "claude-fable-5-1");
  assert.equal(selected.answered, true);
});

test("a CLI refusal becomes the matching selection error", async () => {
  const cases = [
    ["not_logged_in", "auth_rejected"],
    ["not_installed", "not_installed"],
    ["model_unavailable", "model_unavailable"],
    ["timeout", "timeout"],
  ] as const;
  for (const [code, expected] of cases) {
    await assert.rejects(
      validateModelSelection(
        { provider: "claude", model: "claude-fable-5-1" },
        {
          probeClaude: () => {
            throw new ClaudeCliError(code, "the CLI said no");
          },
        },
      ),
      (error) =>
        error instanceof ModelValidationError &&
        error.code === expected &&
        error.message === "the CLI said no",
      code,
    );
  }
});
