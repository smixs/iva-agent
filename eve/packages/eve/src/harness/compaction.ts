import { generateText, type LanguageModel, type ModelMessage, type TelemetryOptions } from "ai";

import {
  COMPACTION_CHECKPOINT_MARKER,
  COMPACTION_PROMPT_ENVELOPE,
  COMPACTION_RESUMPTION_MESSAGE,
  createCompactionPrompt,
  renderResumptionReplay,
  stubContentOutputFileParts,
  TODO_COMPACTION_PRESERVATION_LABEL,
  TRANSCRIPT_PAYLOAD_LIMIT,
} from "#harness/compaction-prompt.js";
import { estimateTokens } from "#harness/token-estimate.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { CompactionConfig, ToolLoopHarnessConfig } from "#harness/types.js";

/**
 * Element type of a non-string `ModelMessage.content` array.
 */
type ModelMessageContentPart = Exclude<ModelMessage["content"], string>[number];

// Static envelope estimate stays valid because createCompactionPrompt bounds
// its transcript to the caller's threshold budget, so the summarization call
// itself never grows past threshold + envelope + checkpoint.
const COMPACTION_PROMPT_OVERHEAD_TOKENS = estimateTokens([
  { content: COMPACTION_PROMPT_ENVELOPE.system, role: "system" },
  { content: COMPACTION_PROMPT_ENVELOPE.prompt, role: "user" },
] satisfies ModelMessage[]);

/**
 * Best available input-token count: the model-reported count from the last
 * step, plus a rough character-based estimate of whatever messages have been
 * appended since.
 */
export function getInputTokenCount(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
): number {
  const prior = config.lastKnownInputTokens;
  const priorCount = config.lastKnownPromptMessageCount;

  if (
    prior === undefined ||
    priorCount === undefined ||
    !Number.isInteger(priorCount) ||
    priorCount < 0 ||
    priorCount > messages.length
  ) {
    return estimateTokens(messages);
  }

  return prior + estimateTokens(messages.slice(priorCount));
}

/**
 * Returns true when the message history and fixed compaction-prompt envelope
 * exceed the compaction threshold.
 */
export function shouldCompact(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
): boolean {
  return (
    messages.length > 0 &&
    getInputTokenCount(messages, config) + COMPACTION_PROMPT_OVERHEAD_TOKENS > config.threshold
  );
}

/**
 * Resolves the model used to summarize older context during compaction.
 *
 * Reuses the active turn model when compaction should summarize with the same
 * reference, and resolves the authored compaction model only when configured.
 */
export async function resolveCompactionModel(input: {
  readonly compactionModelReference?: RuntimeModelReference;
  readonly model: LanguageModel;
  readonly modelReference: RuntimeModelReference;
  readonly resolveModel: ToolLoopHarnessConfig["resolveModel"];
}): Promise<{
  readonly model: LanguageModel;
  readonly providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
}> {
  const reference = input.compactionModelReference ?? input.modelReference;
  const model =
    reference === input.modelReference ? input.model : await input.resolveModel(reference);

  return {
    model,
    providerOptions: reference.providerOptions as Parameters<
      typeof generateText
    >[0]["providerOptions"],
  };
}

/** Conversation regions and config handed to each compaction heuristic. */
interface CompactionHeuristicInput {
  readonly config: CompactionConfig;
  readonly conversation: readonly ModelMessage[];
  readonly older: readonly ModelMessage[];
  readonly previousCheckpoint: string | undefined;
  readonly recent: readonly ModelMessage[];
}

/**
 * A heuristic either produces a complete replacement history that fits the
 * threshold, or signals that the next strategy must run. Heuristics have no
 * failure channel — anything exceptional throws.
 */
type CompactionHeuristicOutcome =
  | { readonly messages: ModelMessage[]; readonly type: "within-limit" }
  | { readonly type: "insufficient" };

type CompactionHeuristic = (input: CompactionHeuristicInput) => CompactionHeuristicOutcome;

/**
 * Model-free heuristics tried in order before falling back to LLM
 * summarization. Each is a pure transformation of the split conversation;
 * composing a new strategy (pruning variants, protect-lists) means adding an
 * entry here.
 */
