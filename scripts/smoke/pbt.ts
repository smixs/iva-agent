import { randomInt } from "node:crypto";
import fc from "fast-check";

/** fast-check reports the seed and shrink path on every failure. */
export function smokeParameters() {
  const seed = Number(process.env.SMOKE_SEED ?? randomInt(0x7fffffff));
  const numRuns = Number(process.env.SMOKE_RUNS ?? 30);
  if (!Number.isInteger(seed) || !Number.isSafeInteger(numRuns) || numRuns < 1)
    throw new Error(
      "SMOKE_SEED must be an integer; SMOKE_RUNS must be positive",
    );
  console.log(`SMOKE_SEED=${seed} SMOKE_RUNS=${numRuns}`);
  return { seed, numRuns };
}

export { fc };
