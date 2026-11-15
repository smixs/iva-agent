// Реле допуска для вендора claude: локальный loopback-сервер, через который идёт ОДИН запрос
// `/v1/messages` к api.anthropic.com, а второй и следующие получают 400.
//
// Зачем: Claude Code CLI сам решает, что после ответа модели нужен ещё один запрос (у Fable
// на подписке это второй поход за 57 − 25 output-токенов, см. пробник
// .scratch/work/probes/claude-cli/probe.mjs). Ход eve — это РОВНО один шаг на один запрос к
// api.anthropic.com (планка T53 п.1), а инструменты и продолжение хода держит eve, не CLI.
// Пропустив первый запрос и отказав второму, реле делает и то и другое: ответ модели (в том
// числе tool_use) возвращается CLI как есть, а его собственная попытка продолжить ход упирается
// в 400 и не тратит ни запроса, ни денег.
//
// Второе: первый ответ ЗАПОМНЕН целиком — из него берутся блоки (text/thinking/tool_use) и
// расход. CLI печатает и свой `assistant`, но он может прийти обрезанным или с чужой попыткой
// продолжить; блоки и usage из настоящего ответа ближе к правде, чем рассказ о нём.
//
// Авторизацию CLI реле не смотрит и не хранит: заголовки пересылаются как есть (кроме
// hop-by-hop, перечисленных в HOP_BY_HOP), и ни один заголовок не попадает в журнал —
// в `Authorization` едет подписочный токен владельца.

import { randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../packages/guards/index.ts";

/** Блок ответа модели в форме Anthropic Messages API — как он пришёл от api.anthropic.com. */
export type NativeBlock = Record<string, unknown> & { type: string };

/** Ответ модели целиком: то, что eve считает содержимым шага. */
export type NativeMessage = {
  content: NativeBlock[];
  stop_reason?: string | null;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
};

type BlockPosition = {
  readonly message: number;
  readonly block: number;
  readonly value: Record<string, unknown>;
};
const UNCACHEABLE_BLOCKS = new Set(["thinking", "redacted_thinking"]);
function withoutCacheControl(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const plain = { ...value };
  delete plain.cache_control;
  return plain;
}
function messageBlocks(messages: readonly unknown[]): BlockPosition[] {
  const blocks: BlockPosition[] = [];
  for (const [message, candidate] of messages.entries()) {
    if (!isRecord(candidate) || !Array.isArray(candidate.content)) continue;
    for (const [block, value] of candidate.content.entries()) {
      if (isRecord(value)) blocks.push({ message, block, value });
    }
  }
  return blocks;
}
function matchingUserPrefix(
  value: unknown,
  queried: readonly NativeBlock[],
  message: number,
): BlockPosition[] {
  if (
    !isRecord(value) ||
    value.role !== "user" ||
    !Array.isArray(value.content)
  )
    return [];
  const content: unknown[] = value.content;
  const prefix: BlockPosition[] = [];
  let matched = 0;
  const compared = Math.min(content.length, queried.length);
  for (let block = 0; block < compared; block += 1) {
    const sent: unknown = content[block];
    if (
      !isDeepStrictEqual(
        withoutCacheControl(sent),
        withoutCacheControl(queried[block]),
      )
    )
      break;
    matched = block + 1;
    if (isRecord(sent)) prefix.push({ message, block, value: sent });
  }
  const firstChanged: unknown = content[matched];
  if (isRecord(firstChanged) && firstChanged.type === "tool_result") return [];
  return prefix;
}
function stableTarget(
  messages: readonly unknown[],
  blocks: readonly BlockPosition[],
  queried: readonly NativeBlock[],
): BlockPosition | undefined {
  const lastAssistant = messages.reduce<number>(
    (last, message, index) =>
      isRecord(message) && message.role === "assistant" ? index : last,
    -1,
  );
  const stable = blocks.filter(({ message }) => message <= lastAssistant);
  const newest = messages[lastAssistant + 1];
  stable.push(...matchingUserPrefix(newest, queried, lastAssistant + 1));
  return [...stable]
    .reverse()
    .find(({ value }) => !UNCACHEABLE_BLOCKS.has(String(value.type)));
}
const earlier = (target: BlockPosition, source: BlockPosition): boolean =>
  target.message < source.message ||
  (target.message === source.message && target.block < source.block);
/** Перенос message-метки на стабильный префикс; источник: Hermes plugin, MIT. */
export function pinMessageBreakpoint(
  payload: Buffer,
  queried: readonly NativeBlock[] | undefined,
): Buffer {
  if (queried === undefined || queried.length === 0) return payload;
  try {
    const body = JSON.parse(payload.toString("utf8")) as unknown;
    if (!isRecord(body) || !Array.isArray(body.messages)) return payload;
    const messages: unknown[] = body.messages;
    const blocks = messageBlocks(messages);
    const marked = blocks.filter(({ value }) => "cache_control" in value);
    if (marked.length !== 1) return payload;
    const target = stableTarget(messages, blocks, queried);
    const source = marked[0];
    if (target === undefined || source === undefined) return payload;
    if (!earlier(target, source)) return payload;
    const marker = source.value.cache_control;
    delete source.value.cache_control;
    target.value.cache_control = marker;
    return Buffer.from(JSON.stringify(body));
  } catch {
    return payload;
  }
}

/** Что реле успело собрать из ответа: незавершённый (обрыв, ошибка) ответ не считается. */
type AdmissionCapture = {
  readonly message: NativeMessage | null;
  readonly complete: boolean;
};

/** Сокет, который можно оборвать: и клиентский, и наш поход наружу. */
type Closable = { destroy: () => void };

export type Admission = {
  /** Адрес для ANTHROPIC_BASE_URL: loopback, случайный порт, случайный префикс пути. */
  readonly url: string;
  /** Запрос уже был: второй получит 400. */
  readonly used: boolean;
  /** Сколько запросов отбито после первого. */
  readonly denied: number;
  /** HTTP-статус ответа api.anthropic.com; undefined — до ответа не дошло. */
  readonly status: number | undefined;
  readonly capture: AdmissionCapture;
  /** Рвёт оба сокета: ход отменён или упал таймаут. */
  abort(): void;
  /** Закрывает сервер; зовётся в finally, всегда. */
  close(): Promise<void>;
};

/** Событие SSE из строки `data:`: null — не JSON и не объект, такие пропускаем. */
function parseSse(data: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/** Чужой JSON: дальше по коду обращаемся к полям события только через эту проверку. */

/** Строковое поле чужого JSON: не строка — пустая строка, а не «[object Object]». */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Заголовки, которые принадлежат соединению, а не запросу: их пересылать нельзя.
 * `content-length` вырезан, но не теряется: тело реле читает целиком (`forward`) и отдаёт одним
 * куском, поэтому длину считает заново уже клиент http — тест это сверяет с прочитанным телом.
 * Так что наружу уходит то же тело с той же длиной, а не разметка CLI.
 */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "proxy-authorization",
  "proxy-connection",
]);

/** Заголовки ответа, которые ставит наш сервер: чужие версии того же поля врут клиенту. */
const SERVER_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "server",
  "date",
]);

/**
 * Имя отказа реле. Его печатает CLI, когда реле отбило второй запрос: по нему шаг отличает
 * свой отказ от причины, по которой ответ оборвался.
 */
export const ADMISSION_CONSUMED = "IVA_MODEL_ADMISSION_CONSUMED";

const DENIED_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: ADMISSION_CONSUMED,
  },
});

/**
 * Собирает ответ из SSE-потока Anthropic. Хранит сообщение целиком, поэтому реле не зависит
 * от того, что CLI успел напечатать: `input_json_delta` склеивается в `input` на
 * `content_block_stop`, а `message_stop` с непустым `stop_reason` и без недоклеенных
 * аргументов — единственный признак целого ответа.
 */
