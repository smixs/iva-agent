// IMAP-источник почты Watch (ADR-0020, дополнение 21.11.2026): только чтение.
//
// Зачем: проверка почты в ядре умела один Gmail через `gws`. Установка, чей ящик живёт не в
// Google, каждый час получала пункт `check:mail` и ход модели «this check does not work». Здесь
// второй источник — произвольный ящик по IMAP: EXAMINE INBOX (не SELECT), BODY.PEEK (флаги не
// трогаются), никаких STORE/EXPUNGE/COPY. Письма читаются заголовками, тело не скачивается.
//
// Настройка — `proactive.mailProvider` в data/settings.json (agent/lib/proactive-config.ts);
// хост, порт, пользователь и пароль — data/secrets/imap.json или переменные IVA_IMAP_*.
// Своего IMAP-клиента в проекте нет, а новая зависимость ради двадцати строк протокола — лишний
// вес: клиент ниже на node:tls, ровно те команды, что нужны проверке.
//
// Клиент собран из двух частей: разбор протокола (сессия над `ImapConnect`) и сам сокет
// (`tlsConnectImap`). Тесты подставляют свой `ImapConnect` и играют записанный разговор — сети
// в тестах нет.
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";

/** Порт IMAP по умолчанию: неявный TLS (RFC 8314). */
export const IMAP_DEFAULT_PORT = 993;
/** Предел строки прото­кола и литерала: сервер, льющий бесконечность, гасится, а не ест память. */
const MAX_LINE = 64 * 1024;
/**
 * Предел строки ответа `SEARCH`. В ней перечислены все непрочитанные UID: 20 000 писем — это
 * около 140 КиБ, и под общий предел строка не влезает. Предел остаётся: 4 МиБ — примерно
 * полмиллиона UID, дальше проверка честно падает, а не молча теряет ящик.
 */
const MAX_SEARCH_LINE = 4 * 1024 * 1024;
const MAX_LITERAL = 256 * 1024;
/** Простой сокета: срок проверки (20 с) держит вызывающий, это второй предохранитель. */
const SOCKET_TIMEOUT_MS = 20_000;

/** Заголовки одного письма, которые просит проверка: отправитель, тема, признак рассылки. */
const HEADER_FIELDS = "FROM SUBJECT LIST-UNSUBSCRIBE";

export type ImapConfig = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
};

/** Письмо для проверки: сырой From (разбор адреса — в precheck.ts), тема и признак рассылки. */
export type ImapMessage = {
  readonly uid: number;
  /** Значение From как пришло (свёрнутое), без раскодирования RFC 2047. */
  readonly from: string;
  readonly subject: string;
  readonly newsletter: boolean;
};

export type ImapInbox = {
  readonly messages: readonly ImapMessage[];
  /** Непрочитанных больше предела: взяты самые новые. */
  readonly truncated: boolean;
};

export type ImapConfigRead =
  { readonly config: ImapConfig } | { readonly error: string };

// ── Настройка ────────────────────────────────────────────────────────────────────────────

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** data/secrets/imap.json; нет файла — пусто, нечитаемый или битый — причина отказа. */
function secretValues(
  dir: string,
): { readonly values: Record<string, unknown> } | { readonly error: string } {
  const file = join(dir, "secrets", "imap.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return { values: {} };
    return { error: `data/secrets/imap.json is unreadable (${String(code)})` };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { error: "data/secrets/imap.json is not a JSON object" };
    return { values: parsed as Record<string, unknown> };
  } catch {
    return { error: "data/secrets/imap.json is not valid JSON" };
  }
}

/**
 * Действующая настройка IMAP: файл секрета, поверх него — переменные IVA_IMAP_* (переменная
 * важнее файла: так пароль меняется без правки файла). Пусто или мусор — причина отказа, и
 * источник молчит, как неподключённый Gmail: часового шума из-за настройки нет.
 */