const COMPACTION_HEURISTICS: readonly CompactionHeuristic[] = [toolResultCapHeuristic];

/**
 * Caps oversized tool-result outputs in the older region while every message
 * — including its tool calls and the recent tail — stays structurally
 * verbatim. Most history bulk is a handful of large tool outputs, so this
 * usually suffices with no model call and no rewriting.
 */
function toolResultCapHeuristic(input: CompactionHeuristicInput): CompactionHeuristicOutcome {
  const checkpointHead: ModelMessage[] =
    input.previousCheckpoint === undefined
      ? []
      : [
          { content: COMPACTION_CHECKPOINT_MARKER, role: "user" },
          { content: input.previousCheckpoint, role: "assistant" },
        ];
  const capped = withResumptionGuard(
    [...checkpointHead, ...capToolResults(input.older), ...input.recent],
    input.conversation,
  );

  // Evaluate on the same ruler shouldCompact uses (envelope included):
  // capping can be a near no-op when the older region holds few large
  // results, and accepting one on a looser ruler would let shouldCompact
  // re-fire every step without compaction ever making progress.
  const evaluation = evaluateThreshold(capped, input.config, "should-compact");
  return evaluation.type === "within-limit"
    ? { messages: capped, type: "within-limit" }
    : { type: "insufficient" };
}

/**
 * Measures a candidate history against the compaction threshold.
 * The "should-compact" ruler includes the fixed prompt-envelope overhead that
 * {@link shouldCompact} adds, so a history accepted on it cannot immediately
 * re-trigger compaction; "estimate" is the bare history size.
 */
function evaluateThreshold(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
  ruler: "estimate" | "should-compact",
): { readonly estimatedTokens: number; readonly type: "over-limit" | "within-limit" } {
  const overhead = ruler === "should-compact" ? COMPACTION_PROMPT_OVERHEAD_TOKENS : 0;
  const estimatedTokens = estimateTokens(messages) + overhead;
  return {
    estimatedTokens,
    type: estimatedTokens <= config.threshold ? "within-limit" : "over-limit",
  };
}

/**
 * Compacts messages by escalation: try each {@link CompactionHeuristic} in
 * order, then fall back to one summarization call over the older region —
 * keeping the recent tail verbatim when it fits, degrading it to text-only,
 * then shrinking the tail, all without further model calls.
 *
 * Returns `null` when the summary is rejected: it must be shorter than the
 * region it replaces and leave the rebuilt history under the threshold. The
 * caller then keeps the history unchanged and gates the next attempt on
 * input growth.
 */
export async function compactMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  config: CompactionConfig,
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"],
  telemetry?: TelemetryOptions,
  headers?: Record<string, string>,
  abortSignal?: AbortSignal,
): Promise<ModelMessage[] | null> {
  const { conversation, previousCheckpoint } = extractPreviousCheckpoint(messages);
  const recent = selectRecentWindow(conversation, config);
  const { older, recent: tail } = splitMessagesForCompaction(conversation, recent.length);

  if (older.length === 0 && previousCheckpoint === undefined) {
    return keepNonToolResultMessages(tail);
  }

  for (const heuristic of COMPACTION_HEURISTICS) {
    const outcome = heuristic({ config, conversation, older, previousCheckpoint, recent: tail });
    if (outcome.type === "within-limit") {
      return outcome.messages;
    }
  }

  const summaryPrompt = createCompactionPrompt({
    messages: older,
    previousCheckpoint,
    transcriptBudgetTokens: config.threshold,
  });

  const result = await generateText({
    abortSignal,
    headers,
    maxOutputTokens: config.summaryMaxOutputTokens,
    model,
    prompt: summaryPrompt.prompt,
    providerOptions,
    system: summaryPrompt.system,
    telemetry: telemetry ? { ...telemetry, functionId: "eve.compaction" } : undefined,
    temperature: 0,
  });

  const summaryHead: ModelMessage[] = [
    { content: COMPACTION_CHECKPOINT_MARKER, role: "user" },
    { content: result.text, role: "assistant" },
  ];

  // A summary that is not shorter than the region it replaces buys nothing:
  // keep the history and let the caller wait for the input to grow.
  if (estimateTokens(summaryHead) >= estimateTokens(older)) {
    return null;
  }

  // Prefer keeping the recent tail verbatim — surviving tool results are the
  // model's evidence that work already ran. Degrade to text-only, then drop
  // the oldest kept messages, only under threshold pressure. No new calls.
  let kept = tail;
  while (true) {
    const verbatim = withResumptionGuard([...summaryHead, ...kept], conversation);
    if (evaluateThreshold(verbatim, config, "estimate").type === "within-limit") {
      return verbatim;
    }

    const stripped = withResumptionGuard(
      [...summaryHead, ...keepNonToolResultMessages(kept)],
      conversation,
    );
    if (evaluateThreshold(stripped, config, "estimate").type === "within-limit") {
      return stripped;
    }

    if (kept.length === 0 || isRealUserMessage(kept[0])) {
      return null;
    }
    kept = kept.slice(1);
  }
}