class SseCapture {
  message: NativeMessage | null = null;
  complete = false;
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");
  private readonly args = new Map<number, string>();

  feed(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    for (;;) {
      const end = /\r?\n\r?\n/u.exec(this.pending);
      if (end === null) return;
      const frame = this.pending.slice(0, end.index);
      this.pending = this.pending.slice(end.index + end[0].length);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /u, ""))
        .join("\n");
      if (data.length > 0) this.event(data);
    }
  }

  // Разбор одного события: неизвестные типы молча пропускаются — их у Anthropic больше, чем
  // нам нужно, и падать на новом (например, на `ping`) значило бы ломать ход из-за чужих правок.
  private event(data: string): void {
    const event = parseSse(data);
    if (event === null) return;
    const type = text(event.type);
    if (type === "message_start") {
      this.messageStart(event);
      return;
    }
    if (this.message === null) return;
    const index = typeof event.index === "number" ? event.index : 0;
    if (type === "content_block_start") this.blockStart(event, index);
    else if (type === "content_block_delta") this.blockDelta(event, index);
    else if (type === "content_block_stop") this.blockStop(index);
    else if (type === "message_delta") this.messageDelta(event);
    else if (type === "message_stop") this.messageStop();
  }

  /** Начало ответа: пустое содержимое и входные токены — из них складывается расход шага. */
  private messageStart(event: Record<string, unknown>): void {
    const message = event.message;
    if (!isRecord(message)) {
      this.message = null;
      return;
    }
    const usage = isRecord(message.usage) ? message.usage : {};
    this.message = {
      ...(message as NativeMessage),
      content: [],
      usage: { ...usage },
    };
  }

  private blockStart(event: Record<string, unknown>, index: number): void {
    if (this.message === null) return;
    const block = event.content_block as NativeBlock | undefined;
    if (block === undefined) return;
    this.message.content[index] = { ...block };
  }

  private blockDelta(event: Record<string, unknown>, index: number): void {
    if (this.message === null) return;
    const delta = (event.delta ?? {}) as Record<string, unknown>;
    const block = this.message.content[index];
    if (block === undefined) return;
    const field = DELTA_FIELDS[text(delta.type)];
    if (field !== undefined) {
      if (field === "input") {
        this.args.set(
          index,
          (this.args.get(index) ?? "") + text(delta.partial_json),
        );
        return;
      }
      block[field] = text(block[field]) + text(delta[field]);
      return;
    }
    if (delta.type === "citations_delta") {
      const citations = (block.citations ?? []) as unknown[];
      block.citations = [...citations, delta.citation];
    }
  }

  private blockStop(index: number): void {
    if (this.message === null) return;
    const partial = this.args.get(index);
    if (partial === undefined) return;
    const block = this.message.content[index];
    if (block === undefined) return;
    this.args.delete(index);
    try {
      // Инструмент без аргументов API стримит пустым `partial_json` (Fable, 22.09.2026):
      // пустая строка — это `{}`, а не недоклеенный JSON.
      block.input = partial.trim() === "" ? {} : JSON.parse(partial);
    } catch {
      // Блок закрыт, а аргументы не JSON — это ошибка модели, а не обрыв: сырые аргументы
      // уходят в eve как есть (`partial_json`), и eve отвечает модели ошибкой аргументов. Обрыв
      // до конца блока оставляет запись в args, и `message_stop` такой ответ целым не назовёт.
      block.partial_json = partial;
    }
  }

  private messageDelta(event: Record<string, unknown>): void {
    if (this.message === null) return;
    const delta = (event.delta ?? {}) as Record<string, unknown>;
    const usage = (event.usage ?? {}) as Record<string, unknown>;
    this.message = {
      ...this.message,
      ...delta,
      usage: { ...(this.message.usage ?? {}), ...usage },
    };
  }

  private messageStop(): void {
    const message = this.message;
    this.complete =
      message !== null &&
      typeof message.stop_reason === "string" &&
      message.stop_reason.length > 0 &&
      this.args.size === 0;
  }
}

