/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import { routeAuth } from "eve/channels/auth";
import fc from "fast-check";
import {
  assistantBearerAuth,
  createEveAuth,
  isHelperTurn,
  usesHelperModel,
  TURN_KINDS,
} from "./eve-auth.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);

const TOKEN = randomBytes(32).toString("base64url");
const request = (host: string, token?: string) =>
  new Request(`http://${host}/eve/v1/session`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

test("helper detection tolerates missing context, session, auth and attributes", () => {
  for (const ctx of [
    {},
    { session: {} },
    undefined,
    null,
    { session: null },
    { session: { auth: null } },
    { session: { auth: { initiator: null, current: null } } },
    { session: { auth: { initiator: { authenticator: "iva-bearer" } } } },
    {
      session: {
        auth: { current: { authenticator: "iva-bearer", attributes: null } },
      },
    },
  ]) {
    assert.equal(isHelperTurn(ctx), false);
    assert.equal(usesHelperModel(ctx), false);
  }
});

test("bearer auth accepts only the configured secret", async () => {
  const auth = assistantBearerAuth(TOKEN);
  assert.equal(await auth(request("evil.example")), null);
  assert.equal(await auth(request("evil.example", "wrong")), null);
  assert.deepEqual(await auth(request("evil.example", TOKEN)), {
    attributes: {},
    authenticator: "iva-bearer",
    principalId: "iva-internal-client",
    principalType: "service",
  });
});

const turnRequest = (token: string, turn: string) =>
  new Request("http://127.0.0.1:8723/eve/v1/session", {
    headers: { authorization: `Bearer ${token}`, "x-iva-turn": turn },
  });

test("every background kind carries its step and cumulative input ceilings", async () => {
  const auth = assistantBearerAuth(TOKEN);
  for (const turn of [
    "watch",
    "brief",
    "insight",
    "reminder",
    "signal",
    "alert",
  ]) {
    assert.deepEqual(await auth(turnRequest(TOKEN, turn)), {
      attributes: {
        iva_turn: turn,
        iva_max_steps: turn === "brief" ? "60" : "40",
        iva_max_input_tokens: "4000000",
      },
      authenticator: "iva-bearer",
      principalId: "iva-internal-client",
      principalType: "service",
    });
  }
});

test("a wrong bearer with a valid kind is still refused", async () => {
  const auth = assistantBearerAuth(TOKEN);
  assert.equal(await auth(turnRequest("wrong", "insight")), null);
  assert.equal(await auth(turnRequest("", "watch")), null);
});

test(`a kind outside the list gets no attribute (PBT, seed ${SEED})`, async () => {
  const auth = assistantBearerAuth(TOKEN);
  const kinds = [...TURN_KINDS];
  const header = fc.oneof(
    fc.string(),
    fc.constantFrom(...kinds).map((kind) => kind.toUpperCase()),
    fc.constantFrom(...kinds).map((kind) => ` ${kind}`),
    fc.constantFrom(...kinds).map((kind) => `${kind}, ${kind}`),
    fc.constantFrom(...kinds).map((kind) => `${kind},alert`),
    fc.constant("__proto__"),
    fc.constant("constructor"),
  );
  await fc.assert(
    fc.asyncProperty(header, async (turn) => {
      let request: Request;
      try {
        request = turnRequest(TOKEN, turn);
      } catch {
        return; // строку, которая не годится в заголовок, Headers не пропустит и так
      }
      const sent = request.headers.get("x-iva-turn") ?? "";
      if (sent === "helper") {
        await assert.rejects(async () => auth(request));
        return;
      }
      const result = await auth(request);
      assert.ok(result);
      if (TURN_KINDS.has(sent))
        assert.deepEqual(result.attributes, {
          iva_turn: sent,
          iva_max_steps: sent === "brief" ? "60" : "40",
          iva_max_input_tokens: "4000000",
        });
      else assert.deepEqual(result.attributes, {});
    }),
    { seed: SEED, numRuns: 300 },
  );
});

test("two values of the header, as fetch joins them, are not a kind", async () => {
  const auth = assistantBearerAuth(TOKEN);
  const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
  headers.append("x-iva-turn", "watch");
  headers.append("x-iva-turn", "brief");
  const result = await auth(
    new Request("http://127.0.0.1:8723/eve/v1/session", { headers }),
  );
  assert.deepEqual(result?.attributes, {});
});

test("production auth rejects a spoofed loopback Host without a bearer", async () => {
  const result = await routeAuth(
    request("127.0.0.1:8723"),
    createEveAuth({ ASSISTANT_BEARER: TOKEN }),
  );
  assert.ok(result instanceof Response);
  assert.equal(result.status, 401);
});

/** Makes the process the dev server eve 0.30's localDev() looks for, then restores it. */
const runningEveDev = (t: TestContext): void => {
  const previous = process.env.EVE_DEV;
  process.env.EVE_DEV = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.EVE_DEV;
    else process.env.EVE_DEV = previous;
  });
};