const CAPPED_RESULT_ANNOTATION =
  "[Truncated by eve: tool result reduced during context compaction. Re-run the tool if you need the full output.]";

/**
 * Caps oversized tool-result outputs in place, keeping message structure and
 * tool_use/tool_result pairing untouched. The cap matches the transcript
 * payload clip, so a later summarization sees the same content the model
 * kept — capping never destroys material the summarizer would need, unlike
 * dropping results outright. The annotation leads the value so it survives
 * prefix-capped renderings.
 */
function capToolResults(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool" || typeof message.content === "string") {
      return message;
    }

    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") {
        return part;
      }
      // File parts of a content output reduce to their text stubs before the
      // size check: serializing raw payloads into a prefix cap would keep
      // bytes the model cannot read while cutting the text it can.
      const output = stubContentOutputFileParts(part.output) as typeof part.output;
      const serialized = JSON.stringify(output) ?? "";
      if (serialized.length <= TRANSCRIPT_PAYLOAD_LIMIT) {
        if (output === part.output) {
          return part;
        }
        changed = true;
        return { ...part, output };
      }

      changed = true;
      return {
        ...part,
        output: {
          type: "text" as const,
          value: `${CAPPED_RESULT_ANNOTATION}\n\n${serialized.slice(0, TRANSCRIPT_PAYLOAD_LIMIT)}`,
        },
      };
    });

    return changed ? { ...message, content } : message;
  });
}

/**
 * Providers that don't support assistant prefill reject a request that ends on
 * assistant content, so compaction must resume from a user turn. Rather than
 * a contentless synthetic prompt, replay the conversation's last real user
 * message when compaction folded it away — the model resumes against its
 * actual instruction, with the checkpoint as background. Falls back to
 * "Continue." when the last real user message still survives in the kept
 * messages (the model was mid-work on it) or none exists.
 */
function withResumptionGuard(
  messages: ModelMessage[],
  conversation: readonly ModelMessage[],
): ModelMessage[] {
  const lastRole = messages.at(-1)?.role;
  if (lastRole !== undefined && lastRole !== "assistant") {
    return messages;
  }

  const replay = findLastRealUserMessage(conversation);
  const alreadyKept = replay !== undefined && messages.includes(replay);

  return [
    ...messages,
    replay === undefined || alreadyKept
      ? { content: COMPACTION_RESUMPTION_MESSAGE, role: "user" }
      : { content: renderResumptionReplay(replay), role: "user" },
  ];
}

/**
 * Latest user message authored by the user rather than synthesized by the
 * framework (resumption prompts, checkpoint markers, and todo preservation
 * messages are all `role: "user"` but carry no user intent). Multipart
 * content only ever arrives from the user, so it always counts.
 */
function findLastRealUserMessage(conversation: readonly ModelMessage[]): ModelMessage | undefined {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (isRealUserMessage(message)) {
      return message;
    }
  }

  return undefined;
}

function isRealUserMessage(message: ModelMessage | undefined): boolean {
  if (message?.role !== "user") {
    return false;
  }
  if (typeof message.content !== "string") {
    return true;
  }
  return (
    message.content !== COMPACTION_RESUMPTION_MESSAGE &&
    message.content !== COMPACTION_CHECKPOINT_MARKER &&
    !message.content.startsWith(TODO_COMPACTION_PRESERVATION_LABEL)
  );
}

