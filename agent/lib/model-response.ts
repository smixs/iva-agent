export type ModelFailure = {
  code?: string;
  details?: { semanticErrorId?: string };
  stepIndex?: number;
  message?: string;
};
export function isEmptyModelResponse(failure?: ModelFailure): boolean {
  return failure?.details?.semanticErrorId === "empty-model-response";
}
export function stepLimitNotice(
  failure: ModelFailure | undefined,
  tr: (en: string, ru: string) => string,
): string | null {
  const n = (failure?.stepIndex ?? 0) + 1;
  return failure?.code === "STEP_LIMIT_REACHED"
    ? tr(
        `Stopped after ${n} ${n === 1 ? "step" : "steps"} without a final summary.`,
        `Остановилась на ${n} ${n % 10 === 1 && n % 100 !== 11 ? "шаге" : "шагах"} и не успела подвести итог.`,
      )
    : null;
}