export function readImapConfig(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): ImapConfigRead {
  const secret = secretValues(dir);
  if ("error" in secret) return { error: secret.error };
  const pick = (fileKey: string, envKey: string): string =>
    text(env[envKey]) || text(secret.values[fileKey]);
  // Пароль не обрезаем: пробелы по краям могут быть его частью, а пустая строка — «не задан».
  const secretText = (value: unknown): string =>
    typeof value === "string" && value !== "" ? value : "";
  const password =
    secretText(env.IVA_IMAP_PASSWORD) || secretText(secret.values.password);
  const host = pick("host", "IVA_IMAP_HOST");
  const user = pick("user", "IVA_IMAP_USER");
  if (host === "" && user === "" && password === "")
    return {
      error: "imap is not configured (data/secrets/imap.json or IVA_IMAP_*)",
    };
  if (host === "" || user === "" || password === "")
    return { error: "imap needs host, user and password" };
  // Управляющие символы — попытка вставить перевод строки в команду протокола.
  // eslint-disable-next-line no-control-regex -- управляющие символы и есть предмет проверки.
  if (/[\u0000-\u001f\u007f]/u.test(host + user + password))
    return { error: "imap credentials contain control characters" };
  if (/\s/u.test(host) || /[^\w.:-]/u.test(host))
    return { error: "imap host is not a host name" };
  // Порт: число из imap.json — обычная запись (`"port": 1993`), строка — из .env. Нет значения —
  // 993; не число — ошибка, а не тихая подмена портом по умолчанию.
  const portRaw = env.IVA_IMAP_PORT ?? secret.values.port;
  const portText =
    typeof portRaw === "number"
      ? String(portRaw)
      : typeof portRaw === "string"
        ? portRaw.trim()
        : "";
  const port =
    portText === ""
      ? IMAP_DEFAULT_PORT
      : /^\d{1,5}$/u.test(portText)
        ? Number(portText)
        : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    return { error: "imap port is not a valid port" };
  return { config: { host, port, user, password } };
}

// ── Заголовки ────────────────────────────────────────────────────────────────────────────

const CHARSET = /^[\w.:-]{1,40}$/u;

/** Значение заголовка из кодированных слов RFC 2047 (`=?UTF-8?B?…?=`); битое — как пришло. */
export function decodeWords(value: string): string {
  // Промежуток между двумя кодированными словами по RFC 2047 не показывается: сервер режет
  // длинную тему на слова по границе кодировки, и «за» + «долженность» — одно слово. Склейка
  // до разбора, иначе в тему попадает пробел посреди слова.
  return value
    .replace(/\?=[ \t]+=\?/gu, "?==?")
    .replace(
      /=\?([^?\s]{1,40})\?([BbQq])\?([^?]*)\?=/gu,
      (whole, charset: string, kind: string, payload: string) => {
        if (!CHARSET.test(charset)) return whole;
        try {
          const bytes =
            kind.toUpperCase() === "B"
              ? Buffer.from(payload, "base64")
              : Buffer.from(
                  payload
                    .replace(/_/gu, " ")
                    .replace(/=([0-9A-Fa-f]{2})/gu, (_, hex: string) =>
                      String.fromCharCode(Number.parseInt(hex, 16)),
                    ),
                  "latin1",
                );
          return new TextDecoder(charset.toLowerCase(), {
            fatal: false,
          }).decode(bytes);
        } catch {
          // Неизвестная кодировка или битые байты: показываем как пришло, письмо не теряем.
          return whole;
        }
      },
    );
}

/**
 * Заголовки письма: имя в нижнем регистре, повтор — первое значение, перенос строки
 * (`\r\n` + пробел или табуляция) склеен. Пустые строки и мусор без двоеточия пропускаются.
 */
export function parseHeaderBlock(raw: string): Map<string, string> {
  const unfolded = raw.replace(/\r?\n[ \t]+/gu, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/u)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    if (name === "" || headers.has(name)) continue;
    headers.set(name, line.slice(at + 1).trim());
  }
  return headers;
}

function toMessage(uid: number, block: string): ImapMessage {
  const headers = parseHeaderBlock(block);
  return {
    uid,
    from: headers.get("from") ?? "",
    subject: decodeWords(headers.get("subject") ?? ""),
    newsletter: headers.has("list-unsubscribe"),
  };
}

// ── Протокол ─────────────────────────────────────────────────────────────────────────────

export type ImapTransport = {
  readonly write: (text: string) => void;
  /** Закрыть соединение сейчас: срок вышел или разбор упал. */
  readonly close: () => void;
};

export type ImapHandlers = {
  readonly data: (chunk: Buffer) => void;
  /** Конец или ошибка соединения; повторные вызовы игнорируются. */
  readonly end: (error?: Error) => void;
};

