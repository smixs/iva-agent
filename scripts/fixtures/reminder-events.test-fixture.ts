import { runReminderTurn, type TurnStreamEvent } from "../lib/reminder-turn.ts";

/** Real event settlement with an in-memory eve session. */
export function reminderFromEvents(events: readonly TurnStreamEvent[]) {
  return runReminderTurn(
    "fixture",
    {
      host: "http://fixture.invalid",
      auth: { bearer: () => Promise.resolve("fixture") },
    },
    {
      createClient: () =>
        Promise.resolve({
          sessions: {
            create: () =>
              Promise.resolve({
                response: Object.assign(
                  (async function* () {
                    await Promise.resolve();
                    yield* events;
                  })(),
                  { sessionId: "fixture", cancel: () => Promise.resolve() },
                ),
                session: {
                  send: () => Promise.resolve(),
                  cancel: () => Promise.resolve(),
                  reset: () => Promise.resolve(),
                },
              }),
          },
        }),
    },
  );
}

export function failedModelEvents(code = "STEP_LIMIT_REACHED", stepIndex = 39) {
  const data = {
    code,
    message: "upstream failure",
    details: { semanticErrorId: "empty-model-response" },
  };
  return [
    { type: "step.failed", data: { ...data, stepIndex } },
    { type: "turn.failed", data: { ...data, sequence: 1 } },
    { type: "session.waiting" },
  ];
}
