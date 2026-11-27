/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import {
  COLLEAGUE_ROLES,
  COLLEAGUE_ROLE_SPECS,
  colleagueRoleMarkdown,
  colleaguesEnabled,
  isColleaguesEnabled,
  parseColleagueRole,
  parseColleaguesConfig,
  readColleague,
  suggestColleagueModel,
  withColleague,
  withColleagueModel,
  withColleaguesEnabled,
  withoutColleague,
} from "./colleagues.ts";
import { colleagueExecute } from "./colleague-tool.ts";
import { assistantBearerAuth, colleagueBotIdOfTurn } from "./eve-auth.ts";
import { MODEL_PROVIDER_NAMES } from "./model-provider.ts";
import { TELEGRAM_BOT_ID_HEADER } from "../../packages/telegram-bots/index.ts";

const SEED = Number(process.env.FC_SEED ?? 20_261_126);

test("clean config keeps colleagues option disabled by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-colleagues-clean-"));
  try {
    const missingSettings = join(dir, "settings.json");
    assert.equal(isColleaguesEnabled(missingSettings), false);
    assert.equal(colleaguesEnabled({}), false);
    assert.deepEqual(
      parseColleaguesConfig({}, () => {}),
      {
        enabled: false,
        items: {},
      },
    );
    assert.equal(readColleague("222222222", missingSettings), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`property: parseColleaguesConfig fails closed on malformed input and round-trips valid entries (seed ${SEED})`, () => {
  const botIdArb = fc.integer({ min: 1000, max: 999_999_999 }).map(String);
  const roleArb = fc.constantFrom(...COLLEAGUE_ROLES);
  const providerArb = fc.constantFrom(...MODEL_PROVIDER_NAMES);
  const modelArb = fc.stringMatching(/^[a-z0-9][a-z0-9._/-]{1,40}$/);

  fc.assert(
    fc.property(
      fc.boolean(),
      fc.array(fc.tuple(botIdArb, roleArb, providerArb, modelArb), {
        maxLength: 6,
      }),
      (enabled, tuples) => {
        let settings: Record<string, unknown> = { lang: "ru" };
        settings = withColleaguesEnabled(settings, enabled);
        for (const [botId, role, provider, model] of tuples) {
          settings = withColleague(settings, { botId, role, provider, model });
        }
        const parsed = parseColleaguesConfig(settings, () => {});
        assert.equal(parsed.enabled, enabled);
        assert.equal(settings.lang, "ru");

        const expectedByBot = new Map(
          tuples.map(([botId, role, provider, model]) => [
            botId,
            { botId, role, provider, model },
          ]),
        );
        assert.equal(Object.keys(parsed.items).length, expectedByBot.size);
        for (const [botId, expected] of expectedByBot) {
          assert.deepEqual(parsed.items[botId], expected);
        }
      },
    ),
    { seed: SEED, numRuns: 200 },
  );

  // Adversarial malformed settings never flip enabled to true.
  const badEnabledArb = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constant("true"),
    fc.constant(1),
    fc.constant([]),
    fc.constant({}),
  );
  fc.assert(
    fc.property(badEnabledArb, (bad) => {
      const parsed = parseColleaguesConfig(
        { colleagues: { enabled: bad, items: "broken" } },
        () => {},
      );
      assert.equal(parsed.enabled, false);
      assert.deepEqual(parsed.items, {});
    }),
    { seed: SEED, numRuns: 50 },
  );
});

test("all four roles (Critic, Programmer, Researcher, Secretary) resolve in Russian and English and suggest a model", () => {
  assert.deepEqual(COLLEAGUE_ROLES, [
    "critic",
    "programmer",
    "researcher",
    "secretary",
  ]);
  assert.equal(parseColleagueRole("Критик"), "critic");
  assert.equal(parseColleagueRole("Программист"), "programmer");
  assert.equal(parseColleagueRole("Исследователь"), "researcher");
  assert.equal(parseColleagueRole("Секретарь"), "secretary");
  assert.equal(parseColleagueRole("CRITIC"), "critic");
  assert.equal(parseColleagueRole("unknown"), null);

  for (const role of COLLEAGUE_ROLES) {
    const spec = COLLEAGUE_ROLE_SPECS[role];
    assert.ok(spec.labelRu.length > 0);
    assert.ok(spec.instructions.length > 20);
    const suggestion = suggestColleagueModel(role, {
      MODEL_PROVIDER: "ollama",
      OLLAMA_MODEL: "deepseek-v4-pro",
      OPENROUTER_API_KEY: "or-key",
    });
    assert.equal(suggestion.role, role);
    assert.ok(MODEL_PROVIDER_NAMES.includes(suggestion.provider));
    assert.ok(suggestion.model.length > 0);

    const md = colleagueRoleMarkdown({
      botId: "222222222",
      role,
      provider: suggestion.provider,
      model: suggestion.model,
    });
    assert.ok(md.includes(spec.labelRu));
    assert.ok(md.includes(role));
    assert.ok(md.includes(`${suggestion.provider}/${suggestion.model}`));
  }

  // With multiple providers configured, Critic prefers Claude while Programmer prefers Codex.
  const multiEnv = {
    MODEL_PROVIDER: "ollama",
    CLAUDE_MODEL: "claude-fable-5-2",
    CODEX_MODEL: "gpt-5.5",
  };
  assert.equal(suggestColleagueModel("critic", multiEnv).provider, "claude");
  assert.equal(suggestColleagueModel("programmer", multiEnv).provider, "codex");
});

