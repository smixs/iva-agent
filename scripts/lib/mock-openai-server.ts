// Общий HTTP-провайдер для герметичных смоуков и тестов.
// Поднимает локальный http-сервер с единственным эндпоинтом POST /v1/chat/completions
// и отвечает по сценарию, завязанному на текст последнего user-сообщения, — так смоук
// проверяет полный путь build → eve → провайдер без сети и настоящей модели.
// Идея — reference-реализация из stabilization-форка mamysh/iva (PR #7), переписана
// под upstream с нуля.
import { createServer, type IncomingMessage } from "node:http";
import { text as consumeText } from "node:stream/consumers";
import { isRecord } from "../../packages/guards/index.ts";

const MODEL = "iva-smoke";

function stringifyContentPart(value: unknown): string {
  if (value == null) return "";
  // The mock deliberately mirrors OpenAI content coercion for malformed fixture parts.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

function partText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        return isRecord(part) ? stringifyContentPart(part.text) : "";
      })
      .join(" ");
  }
  return "";
}

function transcriptText(messages: unknown[]): string {
  return messages
    .map((message) => partText(isRecord(message) ? message.content : undefined))
    .join("\n");
}

function lastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isRecord(message) && message.role === "user") {
      return partText(message.content);
    }
  }
  return "";
}

// Сценарий: маркер CEDAR-#### сеется фразой "Remember this code", а после рестарта
// eve должен реплеить историю целиком — тогда маркер найдётся в транскрипте и вернётся
// в ответе. Так restart/resume проверяется без настоящей памяти модели.
function chooseResponse(body: unknown): string {
  const messages =
    isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  const last = lastUserText(messages);
  if (/What code did I ask you to remember/i.test(last)) {
    const match = transcriptText(messages).match(/CEDAR-\d+/);
    return match ? match[0] : "MISSING_MARKER";
  }
  if (/Remember this code/i.test(last)) return "REMEMBERED";
  return "REPLICA_OK";
}

function completionJson(text: string) {
  return {
    id: "chatcmpl-smoke",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  };
}

function streamChunks(text: string) {
  const base = {
    id: "chatcmpl-smoke",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
  };
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    {
      ...base,
      choices: [],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    },
  ];
}

async function readBody(req: IncomingMessage): Promise<string> {
  return consumeText(req);
}

export type MockStep =
  | { kind: "text"; text: string; waitFor?: Promise<void> }
  | { kind: "tool"; name: string; arguments: string; id?: string }
  | { kind: "overloaded"; times?: number }
  | { kind: "empty" }
  | { kind: "disconnect" };

export type MockRequest = { method: string; path: string; raw: string };

export type MockOpenAiServer = {
  baseUrl: string;
  requests: unknown[];
  wireRequests: MockRequest[];
  enqueue(...steps: MockStep[]): void;
  close(): Promise<void>;
};

/** Стартует mock-провайдер на 127.0.0.1:0; handle: { baseUrl, requests, close }. */
export async function startMockOpenAiServer(
  steps: MockStep[] = [],
  record?: (request: MockRequest) => void,
): Promise<MockOpenAiServer> {
  const scenario = steps.map((step) => ({ ...step }));
  const requests: unknown[] = [];
  const wireRequests: MockRequest[] = [];
  // Node does not consume the request handler's promise; response completion is handled inside it.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const recorded = { method: req.method ?? "", path: req.url ?? "", raw };
    wireRequests.push(recorded);
    record?.(recorded);
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: `no route: ${req.method} ${req.url}` },
        }),
      );
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
      return;
    }
    requests.push(body);
    const step = scenario[0];
    if (step?.kind === "overloaded" && (step.times ?? 1) > 1)
      step.times = (step.times ?? 1) - 1;
    else scenario.shift();
    if (step?.kind === "text") await step.waitFor;
    if (step?.kind === "overloaded") {
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "0",
      });
      res.end(
        JSON.stringify({
          error: { message: "overloaded", type: "overloaded_error" },
        }),
      );
      return;
    }
    const text =
      step?.kind === "text" ? step.text : step ? "" : chooseResponse(body);
    const tool =
      step?.kind === "tool"
        ? {
            id: step.id ?? "smoke-call",
            type: "function",
            function: { name: step.name, arguments: step.arguments },
          }
        : undefined;
    if (isRecord(body) && body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (step?.kind === "disconnect") {
        res.write(`data: ${JSON.stringify(streamChunks("partial")[0])}\n\n`);
        setImmediate(() => res.destroy());
        return;
      }
      const chunks = streamChunks(text);
      if (tool) {
        Object.assign(chunks[0].choices[0].delta, {
          tool_calls: [{ index: 0, ...tool }],
        });
        chunks[1].choices[0].finish_reason = "tool_calls";
      }
      for (const chunk of chunks)
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      const completion = completionJson(text);
      if (tool) {
        Object.assign(completion.choices[0].message, { tool_calls: [tool] });
        completion.choices[0].finish_reason = "tool_calls";
      }
      if (step?.kind === "disconnect") {
        res.destroy();
        return;
      }
      res.end(JSON.stringify(completion));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock OpenAI server did not bind to a TCP port");
  }
  const { port } = address;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    wireRequests,
    enqueue: (...steps) => {
      scenario.push(...steps.map((step) => ({ ...step })));
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
