// Deepgram: транскрипция голоса/видео (nova-3, language=multi). Пара с vision.ts —
// вторая половина «понять присланный файл», которую канал приносит в inbound-пайплайн.
// Тело запроса — сырые байты, ответ → results.channels[0].alternatives[0].transcript.

// Имена и термины владельца (DEEPGRAM_KEYTERMS, через запятую) уходят в запрос параметром
// keyterm, по одному на слово: так nova-3 пишет их одинаково, а не «OJ» в одном голосовом и
// «О, Джей» в другом (Keyterm Prompting). Лимит у Deepgram — 500 токенов на все keyterm
// запроса вместе, сверх него отказ «Keyterm limit exceeded» получает весь запрос, и голосовое
// остаётся без расшифровки. Как Deepgram считает токены, документация не пишет; при любом
// разбиении, где токен занимает хотя бы байт, 500 байт UTF-8 — не больше 500 токенов, поэтому
// слова идут в запрос, пока их вместе не больше 500 байт. Число слов отдельно: Deepgram
// советует держать 20–50 самых важных.
export const KEYTERMS_LIMIT = 50;
export const KEYTERMS_BYTES = 500;

/**
 * Слова из значения DEEPGRAM_KEYTERMS: разделитель — запятая (и перевод строки, если список
 * вставили столбиком), края обрезаны, пустые и повторы выброшены, порядок владельца сохранён.
 * Этим же разбором экран «Голос» нормализует ввод перед записью в .env.
 */
export function parseKeyterms(raw: string | undefined): string[] {
  const terms = new Set<string>();
  for (const part of (raw ?? "").split(/[,\n]/u)) {
    const term = part.trim();
    if (term) terms.add(term);
  }
  return [...terms];
}

/**
 * Слова, которые уходят в запрос: первые по порядку владельца, пока их не больше
 * KEYTERMS_LIMIT и вместе не больше KEYTERMS_BYTES байт UTF-8. Первое не поместившееся слово
 * обрывает список: короткие после него не подбираются, порядок остаётся порядком важности.
 */
export function keytermsForRequest(terms: string[]): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const term of terms) {
    bytes += Buffer.byteLength(term, "utf8");
    if (kept.length === KEYTERMS_LIMIT || bytes > KEYTERMS_BYTES) break;
    kept.push(term);
  }
  return kept;
}

// Хвост запроса с keyterm; без настройки — пустая строка, и запрос совпадает с прежним байт в байт.
function keytermQuery(raw: string | undefined): string {
  const terms = parseKeyterms(raw);
  const kept = keytermsForRequest(terms);
  if (kept.length < terms.length)
    // Только счёт: сами слова — имена людей владельца, им в журнале не место.
    console.warn(
      `[transcribe] DEEPGRAM_KEYTERMS: в запрос идут ${kept.length} из ${terms.length} ` +
        `(не больше ${KEYTERMS_LIMIT} слов и ${KEYTERMS_BYTES} байт)`,
    );
  return kept.map((term) => `&keyterm=${encodeURIComponent(term)}`).join("");
}

export async function transcribe(audio: ArrayBuffer): Promise<string> {
  const language = process.env.DEEPGRAM_LANGUAGE || "multi";
  const url =
    `https://api.deepgram.com/v1/listen?model=nova-3&language=${language}` +
    `&punctuate=true&smart_format=true` +
    keytermQuery(process.env.DEEPGRAM_KEYTERMS);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY ?? ""}`,
      "Content-Type": "application/octet-stream",
    },
    body: audio,
  });
  if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: {
      channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    };
  };
  return json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}
