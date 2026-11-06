import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freePort,
  prepareApp,
  runNode,
  startEve,
  waitForHealth,
  type EveProcess,
} from "./lib/eve-app.ts";
import { envFor, killEve, post } from "./fixtures/restart-app.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Параметры только процессного теста.
const CONFIG = Object.freeze({
  suiteTimeoutMs: 900_000,
  pointTimeoutMs: 180_000,
  barrierTimeoutMs: 30_000,
  pollMs: 50,
  inputTokens: 40_000,
  outputTokens: 1,
  paddingRepeats: 25_000,
  bearerBytes: 24,
  enabledFlag: "1",
  httpOK: 200,
  choiceIndex: 0,
  createdAt: 1,
  ephemeralPort: 0,
  previewThreshold: 1000,
  previewChars: 120,
  jsonIndent: 2,
  privateFileMode: 0o600,
  chatId: 1,
  chatKey: "1:",
  address: "1::",
  ownerId: 42,
  queueUpdateId: 2,
  messageDate: 1,
  emptyCount: 0,
  singleCount: 1,
  host: "127.0.0.1",
  botToken: "73002:restart-test-token",
});

// Ответы провайдера относятся к этой матрице. Общий restart-app.ts даёт
// исходное окружение, POST и SIGKILL, а канал остаётся прежней фикстурой.
type RestartReply = {
  text: string;
  inputTokens?: number;
  toolCall?: { name: string; arguments: string };
};

function completion(reply: RestartReply): string {
  const chunk = (content: string, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-restart",
      object: "chat.completion.chunk",
      created: CONFIG.createdAt,
      model: "iva-restart",
      choices: [
        {
          index: CONFIG.choiceIndex,
          delta:
            reply.toolCall && finishReason === null
              ? {
                  tool_calls: [
                    {
                      index: CONFIG.choiceIndex,
                      id: "snapshot-witness",
                      type: "function",
                      function: reply.toolCall,
                    },
                  ],
                }
              : content
                ? { content }
                : {},
          finish_reason: finishReason,
        },
      ],
    })}\n\n`;
  const usage =
    reply.inputTokens === undefined
      ? ""
      : `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: reply.inputTokens, completion_tokens: CONFIG.outputTokens, total_tokens: reply.inputTokens + CONFIG.outputTokens } })}\n\n`;
  return `${chunk(reply.text, null)}${chunk("", reply.toolCall ? "tool_calls" : "stop")}${usage}data: [DONE]\n\n`;
}

async function startMatrixProvider(
  respond: (body: string) => RestartReply | null,
): Promise<{
  baseUrl: string;
  blocked: Promise<void>;
  close(): Promise<void>;
}> {
  let markBlocked = () => {};
  const blocked = new Promise<void>((resolve) => {
    markBlocked = resolve;
  });
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const reply = respond(body);
      if (reply === null) {
        markBlocked();
        return;
      }
      const answer = reply;
      if ((JSON.parse(body) as { stream?: boolean }).stream === true) {
        response.writeHead(CONFIG.httpOK, {
          "content-type": "text/event-stream",
        });
        response.end(completion(answer));
      } else {
        response.writeHead(CONFIG.httpOK, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            id: "chatcmpl-restart",
            object: "chat.completion",
            created: CONFIG.createdAt,
            model: "iva-restart",
            choices: [
              {
                index: CONFIG.choiceIndex,
                message: { role: "assistant", content: answer.text },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: answer.inputTokens ?? CONFIG.inputTokens,
              completion_tokens: CONFIG.outputTokens,
              total_tokens:
                (answer.inputTokens ?? CONFIG.inputTokens) +
                CONFIG.outputTokens,
            },
          }),
        );
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(CONFIG.ephemeralPort, CONFIG.host, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://${CONFIG.host}:${address.port}/v1`,
    blocked,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const POINTS = [
  "before-summary",
  "during-summary",
  "after-summary",
  "after-snapshot",
  "manual-compact",
] as const;
type WireRequest = {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
};
const H = "H_COMPACT_STEP1_OLD_HISTORY";
const SEED = `Remember ${H}. This belongs to the old conversation.`;
const OLD_REPLY = `OLD_REPLY_BEGIN ${"old history padding ".repeat(CONFIG.paddingRepeats)} OLD_REPLY_END`;
const SUMMARY = `STEP1_SUMMARY preserves ${H} and the old conversation's decision.`;
const SUMMARY_PROMPT = "CONTEXT CHECKPOINT COMPACTION";

function wireText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return JSON.stringify(value);
  return value.map((part: { text?: string }) => part.text ?? "").join("");
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + CONFIG.barrierTimeoutMs;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, CONFIG.pollMs));
  }
}

