// Mock OpenAI-совместимый провайдер для replica-смоука (scripts/replica-smoke.ts).
// Поднимает локальный http-сервер с единственным эндпоинтом POST /v1/chat/completions
// и отвечает по сценарию, завязанному на текст последнего user-сообщения, — так смоук
// проверяет полный путь build → eve → провайдер без сети и настоящей модели.
// Идея — reference-реализация из stabilization-форка mamysh/iva (PR #7), переписана
// под upstream с нуля.
import { createServer, type IncomingMessage } from "node:http";
import { text as consumeText } from "node:stream/consumers";
import { isRecord } from "../../packages/guards/index.ts";

const MODEL = "iva-replica";

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
    id: "chatcmpl-replica",
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
    id: "chatcmpl-replica",
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

export type MockOpenAiServer = {
  baseUrl: string;
  requests: unknown[];
  close(): Promise<void>;
};

/** Стартует mock-провайдер на 127.0.0.1:0; handle: { baseUrl, requests, close }. */
export async function startMockOpenAiServer(): Promise<MockOpenAiServer> {
  const requests: unknown[] = [];
  // Node does not consume the request handler's promise; response completion is handled inside it.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = createServer(async (req, res) => {
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
      body = JSON.parse(await readBody(req)) as unknown;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
      return;
    }
    requests.push(body);
    const text = chooseResponse(body);
    if (isRecord(body) && body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const chunk of streamChunks(text))
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completionJson(text)));
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
