import { readModelAuthStatuses } from "./model-auth-state.ts";
import { runAuthAlert } from "./model-auth-alert.ts";

import type { AuthObservation } from "./model-auth-state.ts";
export type { AuthObservation } from "./model-auth-state.ts";
// All hook events and minute ticks share this queue in the single agent process.
// Each operation finishes before the next starts. The agent alone writes auth records.
export function createAuthDispatcher(
  run: (observation?: AuthObservation) => Promise<void>,
) {
  let pending = Promise.resolve();
  return (observation?: AuthObservation): Promise<void> => {
    pending = pending
      .then(() => run(observation))
      .catch((error) => console.error("model auth alert:", error));
    return pending;
  };
}
export const dispatchModelAuth = createAuthDispatcher((observation) => {
  if (
    observation?.failed === false &&
    !readModelAuthStatuses().some(
      (status) => status.failedAt > status.successAt,
    )
  )
    return Promise.resolve();
  return runAuthAlert(observation);
});
