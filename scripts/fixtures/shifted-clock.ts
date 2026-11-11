import { readFileSync } from "node:fs";

// Часы процесса-двойника сдвинуты так, что «сейчас» начинается с IVA_TEST_NOW и дальше идёт
// с настоящей скоростью: тест ночи видит ту же неделю и те же готовые периоды в любой день
// запуска, а замки, сроки и таймеры тикают как обычно.
const start = process.env.IVA_TEST_NOW;
if (start) {
  const RealDate = Date;
  const shift = RealDate.parse(start) - RealDate.now();
  if (Number.isNaN(shift))
    throw new Error(`IVA_TEST_NOW is not a date: ${start}`);
  // A smoke can advance logical turn age while a provider reply is held, without sleeping.
  const clockFile = process.env.IVA_TEST_CLOCK_FILE;
  const advance = () =>
    clockFile ? Number(readFileSync(clockFile, "utf8")) : 0;
  class ShiftedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof RealDate> | []) {
      if (args.length === 0) super(RealDate.now() + shift + advance());
      else super(...args);
    }
    static override now(): number {
      return RealDate.now() + shift + advance();
    }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
}
