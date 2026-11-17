/* eslint-disable @typescript-eslint/require-await -- SDK boundary doubles. */
import "../lib/ts-esm-hooks.ts";
import { APICallError, wrapLanguageModel } from "ai";
import { makeTextModel } from "../../agent/provider.ts";
import hook from "../../agent/hooks/usage.ts";
import { eveInternals } from "./helper-turn.test-fixture.ts";
import { formatLanguageModelGatewayId } from "../../node_modules/eve/dist/src/internal/runtime-model.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function usageProbe() {
  const eve = await eveInternals();
  const ctx = new eve.ContextContainer();
  const turnKind =
    process.env.PROBE_TURN ?? (process.env.PROBE_HELPER ? "helper" : undefined);
  const owner = {
    session: {
      id: "usage-r2",
      turn: { id: "turn_0", sequence: 0 },
      auth: {
        initiator: {
          authenticator: "iva-bearer",
          attributes: turnKind ? { iva_turn: turnKind } : {},
        },
      },
    },
    channel: { kind: "http" },
  };
  const { stepModelChoice } = await import("../../agent/agent.ts");
  const choice =
    typeof stepModelChoice === "function"
      ? stepModelChoice(owner)
      : { model: undefined };
  const models: string[] = [];
  const events: { type: string; data?: unknown }[] = [];
  const dispatch = async (event: { type: string; data?: unknown }) => {
    const fn = (
      hook.events as Record<
        string,
        ((e: unknown, c: unknown) => unknown) | undefined
      >
    )[event.type];
    await fn?.(event, owner);
  };
  for (const kind of ["root", "declared", "inline", "failure"]) {
    const bare =
      kind === "root" || kind === "failure"
        ? makeTextModel({
            model: choice.model,
            chatModelSeesImages: async () => false,
          })
        : makeTextModel({
            chatModelSeesImages: async () => false,
          });
    models.push(bare.modelId);
    const model = wrapLanguageModel({
      model: bare,
      middleware: {
        specificationVersion: "v4",
        wrapStream: async () => {
          if (kind === "failure")
            throw new APICallError({
              message: "fixture failure",
              url: "https://fixture.invalid",
              requestBodyValues: {},
              statusCode: 401,
              isRetryable: false,
            });
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: "stream-start", warnings: [] });
                c.enqueue({ type: "text-start", id: "t" });
                c.enqueue({ type: "text-delta", id: "t", delta: "done" });
                c.enqueue({ type: "text-end", id: "t" });
                c.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop", raw: "stop" },
                  usage: {
                    inputTokens: {
                      total: 10,
                      noCache: 10,
                      cacheRead: 0,
                      cacheWrite: 0,
                    },
                    outputTokens: { total: 2, text: 2, reasoning: 0 },
                  },
                });
                c.close();
              },
            }),
          };
        },
      },
    });
    const run = eve.createToolLoopHarness({
      mode: "task",
      tools: new Map(),
      resolveModel: async () => model,
      handleEvent: async (event) => {
        events.push(event);
        if (kind === "inline")
          await hook.events!["subagent.event"]!(
            { data: { subagentName: "declared", event } } as never,
            owner as never,
          );
        else await dispatch(event);
        if (event.type === "step.completed") {
          // Replayed completion must carry its own model on every delivery.
          if (kind === "inline")
            await hook.events!["subagent.event"]!(
              { data: { subagentName: "declared", event } } as never,
              owner as never,
            );
          else await dispatch(event);
        }
      },
    });
    await eve.contextStorage.run(ctx, () =>
      run(
        {
          agent: {
            modelReference: { id: formatLanguageModelGatewayId(bare) },
            system: "",
            tools: [],
          },
          compaction: { threshold: 100000, recentWindowTokens: 1, summaryMaxOutputTokens: 400 },
          continuationToken: "fixture",
          sessionId: kind,
          history: [],
        },
        { message: "hello" },
      ),
    );
  }
  await dispatch({
    type: "step.completed",
    data: {
      stepIndex: 0,
      turnId: "turn_0",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  });
  const rows = (
    await readFile(join(process.env.ASSISTANT_DATA_DIR!, "usage.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s) as { model: string });
  return { models, events, rows, handlers: Object.keys(hook.events!) };
}

/** Snapshot command, in a 21f447ed archive with iva.1 and these two current fixtures:
 * node --input-type=module -e "import './scripts/lib/ts-esm-hooks.ts'; const {existingUsageProbe}=await import('./scripts/fixtures/helper-usage-r2.test-fixture.ts'); console.log(JSON.stringify(await existingUsageProbe()));"
 * Set each provider's fixture model and ASSISTANT_DATA_DIR to a temporary empty directory.
 */
export async function existingUsageProbe() {
  const result: Record<string, string[]> = {};
  for (const kind of [
    "chat",
    "reminder",
    "signal",
    "watch",
    "brief",
    "insight",
    "alert",
  ]) {
    await writeFile(join(process.env.ASSISTANT_DATA_DIR!, "usage.jsonl"), "");
    process.env.PROBE_TURN = kind;
    result[kind] = (await usageProbe()).rows.map((row) => row.model);
  }
  return result;
}
