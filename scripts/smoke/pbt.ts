import fc from "fast-check";

/** fast-check reports the seed and shrink path on every failure. */
export function smokeParameters() {
  return {
    numRuns: Number(process.env.SMOKE_RUNS ?? 30),
    ...(process.env.SMOKE_SEED === undefined
      ? {}
      : { seed: Number(process.env.SMOKE_SEED) }),
  };
}
export { fc };
