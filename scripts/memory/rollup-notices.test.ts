/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
// Контракт ночной свёртки как ОТПРАВИТЕЛЯ — и он честно грепный, а не поведенческий.
//
// Поведение доставки живёт в scripts/lib/notice-policy.test.ts и проверено там настоящим
// транспортом: сколько сообщений уходит за прогон, какое именно, что видит свежая
// установка в первую и во вторую ночь. Сам rollup.ts здесь запустить нечем — он ведёт
// живого агента через eve/client, — а промпт исполняет модель, и ни то ни другое в
// юнит-тесте не воспроизводится. Поэтому здесь проверяется ровно то, что проверяемо
// текстом: что свёртка отдала решение политике и передала ей правильный признак, что
// молчаливые периоды остались молчаливыми, и что системный красный блок инструкций не
// спорит с хвостом ночного промпта.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const source = readFileSync(join(HERE, "rollup.ts"), "utf8");

/** Тело блока «этот период вообще может писать в Telegram», от заголовка до конца файла. */
function deliveryBlock(): string {
  const at = source.indexOf("if (REPORTS_TO_TELEGRAM[period]) {");
  assert.notEqual(at, -1, "the delivery block must stay one readable place");
  return source.slice(at);
}

test("monthly and yearly rollups stay silent, as they always were", () => {
  const table = /const REPORTS_TO_TELEGRAM[^;]+;/u.exec(source)?.[0] ?? "";
  assert.match(table, /daily: true/u);
  assert.match(table, /weekly: true/u);
  assert.match(table, /monthly: false/u);
  assert.match(table, /yearly: false/u);
});

test("what leaves the chat is decided by the policy, not by the script", () => {
  const block = deliveryBlock();
  assert.match(block, /await deliverMemoryReport\(\{/u);
  assert.match(block, /settings,/u);
  assert.match(block, /ranBefore: RAN_BEFORE,/u);
  // Оба шва отправки отчёта — только аргументы этого решения; своей отправки у свёртки нет.
  assert.equal(block.split("sendTelegramHtml(").length - 1, 2);
  // Четвёртый аргумент — только имя хода для журнала (ADR-0010): что уходит в чат, он
  // не решает. Сама отправка остаётся тем же одним швом.
  assert.equal(
    block.split("session: activeSession.state.sessionId").length - 1,
    2,
    "both Report seams must carry the Rollup session ID into Trace",
  );
  // Чат не настроен — решение о Notice всё равно принимается: send просто null.
  assert.match(block, /: null;/u);
  assert.match(block, /send,/u);
});

test("the CORE alert goes out through the throttle, not straight to the chat", () => {
  const at = source.indexOf("async function alertOwner(");
  assert.notEqual(at, -1, "the alert seam must stay one readable place");
  const seam = source.slice(at, source.indexOf("\n}", at));
  // Alert не выключается, поэтому не имеет права повторяться чаще раза в неделю: решает
  // это дроссель, а не свёртка (ADR-0007).
  assert.match(seam, /await alertOnce\(DATA_DIR, key, essence,/u);
  assert.equal(seam.split("sendTelegramHtml(").length - 1, 1);
  // Больше отправок в файле нет: два шва отчёта и один шов алерта.
  assert.equal(source.split("sendTelegramHtml(").length - 1, 3);
});

test("the run reads the traces of past runs before it leaves its own", () => {
  // Единственная проводка, которую политика увидеть не может: след читается ДО того, как
  // прогон оставит свой собственный. Прочитанный после, он был бы true у всех.
  assert.match(
    source,
    /const RAN_BEFORE = rollupRanBefore\(DATA_DIR, VAULT\(\)\);/u,
  );
  assert.ok(
    source.indexOf("const RAN_BEFORE") < source.indexOf("saveSession("),
    "reading it after the save would make every installation look old",
  );
});

test("the delivery half of the prompt is the one that carries the language", () => {
  assert.match(source, /const tail = memoryReportTail\(tr\);/u);
  // Хардкод старого хвоста ушёл целиком: иначе отчёт снова поедет на языке инструкции.
  assert.doesNotMatch(source, /what was created\/updated/u);
  assert.doesNotMatch(source, /Only the finished report/u);
  // Обработка карточек не тронута: язык добавлен только в доставку.
  assert.match(source, /Prefer the write_card tool over write_file/u);
  assert.match(source, /no H1\/H2 headings/u);
});

test("the delivery rule names every scheduled sender", () => {
  // Блок доставки системных инструкций говорит, что отчёт — обычный ответ хода: отправку
  // делает код Outbox. В плановых ходах финальный текст тоже доставляет код, и они названы
  // прямо: без этого модель считает отправленным уже готовый текст, и владелец получает
  // второе сообщение мимо кода доставки.
  const instructions = readFileSync(
    join(ROOT, "agent/instructions.md"),
    "utf8",
  );
  const start = instructions.indexOf("## Delivery");
  assert.notEqual(start, -1, "the delivery block must stay in the persona");
  const end = instructions.indexOf("\n## ", start + 1);
  const delivery = instructions.slice(start, end === -1 ? undefined : end);
  assert.match(delivery, /ordinary turn reply/u);
  // Транспорт мимо Outbox убран: он же обход outbound-гейта.
  assert.doesNotMatch(delivery, /only rich message/iu);
  assert.match(delivery, /Never send to the current chat yourself/u);
  // Все три плановых хода названы одним предложением: это и есть исключение из
  // «никогда не слать самой».
  assert.match(
    delivery,
    /Scheduled turns \([^)]*nightly memory[^)]*morning digest[^)]*remind/u,
    "the delivery rule must name the nightly memory pass, the morning digest and the reminder turn",
  );
  assert.match(delivery, /deliver the final text/u);
  // Режимов доставки в персоне нет: путь один — код шлёт текст в срок и будит агента.
  assert.doesNotMatch(instructions, /verbatim|mode:/iu);
});

test("a noise report is skipped before it reaches the policy", () => {
  const block = deliveryBlock();
  // Шум-гейт стоит ДО deliverMemoryReport: «.» и другой мусор не доходят до политики.
  const guardAt = block.indexOf("noise guard");
  const deliveryAt = block.indexOf("await deliverMemoryReport({");
  assert.notEqual(guardAt, -1, "the noise guard must stay one readable place");
  assert.ok(
    guardAt < deliveryAt,
    "the noise guard must run before the delivery policy",
  );
  assert.match(block, /hasTextSubstance\(/u);
  assert.match(block, /reportText\.length < 8/u);
  // Роллап при этом успешен: шум не роняет ночь.
  assert.match(block, /process\.exit\(0\)/u);
});

test("hasTextSubstance treats punctuation-only text as noise", async () => {
  const { hasTextSubstance } = await import("../lib/notice-policy.ts");
  assert.equal(hasTextSubstance("."), false);
  assert.equal(hasTextSubstance("   "), false);
  assert.equal(hasTextSubstance("—"), false);
  assert.equal(hasTextSubstance("Отчёт за день"), true);
  assert.equal(hasTextSubstance("42"), true);
});
