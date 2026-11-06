/**
 * MCP proxy: держит один `stdio` MCP-сервер плагина и отдаёт его агенту по
 * streamable-http на loopback с bearer (ADR-0009, CONTEXT.md → MCP proxy).
 *
 * Половина серверов в дикой природе — stdio, а eve умеет ходить только по http.
 * Готовые прокси (`supergateway`, `mcp-proxy`) отвергнуты: чужой релиз-цикл и второй
 * рантайм ради одного процесса. Здесь ровно один процесс на один сервер, и его
 * жизненным циклом управляет systemd — падение ребёнка гасит и прокси
 * (`Restart=on-failure` поднимает пару заново).
 *
 * Пересылка — на уровне JSON-RPC сообщений, без единого пер-методного обработчика:
 * что бы ни добавили в протокол, оно пройдёт насквозь. Ядро (этот файл) не знает ни
 * про systemd, ни про аргументы командной строки: его запускает `serve.ts`, а тест
 * (`proxy.test.ts`) — тот же вызов из своего процесса.
 *
 * Env ребёнка — ТОЛЬКО `PATH`, `HOME`, `PLUGIN_ROOT`, `PLUGIN_DATA`, `<name>.env` и
 * `env` из `mcp.json` (ADR-0009 «Принятый риск»): токены Telegram и провайдера
 * MCP-серверу плагина не достаются, потому что их нет и в env самого прокси.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { readPluginEnv } from "#lib/plugin-config.ts";
import { expandPluginPlaceholders, readPlugin } from "#lib/plugin-reader.ts";
import { pluginDataDir, pluginRoot } from "#lib/plugin-store.ts";

/** Единственный путь MCP; всё остальное, кроме `/health`, — 404. */
const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";
/** Только loopback: прокси не публичный сервис и слушать больше негде. */
const HOST = "127.0.0.1";
/** Потолок тела запроса: аргументы тула, а не файловый поток. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

type ProxySpec = {
  /** Имя плагина: и запись в `plugins.json`, и папка в Custom layer. */
  readonly plugin: string;
  /** Имя сервера в `mcp.json` этого плагина. */
  readonly server: string;
  readonly port: number;
  /** Bearer, который обязан прислать агент. Пустой токен не принимается. */
  readonly token: string;
  /** Каталог данных Ивы: из него берутся и плагин, и его env. */
  readonly dataDir: string;
  readonly log?: (message: string) => void;
};

export type RunningProxy = {
  /** Порт, на котором прокси реально слушает (0 в запросе = порт от ядра). */
  readonly port: number;
  /** Почему ушёл дочерний процесс. Живой прокси этот promise не разрешает. */
  readonly childGone: Promise<string>;
  readonly close: () => Promise<void>;
};

