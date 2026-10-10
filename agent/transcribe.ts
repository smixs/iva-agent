// Deepgram: транскрипция голоса/видео (nova-3, language=multi). Пара с vision.ts —
// вторая половина «понять присланный файл», которую канал приносит в inbound-пайплайн.
// Тело запроса — сырые байты, ответ → results.channels[0].alternatives[0].transcript.

// Имена и термины владельца (DEEPGRAM_KEYTERMS, через запятую) уходят в запрос параметром
// keyterm, по одному на слово: так nova-3 пишет их одинаково, а не «OJ» в одном голосовом и
// «О, Джей» в другом (Keyterm Prompting). У Deepgram потолок около 500 токенов на запрос,
// сверх него весь запрос получает 400; поэтому в запрос идут только первые 50 слов.
export const KEYTERMS_LIMIT = 50;

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

// Хвост запроса с keyterm; без настройки — пустая строка, и запрос совпадает с прежним байт в байт.
function keytermQuery(raw: string | undefined): string {
  const terms = parseKeyterms(raw);
  if (terms.length > KEYTERMS_LIMIT)
    // Только счёт: сами слова — имена людей владельца, им в журнале не место.
    console.warn(
      `[transcribe] DEEPGRAM_KEYTERMS: ${terms.length} слов, в запрос идут первые ${KEYTERMS_LIMIT}`,
    );
  return terms
    .slice(0, KEYTERMS_LIMIT)
    .map((term) => `&keyterm=${encodeURIComponent(term)}`)
    .join("");
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
