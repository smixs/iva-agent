// Deterministic inbound and outbound security gates shared by the agent runtime
// and bare-Node operational scripts.

import secretKeyInventory from "../skills/security-defense/outbound-sensitive-keys.json" with { type: "json" };
import { traceInboundGate } from "./trace.ts";

const INVISIBLE_RE = /[\p{Cf}\p{Cc}\u034F]/gu;
const KEEP_CONTROL = new Set(["\n", "\r", "\t"]);
const WALLET_DRAIN_RE =
  /[ༀ-࿿ꀀ-꓏⠀-⣿]|[\u{1D400}-\u{1D7FF}\u{10000}-\u{1034F}]/gu;

export interface SanitizeResult {
  text: string;
  blocked: boolean;
  reason: string;
  flags: string[];
  truncatedChars: number;
}

export interface OutboundFinding {
  type: string;
  name: string;
  preview: string;
}

export interface OutboundResult {
  clean: boolean;
  text: string;
  findings: OutboundFinding[];
}

type Pattern = readonly [name: string, expression: RegExp];

// Exact carriers cover the credentials this project configures but whose values
// do not have a stable provider prefix. The sorted inventory is also read by the
// manual Python gate. Keep public client_id and TELEGRAM_API_ID out of it.
const NAMED_SECRET_PATTERN = new RegExp(
  String.raw`(?<![A-Za-z0-9_])["']?(?:${secretKeyInventory.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})["']?\s*[=:]\s*["']?[^\s"'},]+`,
  "gu",
);

const LOOKALIKES: Record<string, string> = {
  А: "A",
  В: "B",
  С: "C",
  Е: "E",
  Н: "H",
  К: "K",
  М: "M",
  О: "O",
  Р: "P",
  Т: "T",
  Х: "X",
  а: "a",
  с: "c",
  е: "e",
  о: "o",
  р: "p",
  х: "x",
  у: "y",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
  ο: "o",
  ν: "v",
};

// Агент работает по-русски, а его владелец читает и узбекский веб, поэтому на
// web-поверхности детектор говорит на трёх языках. Английские и узбекские
// правила латинские; русские написаны кириллицей и морфологию слова добирают
// хвостом `\p{L}*` («игнорируй», «игнорируйте», «проигнорировать» — одно
// правило). Апостроф узбекской латиницы пишут пятью разными знаками
// (o'/oʻ/o’/oʼ/o`), поэтому он везде идёт классом.
const UZ_APOSTROPHE = "['‘’ʻʼ`]?";

function roleMarkerRe(names: string): RegExp {
  return new RegExp(String.raw`(?:^|\n)\s*(?:${names})\s*[:-]\s`, "gimu");
}

const ENGLISH_ROLE_MARKER_RE = roleMarkerRe(
  String.raw`system|assistant|user|human|AI|claude|instruction|admin|root`,
);

const MULTILINGUAL_ROLE_MARKER_RE = roleMarkerRe(
  String.raw`system|assistant|user|human|AI|claude|instruction|admin|root` +
    String.raw`|система|систем|ассистент|пользователь|человек|админ|инструкция` +
    String.raw`|tizim|yordamchi|foydalanuvchi|inson|ko${UZ_APOSTROPHE}rsatma`,
);

const ENGLISH_OVERRIDE_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions?/i,
  /forget\s+(?:all\s+)?(?:your\s+)?(?:previous\s+)?instructions?/i,
  /you\s+are\s+now\s+(?:in\s+)?(?:\w+\s+)?mode/i,
  /new\s+(?:system\s+)?instructions?\s*:/i,
  /override\s+(?:all\s+)?(?:safety|security|rules|guidelines)/i,
  /act\s+as\s+(?:if\s+)?(?:you\s+are\s+)?(?:a\s+)?(?:different|new|unrestricted)/i,
  /(?:DAN|STAN|DUDE|KEVIN)\s+mode/i,
  /jailbreak|do\s+anything\s+now/i,
  /pretend\s+(?:you\s+)?(?:are|have)\s+no\s+(?:rules|restrictions|limits)/i,
  /(?:reveal|show|display|print|output)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/i,
  /(?:send|forward|email|post)\s+(?:all\s+)?(?:data|files|secrets|keys|tokens)/i,
];