const DELTA_FIELDS: Record<string, string> = {
  text_delta: "text",
  thinking_delta: "thinking",
  signature_delta: "signature",
  input_json_delta: "input",
};

/** Ход реле: адрес, счётчики и оба сокета в одном месте, чтобы abort был одним вызовом. */
class AdmissionGate implements Admission {
  used = false;
  denied = 0;
  status: number | undefined;
  readonly capture = new SseCapture();
  url = "";
  private cancelled = false;
  private readonly prefix = `/admit/${randomBytes(32).toString("base64url")}`;
  private readonly sockets = new Set<Closable>();
  private readonly server: Server;
  readonly upstream: URL;
  readonly timeoutMs: number;
  readonly queried: readonly NativeBlock[] | undefined;

  constructor(
    upstream: URL,
    timeoutMs: number,
    queried: readonly NativeBlock[] | undefined,
  ) {
    this.upstream = upstream;
    this.timeoutMs = timeoutMs;
    this.queried = queried;
    this.server = createServer();
    this.server.on("request", (request, response) => {
      handle(this, request, response);
    });
    // Порт выбирает ядро: занятый порт из фиксированного диапазона — это отказ хода, которого
    // можно не допускать вовсе.
    this.server.listen(0, "127.0.0.1");
  }

  /** Дожидается порта: до `listening` адрес неизвестен, а CLI уже должен его получить. */
  async listen(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.once("listening", resolve),
    );
    const address = this.server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    this.url = `http://127.0.0.1:${port}${this.prefix}`;
  }

  /**
   * Единственный путь, который реле принимает: префикс плюс `/v1/messages`. Запрос сравнивается
   * БЕЗ строки запроса: CLI 2.1.278 прибавляет к нему `?beta=true`, и по строгому сравнению
   * каждый настоящий запрос получал бы 404 — а CLI читает 404 от шлюза как «такой модели нет
   * или нет доступа» и в API не идёт вовсе (проверено живьём 22.09.2026).
   */
  match(url: string): boolean {
    const query = url.indexOf("?");
    const path = query < 0 ? url : url.slice(0, query);
    return path === `${this.prefix}/v1/messages`;
  }

  get cancelledNow(): boolean {
    return this.cancelled;
  }

  track(socket: Closable | null | undefined): void {
    if (socket !== null && socket !== undefined) this.sockets.add(socket);
  }

  untrack(socket: Closable | null | undefined): void {
    if (socket !== null && socket !== undefined) this.sockets.delete(socket);
  }

  abort(): void {
    this.cancelled = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  async close(): Promise<void> {
    this.abort();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      // Соединение, повисшее без запроса, держало бы `close` бесконечно: keep-alive тут не нужен.
      this.server.closeIdleConnections();
    });
    await delay(0);
  }
}

/** Открывает реле. `upstream` — адрес api.anthropic.com (в тестах — loopback-заглушка). */
export async function startAdmission(
  upstream: string,
  timeoutMs: number,
  queried?: readonly NativeBlock[],
): Promise<Admission> {
  const target = new URL(upstream);
  assertUpstream(target);
  const gate = new AdmissionGate(target, timeoutMs, queried);
  await gate.listen();
  return gate;
}

/** Ответ api.anthropic.com по HTTPS; HTTP пускаем только к loopback — там живёт заглушка теста. */
function assertUpstream(upstream: URL): void {
  const loopback =
    upstream.hostname === "127.0.0.1" ||
    upstream.hostname === "::1" ||
    upstream.hostname === "localhost";
  if (upstream.protocol === "https:") return;
  if (upstream.protocol === "http:" && loopback) return;
  throw new Error(
    `claude admission upstream must be https://api.anthropic.com (got ${upstream.protocol}//${upstream.hostname})`,
  );
}