/** Соединение: настоящий TLS в работе, записанный разговор — в тестах. */
export type ImapConnect = (
  config: ImapConfig,
  handlers: ImapHandlers,
) => ImapTransport;

export const tlsConnectImap: ImapConnect = (config, handlers) => {
  const socket = tlsConnect({
    host: config.host,
    port: config.port,
    // SNI только для имени: у адреса его нет, и часть серверов на нём спотыкается.
    ...(isIP(config.host) === 0 ? { servername: config.host } : {}),
    rejectUnauthorized: true,
  });
  let ended = false;
  const end = (error?: Error) => {
    if (ended) return;
    ended = true;
    handlers.end(error);
  };
  socket.setTimeout(SOCKET_TIMEOUT_MS, () =>
    end(new Error(`imap socket idle for ${SOCKET_TIMEOUT_MS} ms`)),
  );
  socket.on("data", handlers.data);
  socket.on("error", (error: Error) => end(new Error(`imap ${error.message}`)));
  socket.on("close", () => end(new Error("imap connection closed")));
  return {
    write: (chunk) => socket.write(chunk),
    close: () => socket.destroy(),
  };
};

/** Поток ответов сервера: строки до CRLF и литералы `{N}` ровно N байт. */
class Wire {
  private buffer: Buffer = Buffer.alloc(0);
  private failure: Error | null = null;
  private wake: (() => void) | null = null;

  push(chunk: Buffer): void {
    if (this.failure !== null) return;
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.notify();
  }