void test(
  "SIGKILL compaction matrix on the unchanged runtime",
  { timeout: CONFIG.suiteTimeoutMs },
  async (t) => {
    // run-status and Bridge bind their data directory on import. Give each matrix
    // point its own Node process so module caches cannot refer to another app.
    if (!process.env.COMPACT_STEP1_POINT) {
      for (const point of POINTS) {
        await t.test(point, { timeout: CONFIG.pointTimeoutMs }, async (row) => {
          const childEnv: NodeJS.ProcessEnv = {
            ...process.env,
            COMPACT_STEP1_POINT: point,
          };
          delete childEnv.NODE_TEST_CONTEXT;
          let witnessed = false;
          await runNode(
            [
              "--test",
              "--test-reporter=tap",
              "--test-name-pattern=SIGKILL compaction matrix",
              fileURLToPath(import.meta.url),
            ],
            ROOT,
            childEnv,
            (line) => {
              if (line.includes('"historyPass"')) witnessed = true;
              row.diagnostic(line);
            },
          );
          assert.ok(
            witnessed,
            `the ${point} child must execute its crash and report facts`,
          );
        });
      }
      return;
    }
    // Each point gets a fresh app and real build/start/recovery/start. No live credentials,
    // Telegram API, c1, service manager, or second Iva installation is involved.
    for (const point of POINTS) {
      if (point !== process.env.COMPACT_STEP1_POINT) continue;
      await t.test(point, { timeout: CONFIG.pointTimeoutMs }, async (row) => {
        const sandbox = await mkdtemp(
          join(tmpdir(), `iva-compact-step1-${point}-`),
        );
        const evidence = process.env.COMPACT_STEP1_EVIDENCE;
        const logs: string[] = [];
        const requests: WireRequest[] = [];
        let phase: "seed" | "crash" | "probe" = "seed";
        let probe: WireRequest | undefined;
        let snapshotWitness: WireRequest | undefined;
        let toolRequested = false;
        let eve: EveProcess | null = null;
        const B = `B_COMPACT_STEP1_${point}`;
        const provider = await startMatrixProvider((body) => {
          const request = JSON.parse(body) as WireRequest;
          requests.push(request);
          const summary = body.includes(SUMMARY_PROMPT);
          if (summary) {
            if (point === "during-summary" || point === "manual-compact")
              return null;
            return { text: SUMMARY, inputTokens: CONFIG.inputTokens };
          }
          if (phase === "seed")
            return { text: OLD_REPLY, inputTokens: CONFIG.inputTokens };
          if (phase === "crash" && point === "after-snapshot") {
            if (!toolRequested) {
              toolRequested = true;
              const name = request.tools?.find((tool) =>
                /(?:^|_)bash$/u.test(tool.function.name),
              )?.function.name;
              assert.ok(name, "the real bash tool is exposed to the provider");
              return {
                text: "",
                inputTokens: CONFIG.inputTokens,
                toolCall: {
                  name,
                  arguments: JSON.stringify({
                    command: "printf SNAPSHOT_WITNESS",
                  }),
                },
              };
            }
            snapshotWitness = request;
            return null;
          }
          probe = request;
          return { text: `ANSWER ${B}`, inputTokens: CONFIG.inputTokens };
        });
        row.after(async () => {
          if (eve && eve.exitCode === null && eve.signalCode === null)
            await killEve(eve);
          await provider.close();
          if (evidence) {
            const dir = join(evidence, point);
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, "process.log"), `${logs.join("\n")}\n`);
            await writeFile(
              join(dir, "requests.json"),
              JSON.stringify(
                requests.map((request) => ({
                  messages: request.messages.map((message) => {
                    const content = wireText(message.content);
                    return {
                      role: message.role,
                      length: content.length,
                      sha256: createHash("sha256")
                        .update(content)
                        .digest("hex"),
                      H: content.includes(H),
                      summary: content === SUMMARY,
                      oldReply: content === OLD_REPLY,
                      preview:
                        content.length < CONFIG.previewThreshold
                          ? content
                          : `${content.slice(0, CONFIG.previewChars)} … ${content.slice(-CONFIG.previewChars)}`,
                    };
                  }),
                })),
                null,
                CONFIG.jsonIndent,
              ),
            );
          }
          await rm(sandbox, { recursive: true, force: true });
        });

        const app = await prepareApp(sandbox);
        await cp(
          join(ROOT, "scripts/fixtures/restart-hang-channel.ts"),
          join(app, "agent/channels/restart-hang.ts"),
        );
        const port = await freePort();
        const bearer = randomBytes(CONFIG.bearerBytes).toString("hex");
        const env: NodeJS.ProcessEnv = {
          ...envFor(sandbox, app, port, provider.baseUrl, bearer),
          COMPACT_STEP1_MATRIX: CONFIG.enabledFlag,
          AGENT_LANGUAGE: "en",
        };
        Object.assign(process.env, {
          ASSISTANT_DATA_DIR: env.ASSISTANT_DATA_DIR,
          ASSISTANT_HOST: `http://${CONFIG.host}:${port}`,
          TELEGRAM_BOT_TOKEN: CONFIG.botToken,
          TELEGRAM_WEBHOOK_SECRET_TOKEN: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
          TELEGRAM_ALLOWED_USER_IDS: String(CONFIG.ownerId),
        });
        const status = await import("../agent/lib/run-status.ts");
        const queue = await import("./poller/queue.ts");
        const routing = await import("./poller/routing.ts");
        const note = (line: unknown) => {
          logs.push(String(line));
        };
        await writeFile(join(app, ".env"), `ASSISTANT_BEARER=${bearer}\n`, {
          mode: CONFIG.privateFileMode,
        });
        await runNode([join(app, "scripts/init-vault.mjs")], app, env, note);
        await runNode(
          [join(app, "node_modules/eve/bin/eve.js"), "build"],
          app,
          env,
          note,
        );
        const sentinels = [
          [
            join(app, "vault/daily/2001-01-01.md"),
            `# Diary\n\nOwner's diary ${H}.\n`,
          ],
          [
            join(app, "vault/cards/step1.md"),
            `---\nid: step1\ntype: note\ndescription: Step 1 memory sentinel\ntags: [step1]\n---\n\nOwner's Card ${H}.\n`,
          ],
        ] as const;
        for (const [file, content] of sentinels) {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, content);
        }
        const eventFile = join(app, "data/restart-hang-events.jsonl");
        const repliesFile = join(app, "data/restart-hang-replies.jsonl");
        const textOf = (file: string) => readFile(file, "utf8").catch(() => "");
        eve = startEve(app, env, port, note);
        await waitForHealth(port, eve);
        const sent = await post(port, bearer, "/restart-hang/send", {
          address: CONFIG.address,
          message: SEED,
        });
        assert.equal(sent.status, CONFIG.httpOK);
        const { sessionId } = (await sent.json()) as { sessionId: string };
        await until(
          async () => (await textOf(eventFile)).includes('"parked"'),
          "seed did not park",
        );
        assert.equal(
          requests.filter((request) =>
            JSON.stringify(request).includes(SUMMARY_PROMPT),
          ).length,
          CONFIG.emptyCount,
          "the old history was created before any summary",
        );

        phase = "crash";
        if (point === "before-summary" || point === "after-summary") {
          await writeFile(join(app, "data/restart-hang-barrier"), point);
        }
        if (point === "manual-compact") {
          const compact = await post(port, bearer, "/eve/v1/telegram/compact", {
            chatKey: CONFIG.chatKey,
            target: { sessionId },
          });
          assert.equal(compact.status, CONFIG.httpOK);
          const accepted = (await compact.json()) as { text: string };
          assert.match(accepted.text, /After a restart, repeat \/compact/u);
          logs.push(`manual acceptance: ${accepted.text}`);
        } else {
          const trigger = await post(port, bearer, "/restart-hang/send", {
            address: CONFIG.address,
            message: "TRIGGER_COMPACTION_STEP1",
          });
          assert.equal(trigger.status, CONFIG.httpOK);
        }
        if (point === "before-summary" || point === "after-summary") {
          await until(
            async () =>
              (await textOf(join(app, "data/restart-hang-blocked"))) === point,
            `barrier ${point} was not reached`,
          );
        } else {
          let blocked = false;
          void provider.blocked.then(() => {
            blocked = true;
          });
          await until(
            () => blocked,
            `provider barrier ${point} was not reached`,
          );
        }
        if (point === "after-snapshot") {
          assert.ok(
            snapshotWitness,
            "the next real model step read a persisted compacted snapshot",
          );
          assert.ok(
            snapshotWitness.messages.some(
              (message) => wireText(message.content) === SUMMARY,
            ),
          );
          assert.ok(
            snapshotWitness.messages.some(
              (message) =>
                message.role === "tool" &&
                wireText(message.content).includes("SNAPSHOT_WITNESS"),
            ),
            "the prior step finished its real tool call before persisting the snapshot",
          );
        }
        assert.equal(status.getChatStatus(CONFIG.chatKey)?.status, "running");
        assert.equal(
          status.getChatStatus(CONFIG.chatKey)?.sessionId,
          sessionId,
        );
        const summaryRequests = requests.filter((request) =>
          JSON.stringify(request).includes(SUMMARY_PROMPT),
        ).length;
        assert.equal(
          summaryRequests,
          point === "before-summary" ? CONFIG.emptyCount : CONFIG.singleCount,
        );
        assert.equal(
          (await textOf(repliesFile)).trim().split("\n").length,
          CONFIG.singleCount,
          "the interrupted turn has not delivered its final answer",
        );
        await queue.enqueueTelegramQueueUpdate(CONFIG.chatKey, {
          update_id: CONFIG.queueUpdateId,
          message: {
            message_id: CONFIG.queueUpdateId,
            date: CONFIG.messageDate,
            chat: { id: CONFIG.chatId, type: "private" },
            from: { id: CONFIG.ownerId, is_bot: false, first_name: "Owner" },
            text: B,
          },
        });
        assert.ok(
          JSON.stringify(
            (await queue.loadQueue({ strict: true })).queues[CONFIG.chatKey],
          ).includes(B),
        );

        logs.push(
          `SIGKILL ${point} pid=${String(eve.pid)} session=${sessionId}`,
        );
        await killEve(eve);
        const killSignal = eve.signalCode;
        assert.equal(killSignal, "SIGKILL");
        eve = null;
        await rm(join(app, "data/restart-hang-barrier"), { force: true });
        await runNode(
          [join(app, "scripts/recover-interrupted-turns.ts")],
          app,
          env,
          note,
        );
        const quarantines = (await readdir(join(app, ".eve"))).filter((file) =>
          file.includes(".workflow-data.trash-"),
        );
        phase = "probe";
        eve = startEve(app, env, port, note);
        await waitForHealth(port, eve);
        const notices: string[] = [];
        await queue.reapStaleRuns({
          sendImpl: (_key, text) => {
            notices.push(text);
            return Promise.resolve();
          },
          deleteMessageImpl: () => Promise.resolve(),
          logImpl: note,
        });
        assert.ok(
          JSON.stringify(
            (await queue.loadQueue({ strict: true })).queues[CONFIG.chatKey],
          ).includes(B),
          "B survived the real startup recovery",
        );
        const remaining = await routing.drainReadyQueueHeads({
          deliverImpl: async (update) =>
            (
              await post(port, bearer, "/restart-hang/send", {
                address: CONFIG.address,
                message: update.message?.text,
              })
            ).ok,
          settleUntil: new Map(),
          inFlight: new Map(),
          pins: new Map(),
        });
        await until(
          async () => (await textOf(repliesFile)).includes(`ANSWER ${B}`),
          "B did not receive its answer after restart",
        );
        assert.ok(probe, "the restarted runtime delivered B to the provider");
        const texts = probe.messages.map((message) =>
          wireText(message.content),
        );
        const history = {
          H: texts.some((text) => text.includes(H)),
          wholeOld:
            texts.some((text) => text.endsWith(SEED)) &&
            texts.includes(OLD_REPLY) &&
            !texts.includes(SUMMARY),
          wholeNew:
            texts.includes(SUMMARY) &&
            !texts.some((text) => text.endsWith(SEED)) &&
            !texts.includes(OLD_REPLY),
        };
        const historyPass = history.H && (history.wholeOld || history.wholeNew);
        const quarantine =
          logs.some((line) =>
            line.includes("retired workflow state after 1 interrupted turn(s)"),
          ) && quarantines.length > CONFIG.emptyCount;
        const memory = await Promise.all(
          sentinels.map(async ([file, content]) => ({
            file: file.slice(`${app}/`.length),
            intact: (await textOf(file)) === content,
          })),
        );
        const facts = {
          point,
          killSignal,
          summaryRequests,
          history,
          historyPass,
          quarantine,
          quarantines,
          B: { answered: true, remaining, notices },
          memory,
          snapshotWitness: Boolean(snapshotWitness),
        };
        row.diagnostic(JSON.stringify(facts));
        if (evidence) {
          await mkdir(join(evidence, point), { recursive: true });
          await writeFile(
            join(evidence, point, "facts.json"),
            `${JSON.stringify(facts, null, CONFIG.jsonIndent)}\n`,
          );
        }
        await row.test(
          "history is wholly old or new and retains H",
          {
            todo:
              !historyPass &&
              quarantine &&
              process.env.COMPACT_STEP1_STRICT !== CONFIG.enabledFlag
                ? "transition 17: startup quarantines the entire workflow store (wf-store.ts:242-268)"
                : false,
          },
          () => assert.ok(historyPass, JSON.stringify(history)),
        );
        await row.test("B is answered or explicitly asked to repeat", () => {
          assert.equal(remaining, CONFIG.emptyCount);
          assert.ok(texts.some((text) => text.includes(B)));
        });
        await row.test("diary and Cards survive byte for byte", () =>
          assert.ok(
            memory.every((file) => file.intact),
            JSON.stringify(memory),
          ),
        );
      });
    }
  },
);