// Русские и узбекские правила стоят ТОЛЬКО на web — на поверхности, где текст
// это данные, а гейт лишь предупреждает. По-русски владелец говорит с агентом
// каждый день, и те же слова у него значат ровно то, что сказано: «покажи
// правила из CLAUDE.md», «отмени ограничение на длину», «забудь предыдущие
// указания» — это работа, а не инъекция. На блокирующей поверхности такие
// правила съедали бы вопрос владельца целиком (см. ADR-0006, «Язык детектора»).
const RU_UZ_OVERRIDE_PATTERNS = [
  // Русский: те же одиннадцать намерений, слово в слово как их пишет инъекция.
  /(?:про)?игнорир\p{L}*\s+(?:\p{L}+\s+){0,3}?(?:инструкц|указан|правил|предписан|команд)\p{L}*/iu,
  /забуд\p{L}*\s+(?:\p{L}+\s+){0,3}?(?:инструкц|указан|правил|предписан|роль|что\b)\p{L}*/iu,
  // «Новая инструкция:» объявляет замену указаний — так пишет закладка. «Введите
  // следующую команду:» и «Новые правила: с 1 января…» пишет обычный русский
  // туториал, и он же самая частая фраза технической документации. Разводит их
  // не слово, а адресат: либо объявляется сам список указаний («новая
  // инструкция», «другие указания»), либо он назван системным или обращён к
  // агенту («новая системная инструкция», «новые правила для тебя»). «Следующая
  // команда» и «новые правила» без адресата — текст для человека.
  /(?:нов|друг)\p{L}+\s+(?:инструкц|указан|предписан)\p{L}*\s*:|(?:нов|друг|следующ)\p{L}+\s+(?:систем\p{L}+\s+(?:инструкц|указан|правил|команд)\p{L}*|(?:инструкц|указан|правил|команд)\p{L}*\s+(?:для\s+)?(?:теб[яе]|вас(?!\p{L})|ассистент|помощник|модел|бот(?!\p{L})|ии(?!\p{L}))\p{L}*)/iu,
  /(?:систем\p{L}+\s+(?:промпт|подсказк)\p{L}*|промпт\p{L}*\s+систем\p{L}+)/iu,
  /режим\p{L}*\s+(?:разработчик|бога|dev)\p{L}*/iu,
  /(?:покажи|выведи|раскрой|напечатай|отдай|скажи)\p{L}*\s+(?:\p{L}+\s+){0,3}?(?:промпт|инструкц|правил|систем)\p{L}*/iu,
  // «отправь файл» и «пришли данные» — обычная просьба владельца, поэтому
  // объект правила только секрет: ключ, токен, пароль, учётка.
  /(?:отправ|перешл|пришл|выгруз|опубликуй|слей)\p{L}*\s+(?:\p{L}+\s+){0,3}?(?:ключ|токен|парол|секрет|учётн|учетн)\p{L}*/iu,
  /(?:веди\s+себя|действуй|притворись|представь)\p{L}*\s*,?\s*(?:как|будто|что)\s+(?:\p{L}+\s+){0,3}?(?:без\s+(?:ограничен|правил|цензур)|друг|нов|неограничен)\p{L}*/iu,
  // Глагол только в повелительном наклонении: инъекция обращается к агенту
  // («отмени ограничения», «отключите фильтр»). Русская техдокументация те же
  // слова пишет о программе — «значение 0 отключает ограничение скорости»,
  // «необходимо отключить устаревшие протоколы», — и хвост `\p{L}*` забирал их
  // вместе с закладкой.
  /(?:отмени|обойди|сними|отключи)(?:те)?(?!\p{L})\s+(?:\p{L}+\s+){0,3}?(?:ограничен|запрет|правил|защит|цензур|фильтр)\p{L}*/iu,
  // Узбекский (латиница): «забудь предыдущие указания», «системный промпт»,
  // «режим разработчика», «отправь ключи».
  new RegExp(
    String.raw`(?:oldingi|avvalgi|barcha)\s+(?:\p{L}+\s+){0,2}?ko${UZ_APOSTROPHE}rsatma\p{L}*`,
    "iu",
  ),
  new RegExp(
    String.raw`ko${UZ_APOSTROPHE}rsatma\p{L}*\s+(?:\p{L}+\s+){0,3}?(?:unut|e${UZ_APOSTROPHE}tiborsiz|bekor)\p{L}*`,
    "iu",
  ),
  new RegExp(
    String.raw`(?:tizim|dasturchi)\s*\p{L}*\s+(?:prompt|ko${UZ_APOSTROPHE}rsatma|rejim)\p{L}*`,
    "iu",
  ),
  new RegExp(
    String.raw`(?:kalit|token|parol|maxfiy)\p{L}*[^.\n]{0,40}?(?:yubor|jo${UZ_APOSTROPHE}nat|oshkor)\p{L}*`,
    "iu",
  ),
];