  end(error?: Error): void {
    if (this.failure !== null) return;
    this.failure = error ?? new Error("imap connection closed");
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  /** Очередная строка без CRLF; `max` — предел длины строки, по умолчанию общий. */
  async line(max: number = MAX_LINE): Promise<string> {
    for (;;) {
      const at = this.buffer.indexOf("\r\n");
      if (at >= 0) {
        const line = this.buffer.subarray(0, at).toString("utf8");
        this.buffer = this.buffer.subarray(at + 2);
        return line;
      }
      if (this.failure !== null) throw this.failure;
      if (this.buffer.length > max)
        throw new Error("imap response line is too long");
      await this.wait();
    }
  }

  /** Ровно `n` байт литерала. */
  async literal(n: number): Promise<Buffer> {
    if (n > MAX_LITERAL)
      throw new Error(`imap literal is too large (${n} bytes)`);
    while (this.buffer.length < n) {
      if (this.failure !== null) throw this.failure;
      await this.wait();
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }
}

/** Ответ на команду: нет `OK` — ошибка с меткой и статусом, тело ответа не в журнале. */
type Answer = {
  readonly status: string;
  /** Строки `* …` между командой и её меткой. */
  readonly untagged: readonly string[];
};

async function command(
  wire: Wire,
  transport: ImapTransport,
  tag: string,
  text: string,
  max: number = MAX_LINE,
): Promise<Answer> {
  transport.write(`${tag} ${text}\r\n`);
  const untagged: string[] = [];
  for (;;) {
    const line = await wire.line(max);
    if (line.startsWith(`${tag} `)) {
      const status = line.slice(tag.length + 1).split(" ")[0] ?? "";
      if (status !== "OK")
        throw new Error(`imap ${tag} ${text.split(" ")[0]} answered ${status}`);
      return { status, untagged };
    }
    if (line.startsWith("* ")) untagged.push(line.slice(2));
    else if (line.startsWith("+ ")) continue;
    else if (line !== "") throw new Error("imap answered an unknown line");
  }
}

/** UID из `* SEARCH 4 5 6`: числа, без повторов, по возрастанию. */
export function searchUids(answer: readonly string[]): number[] {
  const uids = new Set<number>();
  for (const line of answer) {
    if (!/^SEARCH\b/iu.test(line)) continue;
    for (const token of line.split(/\s+/u).slice(1))
      if (/^\d{1,10}$/u.test(token)) {
        const uid = Number(token);
        if (Number.isSafeInteger(uid) && uid > 0) uids.add(uid);
      }
  }
  return [...uids].sort((a, b) => a - b);
}

/**
 * Разбор ответа FETCH: строка `* n FETCH (… UID 7 BODY[…] {N}` + литерал N байт + хвост `)`.
 * UID может стоять и до литерала, и после — берём из всего ответа, кроме самого литерала.
 */
async function readFetch(
  wire: Wire,
  line: string,
): Promise<{ readonly uid: number; readonly block: string } | null> {
  const fragments: string[] = [line];
  let current = line;
  let block = "";
  // Литерал бывает только у запрошенной секции заголовков. Нежелательный `FETCH` другого клиента
  // (смена флагов) приходит без литерала — такой ответ письмом не считается.
  let headers = false;
  for (;;) {
    const literal = /\{(\d{1,10})\}$/u.exec(current);
    if (literal === null) break;
    block += (await wire.literal(Number(literal[1]))).toString("utf8");
    headers = true;
    current = await wire.line();
    fragments.push(current);
  }
  if (!headers) return null;
  const uid = /(?:^|[\s(])UID\s+(\d{1,10})(?=$|[\s)])/iu.exec(
    fragments.join(" "),
  )?.[1];
  if (uid === undefined) return null;
  const value = Number(uid);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return { uid: value, block };
}

/** Кавычки IMAP: обратный слэш и кавычка экранируются, управляющие символы уже отвергнуты. */
const quoted = (value: string): string =>
  `"${value.replace(/[\\"]/gu, (char) => `\\${char}`)}"`;

/**
 * Непрочитанные письма INBOX: только чтение — EXAMINE, BODY.PEEK, UID SEARCH. Самое новое
 * `limit` штук, тело не скачивается. Срок — сигнал вызывающего: снятый гасит сокет.
 */
export async function readImapInbox(
  config: ImapConfig,
  limit: number,
  signal: AbortSignal,
  connect: ImapConnect = tlsConnectImap,
): Promise<ImapInbox> {
  const wire = new Wire();
  const transport = connect(config, {
    data: (chunk) => wire.push(chunk),
    end: (error) => wire.end(error),
  });
  const aborted = new Promise<never>((_, reject) => {
    const fail = () =>
      reject(
        new Error(
          signal.reason instanceof Error
            ? signal.reason.message
            : "imap deadline passed",
        ),
      );
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  const session = async (): Promise<ImapInbox> => {
    const greeting = await wire.line();
    if (!/^\* (OK|PREAUTH)\b/u.test(greeting))
      throw new Error("imap greeting is not OK");
    // PREAUTH — сервер уже авторизовал соединение (например, по сертификату).
    if (!/^\* PREAUTH\b/u.test(greeting))
      await command(
        wire,
        transport,
        "A1",
        `LOGIN ${quoted(config.user)} ${quoted(config.password)}`,
      );
    // EXAMINE, не SELECT: ящик открывается только на чтение, флаги не меняются.
    await command(wire, transport, "A2", "EXAMINE INBOX");
    const found = searchUids(
      (
        await command(
          wire,
          transport,
          "A3",
          "UID SEARCH UNSEEN",
          MAX_SEARCH_LINE,
        )
      ).untagged,
    );
    const wanted = found.slice(-Math.max(0, limit));
    // Только запрошенные UID и по одному разу: нежелательный FETCH другого клиента не станет
    // письмом, а повторный ответ не задвоит пункт.
    const asked = new Set(wanted);
    const messages = new Map<number, ImapMessage>();
    if (wanted.length > 0) {
      transport.write(
        `A4 UID FETCH ${wanted.join(",")} (UID BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})])\r\n`,
      );
      for (;;) {
        const line = await wire.line();
        if (line.startsWith("A4 ")) {
          if (!/^A4 OK\b/u.test(line))
            throw new Error(
              `imap fetch answered ${line.slice(3).split(" ")[0] ?? ""}`,
            );
          break;
        }
        if (!/^\* \d+ FETCH /u.test(line)) continue;
        const fetched = await readFetch(wire, line);
        // Письмо исчезло между SEARCH и FETCH — пропускаем, прогон не падает.
        if (
          fetched !== null &&
          asked.has(fetched.uid) &&
          !messages.has(fetched.uid)
        )
          messages.set(fetched.uid, toMessage(fetched.uid, fetched.block));
      }
    }
    // LOGOUT: ответ не нужен, соединение закрывает finally.
    transport.write("A5 LOGOUT\r\n");
    const list = [...messages.values()].sort((a, b) => b.uid - a.uid);
    return { messages: list, truncated: found.length > wanted.length };
  };
  try {
    return await Promise.race([session(), aborted]);
  } finally {
    transport.close();
  }
}