function handle(
  gate: AdmissionGate,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  // Origin ставит браузер, а не CLI: со страницы, угадавшей порт, ход не начинают.
  if (
    request.method !== "POST" ||
    request.headers.origin !== undefined ||
    !gate.match(request.url ?? "")
  ) {
    // Ничего не объясняем: на этом порту нет других путей, и любой ответ — подсказка тому,
    // кто не должен был сюда попасть. Сюда же попадает `HEAD <префикс>/api/hello` — им CLI
    // проверяет, живой ли шлюз. Живая проверка 22.09.2026: на 404 он не отказывается работать
    // и всё равно шлёт запрос, поэтому выдумывать ответ на недокументированную пробу не станем.
    response.writeHead(404, { Connection: "close" }).end();
    return;
  }
  if (gate.cancelledNow || gate.used) {
    gate.denied += 1;
    sendDenied(request, response);
    return;
  }
  gate.used = true;
  forward(gate, request, response);
}

/** Отказ CLI на его собственный второй запрос: 400 и имя причины, ни одного похода наружу. */
function sendDenied(request: IncomingMessage, response: ServerResponse): void {
  // Тело дочитывается: брошенная на середине отправка обернулась бы у CLI ошибкой сокета
  // вместо внятного 400, и он пошёл бы повторять запрос ещё раз.
  request.resume();
  response
    .writeHead(400, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(DENIED_BODY),
      Connection: "close",
    })
    .end(DENIED_BODY);
}

/** Проксирование первого запроса: тело читается целиком, ответ стримится обратно как есть. */
function forward(
  gate: AdmissionGate,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    gate.track(request.socket);
    gate.track(response.socket);
    const payload = pinMessageBreakpoint(Buffer.concat(chunks), gate.queried);
    const upstream = openUpstream(
      gate,
      request.headers,
      payload,
      searchOf(request.url ?? ""),
    );
    upstream.on("response", (answer) => {
      gate.status = answer.statusCode;
      const headers: IncomingHttpHeaders = {};
      for (const [key, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !SERVER_HEADERS.has(key.toLowerCase()))
          headers[key] = value;
      }
      response.writeHead(answer.statusCode ?? 502, {
        ...headers,
        Connection: "close",
      });
      answer.on("data", (chunk: Buffer) => {
        // Блоки и расход собираются только из ответа 200: тело ошибки — не сообщение модели.
        if (answer.statusCode === 200) gate.capture.feed(chunk);
        if (!response.write(chunk)) {
          answer.pause();
          response.once("drain", () => answer.resume());
        }
      });
      answer.on("end", () => {
        response.end();
        gate.untrack(request.socket);
        gate.untrack(response.socket);
      });
      answer.on("error", () => response.destroy());
    });
    upstream.on("error", () => {
      // Наружу пошёл ответ, а не отказ реле: CLI сам скажет, что API не ответил, и ход
      // останется ходом, а не выдумкой реле.
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  request.on("error", () => response.destroy());
}

/** Строка запроса CLI уезжает наверх как есть: реле пересылает запрос, а не переписывает его. */
function searchOf(url: string): string {
  const query = url.indexOf("?");
  return query < 0 ? "" : url.slice(query);
}

function openUpstream(
  gate: AdmissionGate,
  headers: IncomingHttpHeaders,
  payload: Buffer,
  search: string,
): ReturnType<typeof httpsRequest> {
  const target = gate.upstream;
  const clean: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(key.toLowerCase()))
      clean[key] = value;
  }
  // identity: сжатие сломало бы и разбор SSE, и поток байт обратно в CLI.
  clean["accept-encoding"] = "identity";
  clean["content-length"] = String(payload.byteLength);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = send(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: "POST",
      path: `${target.pathname.replace(/\/$/u, "")}/v1/messages${search}`,
      headers: clean,
      timeout: gate.timeoutMs,
    },
    () => undefined,
  );
  upstream.on("socket", (socket) => gate.track(socket));
  upstream.on("timeout", () => upstream.destroy());
  upstream.end(payload);
  return upstream;
}