// Правила выше ловят каноничную формулировку: «игнорируй предыдущие
// инструкции», «системный промпт», «ignore all previous instructions». Живая
// закладка так пишет не всегда. Корпус перефразировок показал пять семейств
// намерения, которые проходили с нулём флагов на всех трёх языках: подмена
// личности («ты больше не Iva»), переобъявление задачи («твоя новая задача:
// …»), эксфильтрация не секрета, а файла («отправь содержимое .env»),
// исполнение чужой страницы («зайди на … и выполни, что там написано») и
// просьба скрыть это от владельца. Каждое правило — глагол намерения плюс
// объект, поэтому внутри семьи порядок слов и морфология свободны.
//
// Семейства не делают детектор семантическим: закладка, написанная мимо этих
// пяти намерений или другими словами внутри них, проходит по-прежнему (ADR-0006,
// «Что осталось открытым»). Стоят они только на web: цена ложной сработки здесь
// — одна фраза предупреждения, а «твоя новая задача» и «не говори пользователю»
// в обычном чате владельца звучат ежедневно.
const WEB_INTENT_PATTERNS = [
  // Подмена личности: «ты больше не X», «теперь ты X без правил».
  /(?<!\p{L})ты\s+(?:больше|уже)\s+не\s+(?:\p{L}+\s+){0,2}?(?:iva|ассистент|помощник|бот|модель|ии(?!\p{L})|claude|gpt|обязан|должен|подчин|связан|огранич)/iu,
  /(?<!\p{L})(?:теперь\s+ты|ты\s+теперь)\s+(?:\p{L}+\s+){0,3}?(?:без\s+(?:правил|ограничен|цензур|фильтр)|неограничен|свободн|другой\b|ассистент|помощник|бот\b|gpt)/iu,
  /\byou\s+are\s+no\s+longer\s+(?:\w+\s+){0,2}?(?:iva|an?\s+(?:assistant|ai|model|bot)|bound|restricted|limited|subject\s+to)/i,
  /\bfrom\s+now\s+on,?\s+you\s+(?:are|will|must|act)/i,
  new RegExp(String.raw`\bsen\s+endi\b`, "iu"),
  // Новая задача: инъекция переобъявляет цель хода.
  /(?:тво[яею]|ваш\p{L}+)\s+(?:нов\p{L}+\s+|настоящ\p{L}+\s+|реальн\p{L}+\s+|обновлённ\p{L}+\s+|обновленн\p{L}+\s+)?задач\p{L}*/iu,
  /\byour\s+(?:new|real|actual|updated)\s+task\b/i,
  new RegExp(String.raw`yangi\s+vazifa(?:ng\p{L}*|\s*:)`, "iu"),
  // Эксфильтрация файлом и окружением: объект — не только слово «ключ», но и
  // сам секрет как файл или как переменные процесса.
  /(?:отправ|перешл|пересла|пришл|выгруз|опубликуй|слей|скинь|залей|отдай)\p{L}*\s+(?:[^\s.]+\s+){0,4}?(?:\.env\b|id_rsa|\.ssh|~\/\.|переменн\p{L}*\s+окружен\p{L}*|окружен\p{L}*\s+процесс\p{L}*|учётн\p{L}*\s+данн\p{L}*|учетн\p{L}*\s+данн\p{L}*)/iu,
  /(?:\.env\b|id_rsa|\.ssh|переменн\p{L}*\s+окружен\p{L}*)[^.,\n]{0,30}?(?:отправ|перешл|пересла|пришл|выгруз|опубликуй|слей|скинь|залей|отдай)\p{L}*/iu,
  // Объект берётся с границы морфемы, а не голой подстрокой. Хвост `\S*?` нужен
  // ради «API-ключи» и «X-Token», но начинать объект он обязан после неписьменного
  // знака: иначе «ключ» находится внутри «подключить», «отключите», «заключение»,
  // «исключения» — то есть обычная русская техдокументация поднимает атак-сигнал.
  // «Ключ» вдобавок ограничен падежными окончаниями существительного, потому что
  // «ключевые слова» начинаются с той же морфемы и границей не отсекаются.
  /(?:собер|собрать|извлек|выгруз|найд)\p{L}*\s+(?:\S+\s+){0,3}?\S*?(?<!\p{L})(?:ключ(?:[аеиую]|ом|ей|ам|ами|ах)?(?!\p{L})|(?:токен|парол|секрет|учётн|учетн)\p{L}*)/iu,
  /(?:send|post|upload|exfiltrate|collect|dump|leak)\s+(?:\S+\s+){0,4}?(?:\.env\b|id_rsa|\/\.ssh|environment\s+variables|credentials)/i,
  new RegExp(
    String.raw`(?:\.env\b|id_rsa|maxfiy\s+ma${UZ_APOSTROPHE}lumot\p{L}*|kalit\p{L}*|token\p{L}*|parol\p{L}*)[^.\n]{0,40}?(?:yubor|jo${UZ_APOSTROPHE}nat|oshkor|ber\b|bering\b)`,
    "iu",
  ),
  // Исполнение чужой страницы: «сделай то, что там написано», «следуй
  // инструкциям по ссылке».
  /(?:выполн|исполн|запусти|сделай|повтори)\p{L}*\s+(?:\p{L}+[,\s]+){0,3}?что\s+(?:\p{L}+\s+){0,2}?(?:написан|указан|сказан|сообщ)\p{L}*/iu,
  /следу\p{L}*\s+(?:\p{L}+\s+){0,3}?(?:инструкц|указан|команд|предписан)\p{L}*\s+(?:\p{L}+\s+){0,2}?(?:по\s+ссылк|со?\s+страниц|на\s+страниц|отсюда|ниже|выше|коммент|https?:)/iu,
  /\bfollow\s+the\s+(?:instructions?|steps?|directions?)\s+(?:on|at|from|in)\s+(?:this\s+|the\s+)?(?:https?:|link|url|page(?!\s+\d)|comment|note\b)/i,
  new RegExp(
    String.raw`(?:havola|sahifa|link)\p{L}*[^.\n]{0,40}?(?:ko${UZ_APOSTROPHE}rsatma\p{L}*[^.\n]{0,20}?bajar|bajar)\p{L}*`,
    "iu",
  ),
  // Скрыть от владельца — признак закладки, а не текста для человека.
  /не\s+(?:\p{L}+\s+){0,2}?(?:показыв|сообщ|говор|раскрыв|упомин|рассказыв)\p{L}*\s+(?:\p{L}+\s+){0,3}?(?:пользовател|владельц|хозя)\p{L}*/iu,
  /\b(?:do\s*n[o']?t|never)\s+(?:\w+\s+){0,3}?(?:tell|show|mention|reveal|inform)\s+(?:this\s+)?(?:to\s+)?the\s+(?:user|owner|human)/i,
  new RegExp(
    String.raw`foydalanuvchi\p{L}*[^.\n]{0,30}?(?:aytma|bildirma|ko${UZ_APOSTROPHE}rsatma\b)`,
    "iu",
  ),
];

const MULTILINGUAL_OVERRIDE_PATTERNS = [
  ...ENGLISH_OVERRIDE_PATTERNS,
  ...RU_UZ_OVERRIDE_PATTERNS,
  ...WEB_INTENT_PATTERNS,
];

const INBOUND_ATTACK_FLAG_NAMES = new Set(["role-markers", "overrides"]);

export function hasInboundAttackSignal(
  result: Pick<SanitizeResult, "blocked" | "flags">,
): boolean {
  if (result.blocked) return true;
  return result.flags.some((flag) => {
    const separator = flag.indexOf("=");
    const name = separator === -1 ? flag : flag.slice(0, separator);
    return INBOUND_ATTACK_FLAG_NAMES.has(name);
  });
}

// Поверхность входа. Одно решение, а не набор ручек: от неё зависит и то, как
// гейт отвечает на блокировку, и то, на скольких языках он читает.
//
// `telegram` (дефолт) — блокирующая поверхность. Говорит на ней владелец, текст
// от него это инструкция, и ложная блокировка стоит целого вопроса: гейт
// обнуляет текст, поэтому правила держатся англоязычного минимума, как было до
// web-раунда.
//
// `web` — warn-and-pass (ADR-0006). Текст здесь данные, эффект гейта — одна
// фраза предупреждения, поэтому цена ложной сработки мала, а цена пропуска
// велика: правила читают три языка, текст едет к модели даже когда сработало
// правило блокировки, а дорогие письменности остаются на месте — тибетская
// статья, таблица Брайля и математика в юникоде это контент, а не атака.
export type InboundSurface = "telegram" | "web";

// Бюджет символов дорогих письменностей на поверхности, где их не вырезают.
// Дорогой символ стоит 3–10 токенов, то есть 2000 таких — порядка 20 тысяч
// токенов: цена обычной большой страницы, а не кошелька владельца. Столько же
// знаков тибетской статьи или таблицы Брайля — уже целое содержимое, а не
// «пустота с предупреждением». Всё, что за бюджетом, вырезается и идёт в счёт
// усечения.
export const EXPENSIVE_SCRIPT_MAX_CHARS = 2000;

interface SurfaceRules {
  roleMarker: RegExp;
  overrides: readonly RegExp[];
  keepBlockedText: boolean;
  // Вырезать ли символы дорогих письменностей из текста, который едет к модели.
  // Счёт для порога wallet-drain ведётся в любом случае.
  stripExpensiveScripts: boolean;
  // Читать ли правилам ещё и NFKC-вид текста. Он снимает маскировку
  // совместимыми формами (математическое `𝐢𝐠𝐧𝐨𝐫𝐞` → `ignore`, полноширинные
  // буквы), которую на другой поверхности снимает само вырезание глифов.
  foldCompatibility: boolean;
}

const SURFACE_RULES: Record<InboundSurface, SurfaceRules> = {
  telegram: {
    roleMarker: ENGLISH_ROLE_MARKER_RE,
    overrides: ENGLISH_OVERRIDE_PATTERNS,
    keepBlockedText: false,
    stripExpensiveScripts: true,
    foldCompatibility: false,
  },
  web: {
    roleMarker: MULTILINGUAL_ROLE_MARKER_RE,
    overrides: MULTILINGUAL_OVERRIDE_PATTERNS,
    keepBlockedText: true,
    stripExpensiveScripts: false,
    foldCompatibility: true,
  },
};

export interface SanitizeOptions {
  surface?: InboundSurface;
}

// Bounds the text by Unicode code points without splitting a surrogate pair.
function capCodePoints(
  text: string,
  maxChars: number,
): { text: string; truncatedChars: number } {
  let codePoints = 0;
  let keptCodeUnits = text.length;
  for (let offset = 0; offset < text.length;) {
    if (codePoints === maxChars) keptCodeUnits = offset;
    const point = text.codePointAt(offset);
    offset += point !== undefined && point > 0xffff ? 2 : 1;
    codePoints += 1;
  }
  const truncatedChars = Math.max(0, codePoints - maxChars);
  return {
    text: truncatedChars > 0 ? text.slice(0, keptCodeUnits) : text,
    truncatedChars,
  };
}

// Копия текста с буквами-двойниками, приведёнными к латинице. Живёт только в
// детекторе: модели отдаётся сырой текст.
function normalizeLookalikes(text: string): {
  text: string;
  normalized: number;
} {
  let normalized = 0;
  const probe = Array.from(text)
    .map((c) => {
      if (LOOKALIKES[c]) {
        normalized++;
        return LOOKALIKES[c];
      }
      return c;
    })
    .join("");
  return { text: probe, normalized };
}

/**
 * Санитайзер входа плюс запись вердикта в журнал хода. Обёртка, а не строка внутри
 * правил: вердиктов у гейта два (ранний выход и обычный), а событие обязано быть одно —
 * иначе журнал показывал бы вход, который гейт не смотрел (ADR-0010).
 *
 * САМ ГЕЙТ ОСТАЁТСЯ ЧИСТЫМ: событие пишется, только когда вызов идёт внутри хода
 * (контекст ставят inbound-пайплайн и web-тулы). Вне хода — юнит-тест, скрипт, чужой
 * вызов — на диск не уходит ничего, и вердикт без ключа хода в журнале не появляется.
 */
export function sanitizeInbound(
  input: string,
  maxChars = 50000,
  options: SanitizeOptions = {},
): SanitizeResult {
  const verdict = judgeInbound(input, maxChars, options);
  traceInboundGate(options.surface ?? "telegram", verdict, input.length);
  return verdict;
}

function judgeInbound(
  input: string,
  maxChars: number,
  options: SanitizeOptions,
): SanitizeResult {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be a non-negative safe integer");
  }
  const rules = SURFACE_RULES[options.surface ?? "telegram"];
  const blockedPayload = (cleaned: string) =>
    rules.keepBlockedText
      ? capCodePoints(cleaned, maxChars)
      : {
          text: "",
          truncatedChars: 0,
        };
  const originalLen = input.length;
  const flags: string[] = [];

  let invisibleRemoved = 0;
  let text = input.replace(INVISIBLE_RE, (c) => {
    if (KEEP_CONTROL.has(c)) return c;
    invisibleRemoved++;
    return "";
  });
  // Дорогие письменности считаются на обеих поверхностях, а вырезаются только
  // там, где текст это сообщение. На web они и есть содержимое страницы, так
  // что расход держит бюджет, а не удаление: первые EXPENSIVE_SCRIPT_MAX_CHARS
  // таких символов остаются на месте, лишнее за бюджетом уходит и попадает в
  // счёт усечения. Модель получает тибетскую статью, а не строку пробелов
  // (ADR-0006). Бюджет считается по символам письменности, а не по длине
  // текста: страница на латинице с цитатой на Брайле доезжает целой.
  //
  // Бюджет применяется ДО проверки на invisible-flood, а не после: иначе
  // страница, которая несёт и невидимый флуд, и глифы, уезжала бы к модели
  // ранним возвратом флуда — целиком, мимо бюджета. Чем больше невидимого
  // мусора добавил бы атакующий, тем меньше резалась бы дорогая письменность.
  // Порядок самих проверок при этом прежний: сначала флуд, потом wallet-drain,
  // — и telegram-поверхность не видит разницы, там текст обнуляется в обоих
  // случаях. Проходы независимы: невидимые знаки (Cf/Cc) в диапазоны дорогих
  // письменностей не входят, поэтому счёт глифов от порядка не зависит.
  let expensiveChars = 0;
  let expensiveDropped = 0;
  text = text.replace(WALLET_DRAIN_RE, (glyph) => {
    expensiveChars++;
    if (rules.stripExpensiveScripts) return "";
    if (expensiveChars <= EXPENSIVE_SCRIPT_MAX_CHARS) return glyph;
    expensiveDropped++;
    return "";
  });
  const blockedWithBudget = (reason: string, flag: string): SanitizeResult => {
    const payload = blockedPayload(text);
    return {
      ...payload,
      truncatedChars: payload.truncatedChars + expensiveDropped,
      blocked: true,
      reason,
      flags: [flag],
    };
  };

  if (originalLen > 100 && invisibleRemoved > originalLen * 0.05) {
    return blockedWithBudget(
      `Excessive invisible characters: ${invisibleRemoved} (${Math.floor((invisibleRemoved * 100) / originalLen)}%)`,
      "invisible-flood",
    );
  }
  if (invisibleRemoved) flags.push(`invisible=${invisibleRemoved}`);

  if (expensiveChars > 50) {
    return blockedWithBudget(
      `Wallet drain attempt: ${expensiveChars} expensive Unicode chars`,
      "wallet-drain",
    );
  }

  const { text: probe, normalized } = normalizeLookalikes(text);
  if (normalized) flags.push(`lookalikes=${normalized}`);

  // Правила читают несколько видов одного текста. Сырой и нормализованный
  // буквами-двойниками: латиницу нормализация не трогает, поэтому английские и
  // узбекские правила видят в probe и обычный текст, и маскировку; кириллице
  // она ломает само слово («игнорируй» → «игнopиpyй»), так что русские правила
  // работают по сырому. На web добавляется NFKC-вид: там дорогие письменности
  // остаются в тексте, а математическая латиница читается моделью как обычные
  // буквы («𝐢𝐠𝐧𝐨𝐫𝐞 𝐚𝐥𝐥 𝐩𝐫𝐞𝐯𝐢𝐨𝐮𝐬 𝐢𝐧𝐬𝐭𝐫𝐮𝐜𝐭𝐢𝐨𝐧𝐬»). Одинаковые виды схлопывает Set.
  // Счёт маркеров — больший из видов, override — сработка хоть на одном.
  const views = new Set([text, probe]);
  if (rules.foldCompatibility) {
    const folded = text.normalize("NFKC");
    views.add(folded);
    views.add(normalizeLookalikes(folded).text);
  }
  const roleMarkers = Math.max(
    ...[...views].map((view) => (view.match(rules.roleMarker) || []).length),
  );
  const overrides = rules.overrides.filter((re) =>
    [...views].some((view) => re.test(view)),
  ).length;
  if (roleMarkers) flags.push(`role-markers=${roleMarkers}`);
  if (overrides) flags.push(`overrides=${overrides}`);

  const capped = capCodePoints(text, maxChars);
  text = capped.text;
  const truncatedChars = capped.truncatedChars;

  if ((roleMarkers >= 2 && overrides >= 1) || overrides >= 3) {
    return {
      text,
      blocked: true,
      reason: `Prompt injection: ${roleMarkers} role markers, ${overrides} override attempts`,
      flags,
      truncatedChars,
    };
  }
  return { text, blocked: false, reason: "clean", flags, truncatedChars };
}

// The shapes the providers of this installation actually issue - agent/provider.ts
// (ollama, opencode, openrouter, codex/OpenAI, custom, requesty) and agent/lib/embeddings.ts
// (jina, deepinfra) - plus the neighbours that share the same .env. A key body carries
// hyphens and underscores (sk-proj-…, sk-or-v1-…, sk-ant-api03-…_…), so a class that
// stops at the first hyphen lets a live key through whole: that is the leak these
// patterns close. The lookbehind keeps ordinary prose out ("risk-adjusted-return-…"
// must not become a finding), and each family keeps its own name so the log says
// which key leaked.
// Ollama Cloud, DeepInfra and Deepgram issue keys with no telltale prefix. They are
// caught by the name beside them - generic_key (any *_API_KEY=… or "api key": …),
// bearer_token, dot_env_content. A bare high-entropy blob with no name next to it is
// deliberately not matched: no rule tells it from ordinary text, and redacting the
// model's own answers costs more than that miss.
// The custom provider (MODEL_PROVIDER=custom) is exactly that case and has no pattern
// here on purpose: the endpoint is the owner's, so its key can look like anything, and
// a rule invented for it would either miss or redact ordinary text. CUSTOM_API_KEY is
// therefore covered only by its name - it is in the named_secret inventory next door,
// like every other prefixless key.
const API_KEY_PATTERNS: readonly Pattern[] = [
  ["named_secret", NAMED_SECRET_PATTERN],
  ["openai", /(?<![A-Za-z0-9])sk-(?!ant-|or-)[A-Za-z0-9_-]{20,}/g],
  ["openrouter", /(?<![A-Za-z0-9])sk-or-(?:v\d+-)?[A-Za-z0-9_-]{20,}/g],
  // Requesty: rqsty-sk-… with a base64 body, so + / = sit next to the usual - and _.
  ["requesty", /(?<![A-Za-z0-9])rqsty-[A-Za-z0-9+/=_-]{20,}/g],
  ["anthropic", /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["groq", /(?<![A-Za-z0-9])gsk_[A-Za-z0-9]{20,}/g],
  ["jina", /(?<![A-Za-z0-9])jina_[A-Za-z0-9_-]{20,}/g],
  // OAuth access token of the ChatGPT subscription (codex) and DeepInfra's scoped
  // token: a three-segment JWT, base64url, always starting from the `{"` header.
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["google_api", /AIza[A-Za-z0-9\-_]{35}/g],
  ["github_pat", /ghp_[A-Za-z0-9]{36}/g],
  ["github_fine", /github_pat_[A-Za-z0-9_]{82}/g],
  ["slack_bot", /xoxb-[0-9]{10,}-[A-Za-z0-9]+/g],
  ["slack_user", /xoxp-[0-9]{10,}-[A-Za-z0-9]+/g],
  ["telegram_bot", /\d{8,10}:[A-Za-z0-9_-]{35}/g],
  ["aws_access", /AKIA[A-Z0-9]{16}/g],
  ["stripe", /sk_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ["sendgrid", /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g],
  ["vercel", /vercel_[A-Za-z0-9_]{20,}/g],
  ["supabase", /sbp_[A-Za-z0-9]{40,}/g],
  ["fal_key", /fal_[A-Za-z0-9_]{20,}/g],
  ["bearer_token", /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi],
  // The name a prefixless key travels with, in every form a notice shows it: an env
  // line (OLLAMA_API_KEY=…), a config dump ("DEEPINFRA_API_KEY": "…"), a sentence
  // from the provider itself ("api key: …").
  [
    "generic_key",
    /(?:api[\s_-]?key|apikey|api[\s_-]?token)["']?\s*[=:]\s*["']?[A-Za-z0-9\-._]{20,}/gi,
  ],
  [
    "generic_secret",
    /(?:secret|password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{8,}/gi,
  ],
  // A credential that travels as part of an address rather than beside a name -
  // how MEMORY_EMBED_URL carries the DeepInfra key, and a proxy, a Postgres or a
  // Redis URL its own. The shape of the userinfo is the provider's business, so
  // the position is the whole rule: right after `://` and right before the `@` of
  // a host. Both halves go, because either can be the secret; the host stays, or
  // a notice about a failed call stops saying which call failed. The colon is what
  // keeps ordinary text out: `git@github.com:…` has no `://`, `https://user@host`
  // has no password, and an address in prose has neither.
  // The user half may be empty (`redis://:password@host`); the secret half may not.
  ["url_userinfo", /(?<=:\/\/)[^\s/?#@:]*:[^\s/?#@]+(?=@[^\s/?#]+)/g],
];

const INTERNAL_PATH_PATTERNS: readonly Pattern[] = [
  [
    "home_dotfiles",
    /(?:\/home\/\w+|~)\/\.(?:ssh|config|env|gnupg|aws|docker|kube)/g,
  ],
  ["etc_sensitive", /\/etc\/(?:shadow|passwd|sudoers|ssh)/g],
  ["run_secrets", /\/run\/secrets\/\w+/g],
  ["proc_environ", /\/proc\/\w+\/environ/g],
  ["dot_env_content", /^\w+_(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*.+$/gm],
];

const EXFIL_PATTERNS: readonly Pattern[] = [
  [
    "markdown_image_exfil",
    /!\[.*?\]\(https?:\/\/[^)]*(?:token|key|secret|api|auth|password|env|data=)[^)]*\)/gi,
  ],
  [
    "html_img_exfil",
    /<img[^>]+src\s*=\s*["']https?:\/\/[^"']*(?:token|key|secret|api|auth)[^"']*["']/gi,
  ],
  [
    "url_with_secret_param",
    /https?:\/\/[^\s]*[?&](?:token|key|secret|api_key|password|auth)=[^\s&]{8,}/gi,
  ],
];

const INJECTION_ARTIFACTS: readonly Pattern[] = [
  [
    "special_tokens",
    /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/g,
  ],
];

const REDACTED = "[REDACTED]";

export function scanOutbound(input: string, redact = true): OutboundResult {
  let text = input;
  const findings: OutboundFinding[] = [];
  const groups: ReadonlyArray<
    readonly [type: string, patterns: readonly Pattern[]]
  > = [
    ["api_key", API_KEY_PATTERNS],
    ["internal_path", INTERNAL_PATH_PATTERNS],
    ["data_exfil", EXFIL_PATTERNS],
  ];
  for (const [type, patterns] of groups) {
    for (const [name, re] of patterns) {
      const matches = input.match(re);
      if (!matches) continue;
      for (const match of matches) {
        findings.push({ type, name, preview: match.slice(0, 12) + "…" });
        if (redact) text = text.split(match).join(REDACTED);
      }
    }
  }
  for (const [name, re] of INJECTION_ARTIFACTS) {
    const matches = input.match(re);
    if (matches) {
      for (const match of matches) {
        findings.push({
          type: "injection_artifact",
          name,
          preview: match.slice(0, 20),
        });
      }
    }
  }
  const clean = findings.every(
    (finding) => finding.type === "injection_artifact",
  );
  return { clean, text, findings };
}
