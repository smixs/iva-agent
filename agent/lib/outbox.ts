// Outbox — единственный шов наружу. Всё, что агент говорит в Telegram, проходит
// здесь: ответ модели из Channel (agent/channels/telegram.ts) и ночные отчёты
// cron-скриптов (scripts/lib/telegram-send.ts). Внутри шва живут outbound-Gate,
// маршрутизация в rich-сообщение, нарезка на HTML-чанки и plain-фолбэк — снаружи
// остаётся только транспорт Bot API, свой у каждого пути. Новый путь наружу
// пишется как OutboxTransport, и обойти гейт по дороге больше нечем.
//
// Служебные реплики самого harness (статус «Работаю…», ack на кнопку, уведомление
// о падении хода, экраны /menu, экран обновления) идут мимо шва: это не текст модели,
// а UI канала. Но мимо шва — не мимо гейта. Правило одно на весь репо:
//   • реплика из одних статических строк (лейблы фаз, кнопки, «Работаю…») гейт не
//     проходит — редактить в ней нечего;
//   • реплика, в которую подставлен runtime-контент (текст ошибки, вывод команды,
//     содержимое файла), проходит гейт ДО отправки — иначе секрет уезжает в чат в
//     обход Outbox;
//   • гейт стоит на вызове Bot API, а не во вьюхе над ним: у канала это noticeSender
//     ниже, у моста — tg() в scripts/poller/transport.ts, у апдейтера — call() в
//     scripts/lib/telegram-status.ts, у Brain — своя отправка. Один вызов гейтит
//     тикер, сводку, «уже идёт» и перерисовку разом, и следующий экран гейт забыть
//     не сможет;
//   • отдельный гейт на СБОРКЕ текста остаётся ровно там, где текст потом режут
//     (гист в error-humanizer, деталь ошибки в telegram-media): обрезанный ключ гейт
//     уже не узнаёт, и его голова уехала бы в чат целой.
// Речь только о том, что видит чат: вывод в терминал и journal (апдейтер печатает
// туда ход сборки) гейт не проходит — там и так лежит полный лог.
// Скрипты, которым авторское дерево недоступно на загрузке (CLI, апдейтер), берут
// то же самое через scripts/lib/notice.ts.
//
// Импорты с расширением .ts намеренно: модуль грузится не только из eve-бандла, но
// и голым node (cron → scripts/lib/telegram-send.ts), где «./x.js» → «./x.ts» никто
// не переписывает.
import { scanOutbound } from "./security-gate.ts";
import { traceOutboundGate } from "./trace.ts";
import {
  hasRichButtons,
  htmlToPlain,
  needsRichMessage,
  shortenButtonsData,
  withButtonTypes,
  toTelegramHtmlChunks,
} from "./telegram-format.ts";
import {
  noteWidgetRefusal,
  splitWidgets,
  widgetProblem,
  type ReplyPart,
} from "./telegram-widget.ts";

// Ответ транспорта на одну попытку доставки.
//   retryPlain=true — Telegram не принял разметку (400 по сущностям), тот же кусок
//     имеет смысл повторить без тегов;
//   stop=true — отказ накрывает не один кусок, а всю отправку (flood control, 5xx,
//     бот заблокирован): шов бросает хвост, не добивая Bot API оставшимися чанками.
// Без stop шов идёт к следующему куску: потерять кусок ответа лучше, чем весь хвост.
export type OutboxAck =
  | { ok: true }
  | { ok: false; error: string; retryPlain: boolean; stop?: boolean };

export type OutboxTransport = {
  sendHtml: (html: string) => Promise<OutboxAck>;
  sendPlain: (text: string) => Promise<OutboxAck>;
  // Только там, где Bot API это умеет (sendRichMessage): таблицы, таск-листы,
  // <details>, блочные формулы. Без него шов сразу идёт HTML-путём.
  sendRich?: (markdown: string) => Promise<OutboxAck>;
  // Только там, где транспорт умеет sendWidget (Bot API 10.4). Без него шов шлёт
  // вместо виджета его подпись текстом (agent/lib/telegram-widget.ts).
  sendWidget?: (html: string, caption: string) => Promise<OutboxAck>;
};