test("eve dev keeps localDev auth explicitly", async (t) => {
  runningEveDev(t);
  const result = await routeAuth(
    request("127.0.0.1:8723"),
    createEveAuth({ ASSISTANT_BEARER: TOKEN, EVE_DEV: "1" }),
  );
  assert.ok(!(result instanceof Response));
  assert.equal(result.authenticator, "local-dev");
});

test("our own gate drops localDev even on a dev-server process", async (t) => {
  runningEveDev(t);
  const result = await routeAuth(
    request("127.0.0.1:8723"),
    createEveAuth({ ASSISTANT_BEARER: TOKEN }),
  );
  assert.ok(result instanceof Response);
  assert.equal(result.status, 401);
});

test(`helper ids are strict and invalid requests return 401 (PBT, seed ${SEED})`, async (t) => {
  runningEveDev(t);
  const hex = fc.stringMatching(/^[0-9a-f]{6}$/);
  await fc.assert(
    fc.asyncProperty(hex, async (suffix) => {
      const good = "h-" + suffix;
      for (const value of [
        good,
        null,
        "",
        "h-A" + suffix.slice(1),
        good.slice(0, -1),
        good + "0",
        good + "/../..",
        [good, good],
      ]) {
        const headers = new Headers({
          authorization: `Bearer ${TOKEN}`,
          "x-iva-turn": "helper",
        });
        for (const id of value === null
          ? []
          : Array.isArray(value)
            ? value
            : [value])
          headers.append("x-iva-helper", id);
        for (const dev of [undefined, "1"]) {
          const req = new Request("http://127.0.0.1:8723", { headers });
          const result = await routeAuth(
            req,
            createEveAuth({ ASSISTANT_BEARER: TOKEN, EVE_DEV: dev }),
          );
          if (value === good) {
            assert.ok(!(result instanceof Response));
            assert.deepEqual(result.attributes, {
              iva_turn: "helper",
              iva_helper: good,
              iva_max_steps: "80",
              iva_max_input_tokens: "4000000",
            });
          } else {
            assert.ok(result instanceof Response);
            assert.equal(result.status, 401);
          }
        }
      }
    }),
    { seed: SEED, numRuns: 150 },
  );
  await assert.rejects(async () =>
    assistantBearerAuth(TOKEN)(turnRequest(TOKEN, "helper")),
  );
});

test("background model choice preserves helper-only rights and requires an exact kind", () => {
  for (const kind of [
    "helper",
    "watch",
    "brief",
    "insight",
    "reminder",
    "signal",
    "alert",
    null,
    ["watch"],
    { toString: () => "watch" },
  ]) {
    const ctx = {
      session: {
        auth: {
          current: {
            authenticator: "iva-bearer",
            attributes: { iva_turn: kind },
          },
        },
      },
    };
    assert.equal(isHelperTurn(ctx), kind === "helper");
    assert.equal(
      usesHelperModel(ctx),
      typeof kind === "string" &&
        ["helper", "watch", "brief", "insight"].includes(kind),
    );
  }
});