/** Env дочернего процесса: закрытый список, собранный из файлов плагина. */
function childEnvironment({
  declared,
  fromEnvFile,
  paths,
  inherited,
}: {
  /** `env` из `mcp.json`, плейсхолдеры уже раскрыты. */
  readonly declared: Readonly<Record<string, string>>;
  /** Переменные из `data/custom/plugins/<name>.env`. */
  readonly fromEnvFile: Readonly<Record<string, string>>;
  readonly paths: { readonly root: string; readonly data: string };
  /** `PATH` и `HOME` процесса прокси: без них не запустится почти ничто. */
  readonly inherited: Readonly<Record<string, string | undefined>>;
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  // Транспорт SDK подмешивает под наш набор `getDefaultEnvironment()` — HOME, LOGNAME,
  // PATH, SHELL, TERM, USER из env прокси. Всё, что он мог бы унести, перечислено
  // здесь явно как `undefined`: такие ключи Node в дочерний процесс не передаёт, и
  // «только свой env» остаётся правдой, а не намерением.
  for (const key of DEFAULT_INHERITED_ENV_VARS) env[key] = undefined;
  if (inherited.PATH) env.PATH = inherited.PATH;
  if (inherited.HOME) env.HOME = inherited.HOME;
  // Порядок: секреты владельца, поверх них объявления автора, поверх всего — пути,
  // которые задаёт клиент (спека §9.1; их подмену ридер и так отвергает).
  for (const [key, value] of Object.entries(fromEnvFile)) env[key] = value;
  for (const [key, value] of Object.entries(declared)) env[key] = value;
  env.PLUGIN_ROOT = paths.root;
  env.PLUGIN_DATA = paths.data;
  return env;
}

/** Сравнение токенов без утечки по времени; разная длина — просто «нет». */
function sameToken(given: string, expected: string): boolean {
  const one = Buffer.from(given);
  const other = Buffer.from(expected);
  return one.length === other.length && timingSafeEqual(one, other);
}

function bearerOf(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer[ \t]+(.+)$/u.exec(header.trim());
  return match ? match[1].trim() : "";
}

/** Ответ в форме JSON-RPC — той же, в какой отвечает транспорт SDK. */
function jsonRpcError(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, { "content-type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/** Тело POST — один раз и с потолком: агент шлёт JSON, а не поток без конца. */
async function readJsonBody(
  request: IncomingMessage,
): Promise<{ readonly value: unknown; readonly problem: string | null }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES)
      return {
        value: null,
        problem: `the request body is larger than ${MAX_BODY_BYTES} bytes`,
      };
    chunks.push(buffer);
  }
  try {
    return {
      value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      problem: null,
    };
  } catch (error) {
    return {
      value: null,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Поднять прокси: дочерний stdio-сервер, HTTP-сервер и пересылка между ними.
 * Кидает, если плагин, сервер или его тип не те: чинить это владельцу, и systemd
 * должен показать причину в журнале, а не рестартовать вечно молча.
 */
export async function startMcpProxy(spec: ProxySpec): Promise<RunningProxy> {
  const log = spec.log ?? ((message: string) => console.log(message));
  if (!spec.token)
    throw new Error("the MCP proxy refuses to run without a token");
  const root = pluginRoot(spec.dataDir, spec.plugin);
  const data = pluginDataDir(spec.dataDir, spec.plugin);
  const report = await readPlugin(root);
  if (!report.manifest)
    throw new Error(
      `${root} is not a usable plugin: ${report.diagnostics.at(-1) ?? "no reason given"}`,
    );
  const declaredServer = report.mcp[spec.server];
  if (!declaredServer)
    throw new Error(
      `the plugin ${spec.plugin} declares no MCP server ${JSON.stringify(spec.server)}`,
    );
  if (declaredServer.type !== "stdio")
    throw new Error(
      `the MCP server ${JSON.stringify(spec.server)} is ${declaredServer.type}; only stdio needs a proxy`,
    );

  const paths = { root, data };
  const expand = (value: string): string =>
    expandPluginPlaceholders(value, paths);
  // `./`-команда — файл внутри плагина, и запускается она по абсолютному пути:
  // относительный разрешался бы от cwd, который автор мог направить в PLUGIN_DATA.
  const command = declaredServer.command.startsWith("./")
    ? join(root, declaredServer.command.slice(2))
    : declaredServer.command;
  const args = (declaredServer.args ?? []).map(expand);
  const declared: Record<string, string> = {};
  for (const [key, value] of Object.entries(declaredServer.env ?? {}))
    declared[key] = expand(value);
  const cwd = declaredServer.cwd ? expand(declaredServer.cwd) : root;
  const environment = childEnvironment({
    declared,
    // Тот же ридер, что у connection-файлов: один разбор `<name>.env` на всю Иву.
    fromEnvFile: readPluginEnv(spec.plugin, spec.dataDir),
    paths,
    inherited: { PATH: process.env.PATH, HOME: process.env.HOME },
  });

  const child = new StdioClientTransport({
    command,
    args,
    // Node роняет ключи со значением `undefined`, поэтому список SDK здесь и гаснет.
    env: environment as Record<string, string>,
    cwd: isAbsolute(cwd) ? cwd : resolve(root, cwd),
    // Журнал сервера уходит в journalctl того же юнита: одно место, где смотреть.
    stderr: "inherit",
  });
  let gone: (why: string) => void = () => {};
  const childGone = new Promise<string>((settle) => {
    gone = settle;
  });

  const complain = (what: string) => (error: unknown) =>
    log(`${what}: ${error instanceof Error ? error.message : String(error)}`);

  /**
   * Сессия агента. Одна за раз: за портом стоит ОДИН дочерний процесс, и делить его
   * между двумя сессиями значило бы разводить их ответы по чужим id. Новая сессия
   * (агент перезапустился, у него новый MCP-клиент) забирает ребёнка себе, старая
   * закрывается — так рестарт агента не требует рестарта прокси.
   *
   * Транспорт SDK 1.30.0 в stateless-режиме одноразовый (`Stateless transport cannot
   * be reused across requests`), поэтому режим здесь только сессионный.
   */
  let session: StreamableHTTPServerTransport | null = null;

  async function openSession(): Promise<StreamableHTTPServerTransport> {
    const previous = session;
    const http = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    http.onmessage = (message: JSONRPCMessage) => {
      void child
        .send(message)
        .catch(complain("the MCP server took no message"));
    };
    http.onerror = (error) => log(`http transport: ${error.message}`);
    await http.start();
    session = http;
    if (previous)
      await previous.close().catch(complain("closing the old session"));
    return http;
  }

  child.onmessage = (message: JSONRPCMessage) => {
    void session?.send(message).catch(complain("the agent took no reply"));
  };
  child.onerror = (error) => log(`stdio transport: ${error.message}`);
  child.onclose = () => gone(`the MCP server ${spec.server} exited`);

  await child.start();

  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const path = (request.url ?? "/").split("?")[0];
      // `/health` без bearer: это ответ на вопрос «жив ли юнит», а не доступ к серверу.
      if (path === HEALTH_PATH && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (path !== MCP_PATH) {
        response.writeHead(404).end();
        return;
      }
      if (!sameToken(bearerOf(request), spec.token)) {
        // Тело без деталей: чем именно не понравился токен, знать незачем.
        response
          .writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": "Bearer",
          })
          .end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      // Обёртка ловит и синхронный бросок транспорта: без неё он уходит в
      // необработанное исключение сервера, и агент получает пустой 500 без причины.
      void (async () => {
        try {
          if (request.method !== "POST") {
            // GET — поток уведомлений сервера, DELETE — конец сессии: и то и другое
            // принадлежит открытой сессии, а не открывает её.
            if (!session) {
              jsonRpcError(
                response,
                400,
                "Bad Request: Server not initialized",
              );
              return;
            }
            await session.handleRequest(request, response);
            return;
          }
          // `initialize` открывает сессию, всё остальное идёт в открытую. Тело читается
          // здесь один раз и передаётся транспорту разобранным: второй раз поток не
          // прочитать, а решать по заголовку нельзя — POST без `Mcp-Session-Id` от
          // клиента, который его потерял, уносил бы живую сессию.
          const body = await readJsonBody(request);
          if (body.problem !== null) {
            jsonRpcError(response, 400, `Parse error: ${body.problem}`);
            return;
          }
          const initializing = Array.isArray(body.value)
            ? body.value.some(isInitializeRequest)
            : isInitializeRequest(body.value);
          const http = initializing ? await openSession() : session;
          if (!http) {
            jsonRpcError(response, 400, "Bad Request: Server not initialized");
            return;
          }
          await http.handleRequest(request, response, body.value);
        } catch (error) {
          log(
            `request failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (!response.headersSent) response.writeHead(500).end();
        }
      })();
    },
  );

  const port = await new Promise<number>((settle, fail) => {
    server.once("error", fail);
    server.listen(spec.port, HOST, () => {
      const address = server.address();
      settle(typeof address === "object" && address ? address.port : spec.port);
    });
  });

  return {
    port,
    childGone,
    close: async () => {
      child.onclose = undefined;
      const closed = new Promise<void>((settle) =>
        server.close(() => settle()),
      );
      // Поток SSE держится открытым по замыслу, а `close()` ждёт все соединения:
      // без этой строки остановка юнита висела бы до таймаута systemd.
      server.closeAllConnections();
      await closed;
      await session?.close().catch(() => {});
      await child.close().catch(() => {});
    },
  };
}