export type OutboxResult = {
  ok: boolean; // всё, что шов начал отправлять, доставлено
  delivered: number; // сколько сообщений реально ушло в чат
  fellBack: boolean; // хотя бы один кусок ушёл без разметки или кнопки ушли без rich
  error: string; // первый отказ доставки, иначе причина, по которой кнопки потерялись
};

// Outbound-гейт: редактим утёкшие секреты и эксфил-URL ДО отправки. Fail-open —
// нашли что-то, шлём отредактированное и громко логируем (блокировать текст целиком
// хуже редкой утечки для единственного владельца инсталляции).
export function redactNotice(text: string): string {
  const guard = scanOutbound(text);
  if (!guard.clean)
    console.error(
      "[security] outbound leak redacted:",
      guard.findings.map((f) => `${f.type}:${f.name}`).join(", "),
    );
  // Trace: вердикт outbound-Gate. Стоит на самом вызове гейта, поэтому в журнал попадает
  // и ответ модели через шов, и служебная реплика канала через noticeSender. Ключ хода
  // берётся из контекста хода (его ставит traceOutbox вокруг отправки), вне хода событие
  // не пишется вовсе — сигнатура шва при этом не меняется (ADR-0010).
  traceOutboundGate(guard.clean, guard.findings, text.length, guard.text);
  return guard.text;
}

// Служебная реплика канала уходит одним сообщением, без нарезки и rich-пути, но не
// мимо гейта: обёртка клеит гейт к самому вызову Bot API — как tg() у моста. Бренд на
// типе делает шов обязательным, а не рекомендованным: NoticeSend собирается только
// здесь, а эффекты inbound-пайплайна и уведомление о сбое просят именно его, поэтому
// сырое замыкание над Bot API в них не подставить — tsgo отвергнет.
export type NoticeSend = ((text: string) => Promise<unknown>) & {
  readonly gated: "outbound";
};

export function noticeSender(
  send: (text: string) => Promise<unknown>,
): NoticeSend {
  return Object.assign((text: string) => send(redactNotice(text)), {
    gated: "outbound" as const,
  });
}

// Rich-путь рендерит нативно то, чего parse_mode=HTML не умеет. Любой отказ —
// просто HTML-путь ниже, то есть худший случай равен обычному поведению. Кроме кнопок:
// они живут только в rich-сообщении (ADR-0015), и HTML-путь отдаёт их подписями без
// тапа. Ответ доставлен, но потерю видно в Trace: fellBack и причина отказа.
async function sendRichFirst(
  text: string,
  transport: OutboxTransport,
  alwaysRich: boolean,
  result: OutboxResult,
): Promise<boolean> {
  if (!transport.sendRich || !(alwaysRich || needsRichMessage(text)))
    return false;
  const rich = await transport.sendRich(
    shortenButtonsData(withButtonTypes(text)),
  );
  if (rich.ok) {
    result.delivered = 1;
    return true;
  }
  if (hasRichButtons(text)) {
    result.fellBack = true;
    result.error = `buttons dropped: ${rich.error}`;
  }
  return false;
}