function extractPreviousCheckpoint(messages: readonly ModelMessage[]): {
  readonly conversation: ModelMessage[];
  readonly previousCheckpoint: string | undefined;
} {
  const marker = messages[0];
  const checkpoint = messages[1];
  if (
    marker?.role !== "user" ||
    marker.content !== COMPACTION_CHECKPOINT_MARKER ||
    checkpoint?.role !== "assistant"
  ) {
    return { conversation: [...messages], previousCheckpoint: undefined };
  }

  return {
    conversation: messages.slice(2),
    previousCheckpoint: assistantMessageText(checkpoint),
  };
}

/**
 * Returns the kept tail for a compacted history: recent messages with tool
 * activity removed. Tool-result messages are dropped, and assistant messages are
 * reduced to their text content (tool-call and reasoning parts stripped) so the
 * rebuilt history never carries a tool_use without its matching result.
 * Assistant messages with no remaining text are dropped; user messages are kept
 * verbatim.
 */
function keepNonToolResultMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  const kept: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "tool") {
      continue;
    }

    if (message.role === "assistant") {
      const text = assistantMessageText(message);
      if (text.length > 0) {
        kept.push({ content: text, role: "assistant" });
      }
      continue;
    }

    kept.push(message);
  }

  return kept;
}

/**
 * Concatenated text content of an assistant message, ignoring tool-call,
 * reasoning, and other non-text parts.
 */
function assistantMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }

  return message.content
    .filter(
      (part): part is Extract<ModelMessageContentPart, { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * Headroom the summary head takes on the {@link estimateTokens} ruler: the
 * checkpoint marker, the capped resumption replay, and JSON framing. A kept
 * tail must leave this much room under the threshold on top of the summary
 * itself (bounded by `summaryMaxOutputTokens`).
 */
const COMPACTION_HEAD_RESERVE_TOKENS = 1_024;

/**
 * Tokens the kept tail must leave for the summary head. The honest bound is
 * the summary cap plus fixed headroom; degenerate configs where that already
 * exceeds the threshold fall back to a quarter of it, so a small tail can
 * still be attempted — the fit loop then either accepts or rejects, it never
 * silently drops a real user message.
 */
function summaryHeadReserveTokens(config: CompactionConfig): number {
  return Math.min(
    config.summaryMaxOutputTokens + COMPACTION_HEAD_RESERVE_TOKENS,
    Math.max(64, Math.floor(config.threshold / 4)),
  );
}

/**
 * The verbatim tail kept through compaction: the newest messages fitting the
 * configured token budget. At least one message always lands in the older
 * region so there is something to compact; a tool call/result pair is never
 * split because the tail never opens with a bare result (see
 * {@link splitMessagesForCompaction}).
 *
 * The tail must also fit next to the summary head — whatever cannot is left
 * in the older region, so the summarizer sees every message the rebuilt
 * history might drop.
 */
function selectRecentWindow(
  messages: readonly ModelMessage[],
  config: CompactionConfig,
): ModelMessage[] {
  const maxKeep = Math.max(messages.length - 1, 0);
  const recent: ModelMessage[] = [];
  let recentTokens = 0;
  const headroom = config.threshold - summaryHeadReserveTokens(config);

  for (let index = messages.length - 1; index >= 0 && recent.length < maxKeep; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }

    const messageTokens = estimateTokens([message]);
    if (
      recentTokens + messageTokens > headroom ||
      (recent.length > 0 && recentTokens + messageTokens > config.recentWindowTokens)
    ) {
      break;
    }

    recent.unshift(message);
    recentTokens += messageTokens;
  }

  return recent;
}

function splitMessagesForCompaction(
  messages: readonly ModelMessage[],
  keep: number,
): {
  readonly older: ModelMessage[];
  readonly recent: ModelMessage[];
} {
  if (keep <= 0) {
    return {
      older: [...messages],
      recent: [],
    };
  }

  // The recent tail survives verbatim, so it must not open with tool results
  // whose tool calls fall in the older region — providers reject a tool_result
  // without its preceding tool_use. Snap such messages into the older region.
  let split = messages.length - keep;
  while (split < messages.length && messages[split]?.role === "tool") {
    split += 1;
  }

  return {
    older: messages.slice(0, split),
    recent: messages.slice(split),
  };
}
