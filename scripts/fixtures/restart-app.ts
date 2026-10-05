// Общие помощники тестов перезапуска на настоящем процессе eve: провайдер-двойник, который
// замирает на заданном запросе до перезапуска, окружение одноразового приложения, POST и kill.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { EveProcess } from "../lib/eve-app.ts";

function completion(text: string): string {
  const chunk = (content: string, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-restart",
      object: "chat.completion.chunk",
      created: 1,
      model: "iva-restart",
      choices: [
        {
          index: 0,
          delta: content ? { content } : {},
          finish_reason: finishReason,
        },
      ],
    })}\n\n`;
  return `${chunk(text, null)}${chunk("", "stop")}data: [DONE]\n\n`;
}

// blockOn — текст в запросе к модели, на котором провайдер замирает до перезапуска: сам ход
// (сообщение владельца) или пересказ истории (начало system-промпта компактации eve).
export async function startProvider(blockOn = "BLOCK_UNTIL_RESTART"): Promise<{
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
      if (body.includes(blockOn)) {
        markBlocked();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(completion("RECOVERED"));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    blocked,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function envFor(
  sandbox: string,
  app: string,
  port: number,
  baseUrl: string,
  bearer: string,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: sandbox,
    NODE_ENV: "production",
    PORT: String(port),
    IVA_PORT: String(port),
    MODEL_PROVIDER: "ollama",
    OLLAMA_BASE_URL: baseUrl,
    OLLAMA_API_KEY: "restart-test-key",
    OLLAMA_MODEL: "iva-restart",
    OLLAMA_CONTEXT_WINDOW: "131072",
    ASSISTANT_BEARER: bearer,
    ASSISTANT_DATA_DIR: join(app, "data"),
    ASSISTANT_VAULT_DIR: join(app, "vault"),
    ASSISTANT_TIMEZONE: "UTC",
    MEMORY_SEARCH_MODE: "bm25",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "restart-test-secret",
  };
}

export async function post(
  port: number,
  bearer: string,
  path: string,
  body: unknown,
  timeoutMs = 10_000,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "restart-test-secret",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function killEve(child: EveProcess): Promise<void> {
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  process.kill(-(child.pid as number), "SIGKILL");
  await exited;
}