// Один текстовый кусок ответа: rich-путь, затем HTML-чанки с plain-повтором. true —
// транспорт сказал stop, и остаток ответа шов не шлёт.
async function deliverText(
  text: string,
  transport: OutboxTransport,
  limit: number,
  alwaysRich: boolean,
  result: OutboxResult,
): Promise<boolean> {
  if (await sendRichFirst(text, transport, alwaysRich, result)) return false;

  // Первую ошибку запоминаем, ok=false — этого хватает вызывающим (cron выходит
  // ненулевым кодом, канал не засчитывает латентность).
  const fail = (error: string) => {
    if (result.ok) result.error = error;
    result.ok = false;
  };

  // toTelegramHtmlChunks режет И конвертирует, гарантируя длину каждого чанка
  // ≤limit ПОСЛЕ конвертации. Пустые чанки не шлём: Telegram отвергает пустой текст.
  for (const html of toTelegramHtmlChunks(text, limit)) {
    if (!html) continue;
    const sent = await transport.sendHtml(html);
    if (sent.ok) {
      result.delivered++;
      continue;
    }
    if (!sent.retryPlain) {
      fail(sent.error);
      if (sent.stop) return true;
      continue;
    }
    // Один повтор тем же куском, но без тегов и parse_mode — по сущностям 400
    // тогда невозможен. htmlToPlain декодирует сущности, иначе &amp; уйдёт литералом.
    result.fellBack = true;
    const plain = await transport.sendPlain(htmlToPlain(html));
    if (plain.ok) {
      result.delivered++;
      continue;
    }
    fail(`plain retry ${plain.error}`);
    if (plain.stop) return true;
  }
  return false;
}

// Виджет уходит sendWidget. Не ушёл (транспорт не умеет, HTML не влез, Telegram отказал) —
// вместо него подпись обычным текстом: худший случай равен ответу без виджета. Потеря
// видна в Trace (fellBack и причина), кроме транспорта без sendWidget: там подпись — штатный вид.
async function deliverWidget(
  widget: Extract<ReplyPart, { kind: "widget" }>,
  transport: OutboxTransport,
  limit: number,
  alwaysRich: boolean,
  result: OutboxResult,
): Promise<boolean> {
  if (transport.sendWidget) {
    const problem = widgetProblem(widget.html);
    const sent: OutboxAck = problem
      ? { ok: false, error: problem, retryPlain: false }
      : await transport.sendWidget(widget.html, widget.caption);
    if (sent.ok) {
      result.delivered++;
      return false;
    }
    if (sent.stop) {
      if (result.ok) result.error = sent.error;
      result.ok = false;
      return true;
    }
    noteWidgetRefusal(sent.error);
    result.fellBack = true;
    if (!result.error) result.error = `widget dropped: ${sent.error}`;
  }
  if (!widget.caption) return false;
  return deliverText(widget.caption, transport, limit, alwaysRich, result);
}

export async function sendThroughOutbox(
  message: string,
  transport: OutboxTransport,
  // alwaysRich — путь, где rich выбран вызывающим, а не разметкой: `iva post` шлёт
  // пост целиком одним сообщением, и в нём может не быть ни одной конструкции, которую
  // видит needsRichMessage (пост из абзацев и картинок). Решать за такую отправку по
  // тексту нельзя: HTML-путь картинки не рендерит вовсе.
  {
    limit = 4096,
    alwaysRich = false,
  }: { limit?: number; alwaysRich?: boolean } = {},
): Promise<OutboxResult> {
  // Гейт идёт по всему ответу, HTML виджетов включительно: секрет не уедет и в пузыре.
  const text = redactNotice(message);

  const result: OutboxResult = {
    ok: true,
    delivered: 0,
    fellBack: false,
    error: "",
  };

  // Ответ без виджета — один текстовый кусок, ровно прежний путь.
  for (const part of splitWidgets(text)) {
    const stop =
      part.kind === "widget"
        ? await deliverWidget(part, transport, limit, alwaysRich, result)
        : await deliverText(part.text, transport, limit, alwaysRich, result);
    if (stop) break;
  }
  // Пустой результат — провал самого шва, а не «успех с нулём доставок»: рендер
  // схлопнулся в пустоту, и вызывающий, забывший проверить delivered, не должен принять
  // это за отправку. Инвариант живёт здесь, а не тремя копиями у вызывающих: ночной
  // скрипт по ok=false падает ненулевым кодом, канал не засчитывает латентность.
  if (result.delivered === 0) {
    result.ok = false;
    if (!result.error) result.error = "nothing delivered: empty rendering";
  }
  return result;
}