test("withColleagueModel updates provider/model across every MODEL_PROVIDER_NAMES and rejects unknown colleague", () => {
  let settings = withColleague(withColleaguesEnabled({}, true), {
    botId: "222222222",
    role: "critic",
    provider: "ollama",
    model: "deepseek-v4-pro",
  });
  for (const provider of MODEL_PROVIDER_NAMES) {
    const model = `test-model-${provider}`;
    settings = withColleagueModel(settings, "222222222", provider, model);
    const parsed = parseColleaguesConfig(settings, () => {});
    assert.equal(parsed.items["222222222"]?.provider, provider);
    assert.equal(parsed.items["222222222"]?.model, model);
    assert.equal(parsed.items["222222222"]?.role, "critic");
  }
  assert.throws(
    () =>
      withColleagueModel(settings, "999999999", "claude", "claude-sonnet-5-5"),
    /not configured/u,
  );
  const removed = withoutColleague(settings, "222222222");
  assert.equal(
    parseColleaguesConfig(removed, () => {}).items["222222222"],
    undefined,
  );
});

test("colleague tool lets Iva suggest, configure and change a colleague model only in owner private chat", () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-colleague-tool-"));
  mkdirSync(dir, { recursive: true });
  const settingsFile = join(dir, "settings.json");
  const privateCtx = {
    session: {
      auth: {
        initiator: {
          authenticator: "telegram-webhook",
          principalType: "user",
          attributes: { chat_type: "private", chat_id: "42" },
        },
        current: {
          authenticator: "telegram-webhook",
          principalType: "user",
          attributes: { chat_type: "private", chat_id: "42" },
        },
      },
    },
  };
  const groupCtx = {
    session: {
      auth: {
        initiator: {
          authenticator: "telegram-webhook",
          principalType: "user",
          attributes: { chat_type: "group", chat_id: "-1001" },
        },
        current: {
          authenticator: "telegram-webhook",
          principalType: "user",
          attributes: { chat_type: "group", chat_id: "-1001" },
        },
      },
    },
  };

  try {
    const suggested = colleagueExecute(
      { action: "suggest_model", role: "critic" },
      privateCtx,
      {
        settingsFile,
        env: { MODEL_PROVIDER: "ollama", CLAUDE_MODEL: "claude-fable-5-2" },
      },
    );
    assert.equal(suggested.ok, true);
    assert.equal(suggested.suggestion?.provider, "claude");

    // Group chat cannot mutate colleague config.
    const denied = colleagueExecute(
      { action: "configure", bot_id: "222222222", role: "critic" },
      groupCtx,
      { settingsFile },
    );
    assert.equal(denied.ok, false);
    assert.match(denied.error, /private chat/u);

    // Iva configures colleague in private chat (auto-suggests model).
    const configured = colleagueExecute(
      { action: "configure", bot_id: "222222222", role: "critic" },
      privateCtx,
      { settingsFile, env: { MODEL_PROVIDER: "ollama" } },
    );
    assert.equal(configured.ok, true);
    assert.equal(configured.colleague?.role, "critic");
    assert.equal(configured.colleague?.provider, "ollama");

    // Iva changes the colleague's model to another provider.
    const changed = colleagueExecute(
      {
        action: "set_model",
        bot_id: "222222222",
        provider: "openrouter",
        model: "anthropic/claude-opus-4.5",
      },
      privateCtx,
      { settingsFile },
    );
    assert.equal(changed.ok, true);
    assert.equal(changed.colleague?.provider, "openrouter");
    assert.equal(changed.colleague?.model, "anthropic/claude-opus-4.5");

    const listed = colleagueExecute({ action: "list" }, privateCtx, {
      settingsFile,
    });
    assert.equal(listed.ok, true);
    assert.equal(listed.enabled, false);
    assert.equal(listed.colleagues?.length, 1);
    assert.equal(listed.colleagues?.[0]?.model, "anthropic/claude-opus-4.5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("colleagueBotIdOfTurn and serviceAuth carry colleague bot_id and ignore primary bot_id", async () => {
  const env = { TELEGRAM_BOT_TOKEN: "111111111:PRIMARY_SECRET" };
  assert.equal(
    colleagueBotIdOfTurn(
      {
        session: {
          auth: {
            current: {
              authenticator: "telegram-webhook",
              attributes: { bot_id: "222222222" },
            },
          },
        },
      },
      env,
    ),
    "222222222",
  );
  assert.equal(
    colleagueBotIdOfTurn(
      {
        session: {
          auth: {
            current: {
              authenticator: "telegram-webhook",
              attributes: { bot_id: "111111111" },
            },
          },
        },
      },
      env,
    ),
    null,
  );
  assert.equal(
    colleagueBotIdOfTurn(
      {
        session: {
          auth: {
            initiator: {
              authenticator: "iva-bearer",
              attributes: { iva_turn: "reminder", bot_id: "333333333" },
            },
          },
        },
      },
      env,
    ),
    "333333333",
  );

  const auth = assistantBearerAuth("secret-token");
  const req = new Request("http://127.0.0.1:8723/eve/v1/session", {
    headers: {
      authorization: "Bearer secret-token",
      "x-iva-turn": "reminder",
      [TELEGRAM_BOT_ID_HEADER]: "333333333",
    },
  });
  const principal = await auth(req);
  assert.equal(principal?.attributes.iva_turn, "reminder");
  assert.equal(principal?.attributes.bot_id, "333333333");
});
