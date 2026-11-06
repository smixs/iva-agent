import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import ts from "typescript";
import { noticeSender } from "../agent/lib/outbox.ts";

process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_API_KEY = "test-key";
process.env.OLLAMA_BASE_URL = "https://vision.invalid/v1";
process.env.OLLAMA_VISION_MODEL = "vision-test";
const { describeImage } = await import("../agent/vision.ts");
const { transcribe } = await import("../agent/transcribe.ts");
const { processMediaPart } = await import("../agent/lib/telegram-media.ts");
const { getAccessToken, writeAuth } =
  await import("../agent/lib/codex-auth.ts");
const { runDeviceCodeLogin } = await import("./lib/codex-oauth.ts");

const ROOT = new URL("../", import.meta.url);

function unguardedFetches(source: string): number[] {
  const file = ts.createSourceFile(
    "input.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const lines: number[] = [];
  const hasSignal = (node: ts.Node): boolean => {
    if (ts.isParenthesizedExpression(node)) return hasSignal(node.expression);
    if (ts.isConditionalExpression(node))
      return hasSignal(node.whenTrue) || hasSignal(node.whenFalse);
    return (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some((p) =>
        ts.isSpreadAssignment(p)
          ? hasSignal(p.expression)
          : (ts.isPropertyAssignment(p) ||
              ts.isShorthandPropertyAssignment(p)) &&
            p.name.getText(file).replaceAll(/["']/g, "") === "signal" &&
            (!ts.isPropertyAssignment(p) ||
              !["undefined", "null"].includes(p.initializer.getText(file))),
      )
    );
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.getText(file) === "fetch" ||
        node.expression.getText(file) === "globalThis.fetch")
    ) {
      const options = node.arguments[1];
      if (!options || !hasSignal(options))
        lines.push(
          file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

await test("every fetch in agent/ and scripts/ supplies a signal (provider wrappers forward init)", () => {
  const missing: string[] = [];
  for (const tree of ["agent", "scripts"]) {
    const root = new URL(`${tree}/`, ROOT);
    for (const path of readdirSync(root, { recursive: true }) as string[]) {
      if (
        !/\.(?:ts|mts|mjs|js)$/.test(path) ||
        path.endsWith(".test.ts") ||
        `${tree}/${path}` === "agent/provider.ts"
      )
        continue;
      for (const line of unguardedFetches(
        readFileSync(new URL(path, root), "utf8"),
      ))
        missing.push(`${tree}/${path}:${line}`);
    }
  }
  assert.deepEqual(missing, []);
});

await test("fetch guard catches missing signals across formatting and comments", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("", " ", "\n", "/* signal: misleading */"),
      fc.boolean(),
      (space, guarded) => {
        const source = `fetch(${space}"https://example.invalid", {method: "GET"${guarded ? ", signal: AbortSignal.timeout(30)" : ""}})`;
        assert.equal(unguardedFetches(source).length, guarded ? 0 : 1);
      },
    ),
    { seed: 20261020 },
  );
  for (const source of [
    'fetch("url")',
    'fetch("url", {signal: undefined})',
    'globalThis.fetch("url", {signal: null})',
  ])
    assert.equal(unguardedFetches(source).length, 1);
  assert.equal(unguardedFetches('fetch("url", {signal})').length, 0);
  assert.equal(unguardedFetches('fetch("url", {body: {signal: 1}})').length, 1);
  assert.equal(
    unguardedFetches('fetch("url", {...(flag ? {} : {signal})})').length,
    0,
  );
});

const cases = [
  {
    name: "vision",
    target: "/chat/completions",
    ms: 120_000,
    message: /описания.*120 с/,
    invoke: () => describeImage(new ArrayBuffer(4), "image/png"),
  },
  {
    name: "Deepgram",
    target: "/v1/listen",
    ms: 120_000,
    message: /Deepgram.*120 с/,
    invoke: () => transcribe(new ArrayBuffer(4)),
  },
  {
    name: "Telegram download",
    target: "/file/bot",
    ms: 300_000,
    message: /Telegram.*5 минут/,
    invoke: async () => {
      const notices: string[] = [];
      const result = await processMediaPart(
        {
          request: () =>
            Promise.resolve({ body: { result: { file_path: "voice.ogg" } } }),
          sendMessage: noticeSender((text) => {
            notices.push(text);
            return Promise.resolve(null);
          }),
          describeImage: () => Promise.resolve(""),
          chatModelSeesImages: () => Promise.resolve(false),
          transcribe: () => Promise.resolve(""),
        },
        {},
        { tag: "voice", fileId: "timeout-file", transcribe: false },
      );
      assert.equal(result.kind, "error");
      assert.match(notices.join("\n"), /Telegram.*5 минут/);
      throw new Error(result.context.join("\n"));
    },
  },
  {
    name: "Codex refresh",
    target: "/oauth/token",
    ms: 30_000,
    message: /Codex.*30 с/,
    invoke: (dir: string) => getAccessToken(dir),
  },
  ...[false, true].map((voice) => ({
    name: voice ? "Deepgram context" : "vision context",
    target: voice ? "/v1/listen" : "/chat/completions",
    ms: 120_000,
    message: voice ? /Deepgram.*120 с/ : /описания.*120 с/,
    invoke: async () => {
      const result = await processMediaPart(
        {
          request: () =>
            Promise.resolve({
              body: { result: { file_path: "file.bin" } },
            }),
          sendMessage: noticeSender(() => Promise.resolve(null)),
          describeImage,
          transcribe,
          chatModelSeesImages: () => Promise.resolve(false),
        },
        {},
        {
          tag: voice ? "voice" : "photo",
          fileId: "context-file",
          transcribe: voice,
        },
      );
      assert.equal(result.kind, "context");
      assert.match(result.context[0], /attachments\//);
      throw new Error(result.context.join("\n"));
    },
  })),
  ...["/deviceauth/usercode", "/deviceauth/token", "/oauth/token"].map(
    (target) => ({
      name: `Codex login ${target}`,
      target,
      ms: 30_000,
      message: /Codex.*30 с/,
      invoke: (dir: string) =>
        runDeviceCodeLogin({ dataDir: dir, log: () => {} }),
    }),
  ),
];

for (const scenario of cases) {
  for (const bodyStalls of [false, true]) {
    await test(
      `${scenario.name}: stalled ${bodyStalls ? "body" : "headers"} returns a readable timeout`,
      { timeout: 3000 },
      async (t) => {
        const dir = mkdtempSync(join(tmpdir(), "iva-fetch-timeout-"));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        for (const [key, value] of Object.entries({
          ASSISTANT_DATA_DIR: dir,
          ASSISTANT_VAULT_DIR: join(dir, "vault"),
          DEEPGRAM_API_KEY: "test-key",
        })) {
          const previous = process.env[key];
          process.env[key] = value;
          t.after(() => {
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
          });
        }
        t.mock.method(console, "error", () => {});
        writeAuth(
          {
            access_token: "expired",
            refresh_token: "test-refresh",
            accountId: null,
            planType: null,
          },
          dir,
        );
        const stored = readFileSync(join(dir, "codex-auth.json"), "utf8");
        const server = createServer((_req, res) => {
          if (bodyStalls) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write("{");
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        t.after(async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        });
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const realFetch = globalThis.fetch;
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const deadlines: number[] = [];
        t.mock.method(AbortSignal, "timeout", (ms: number) => {
          deadlines.push(ms);
          return realTimeout(40);
        });
        let sentSignal: AbortSignal | null | undefined;
        t.mock.method(
          globalThis,
          "fetch",
          (input: string | URL | Request, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url.includes(scenario.target)) {
              sentSignal = init?.signal;
              return realFetch(`http://127.0.0.1:${address.port}`, {
                ...init,
                signal: init?.signal ?? realTimeout(200),
              });
            }
            if (url.includes("/file/bot"))
              return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
            if (url.endsWith("/deviceauth/usercode"))
              return Promise.resolve(
                Response.json({
                  device_auth_id: "device",
                  user_code: "code",
                  interval: 1,
                }),
              );
            if (url.endsWith("/deviceauth/token"))
              return Promise.resolve(
                Response.json({
                  authorization_code: "code",
                  code_verifier: "verifier",
                }),
              );
            throw new Error(`unexpected request: ${url}`);
          },
        );
        await assert.rejects(scenario.invoke(dir), scenario.message);
        assert.ok(sentSignal?.aborted);
        assert.ok(
          deadlines.includes(scenario.ms),
          `deadline ${scenario.ms} was supplied`,
        );
        assert.equal(
          readFileSync(join(dir, "codex-auth.json"), "utf8"),
          stored,
          "a timeout preserves the stored login",
        );
      },
    );
  }
}
