// Model-login evidence and Alert policy run serially in the agent process.
import { join } from "node:path";
import { execFile } from "node:child_process";
import { acquireFileLockSync, releaseFileLock } from "#lib/fs-atomic.ts";
import { getLang } from "./i18n.ts";
import { dataDir } from "./data-dir.ts";
import { readFactsSync, jobFactsFile, latestFact } from "./job-facts.ts";
import {
  modelAuthFailure,
  modelAuthProvider,
  modelAuthSuccess,
  modelAuthText,
  modelAuthRecoveryText,
  MODEL_AUTH_REPEAT_MS,
  type AuthLanguage,
} from "./model-auth.ts";
import {
  authKey,
  authFactKey,
  parseAuthStatus,
  readModelAuthStatuses,
  type ModelAuthStatus,
} from "./model-auth-state.ts";
import type { AuthObservation } from "./model-auth-state.ts";
import { isQuietHour, parseProactive } from "./proactive-config.ts";
import { readSettingsState } from "./settings.ts";
import { resolveTimeZone } from "./timezone.ts";
import {
  configureAlertLock,
  recordAlert,
  alertOnce,
  alertResolved,
  readAlertState,
  updateAlertState,
} from "../../packages/alert-state/index.ts";

configureAlertLock({ acquireFileLockSync, releaseFileLock });

export function observeModelAuth(
  dir: string,
  observation: AuthObservation,
  job?: string,
): void {
  const key = authFactKey(observation.provider);
  const saved = updateAlertState(dir, (state) => {
    const previous = parseAuthStatus(state[key]?.essence ?? "");
    const next: ModelAuthStatus = previous ?? {
      provider: observation.provider,
      since: observation.at,
      failedAt: 0,
      successAt: 0,
      answers: false,
      jobs: [],
    };
    if (observation.failed && !applyFailure(next, observation, job))
      return false;
    if (!observation.failed)
      next.successAt = Math.max(next.successAt, observation.at);
    const essence = JSON.stringify(next);
    if (state[key]?.essence === essence) return false;
    state[key] = { essence, lastSentAt: 0 };
    return true;
  });
  if (!saved)
    throw new Error("Could not persist model authentication evidence");
}

function applyFailure(
  next: ModelAuthStatus,
  observation: AuthObservation,
  job?: string,
): boolean {
  if (observation.at <= next.successAt) return false;
  if (next.failedAt <= next.successAt) {
    next.since = observation.at;
    next.answers = false;
    next.jobs = [];
  }
  next.since = Math.min(next.since, observation.at);
  next.failedAt = Math.max(next.failedAt, observation.at);
  next.answers ||= observation.answers === true;
  if (job && !next.jobs.includes(job)) next.jobs.push(job);
  return true;
}

export type AuthTickOptions = {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  lang?: AuthLanguage;
  send?: (text: string) => Promise<boolean>;
};
export async function tickModelAuth({
  dir = dataDir(),
  env = process.env,
  lang,
  send,
}: AuthTickOptions = {}): Promise<void> {
  const provider = modelAuthProvider(env);
  updateAlertState(dir, (state) => {
    const obsolete = Object.keys(state).filter(
      (key) =>
        (key.startsWith("model-auth:") && key !== authKey(provider)) ||
        (key.startsWith("model-auth-fact:") && key !== authFactKey(provider)),
    );
    for (const key of obsolete) delete state[key];
    return obsolete.length > 0;
  });
  const facts = loadAuthFacts(dir);
  applyAuthFacts(dir, facts, env);
  const now = Date.now();
  const config = readSettingsState(join(dir, "settings.json"));
  const settings = config.state === "valid" ? config.settings : {};
  const timeZone = resolveTimeZone(env.ASSISTANT_TIMEZONE);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  if (isQuietHour(parseProactive(settings), hour)) return;
  const language = lang ?? getLang();
  const deliver = send ?? sendModelAuthNotice;
  for (const status of readModelAuthStatuses(dir).filter(
    (status) => status.provider === provider,
  )) {
    await deliverAuthStatus(status, {
      dir,
      facts,
      language,
      timeZone,
      deliver,
    });
  }
}

function loadAuthFacts(dir: string): ReturnType<typeof readFactsSync> {
  try {
    return readFactsSync(jobFactsFile(dir));
  } catch (error) {
    console.error("model auth jobs:", error);
    return [];
  }
}
function applyAuthFacts(
  dir: string,
  facts: ReturnType<typeof readFactsSync>,
  env: NodeJS.ProcessEnv,
): void {
  for (const fact of facts) {
    const failure = modelAuthFailure(fact.tail, env.MODEL_PROVIDER);
    if (!fact.ok && !fact.acked && failure)
      observeModelAuth(
        dir,
        { provider: failure, at: fact.finishedAt, failed: true },
        fact.name,
      );
    const success = modelAuthSuccess(fact.tail);
    if (success && success.provider === modelAuthProvider(env) && !failure)
      observeModelAuth(dir, { ...success, failed: false });
  }
}
async function deliverAuthStatus(
  status: ModelAuthStatus,
  context: {
    dir: string;
    facts: ReturnType<typeof readFactsSync>;
    language: AuthLanguage;
    timeZone: string;
    deliver: (text: string) => Promise<boolean>;
  },
): Promise<void> {
  const { dir, facts, language, timeZone, deliver } = context;
  const key = authKey(status.provider);
  if (status.failedAt > status.successAt) {
    await alertOnce(
      dir,
      key,
      "expired",
      () =>
        deliver(
          modelAuthText(status.provider, language, { ...status, timeZone }),
        ),
      MODEL_AUTH_REPEAT_MS,
    );
    return;
  }
  if (!Object.hasOwn(readAlertState(dir), key)) return;
  const jobs = [...new Set(facts.map((fact) => fact.name))].filter((name) => {
    const latest = latestFact(facts, name);
    return (
      latest !== null &&
      !latest.ok &&
      !latest.acked &&
      status.jobs.includes(name)
    );
  });
  if (await deliver(modelAuthRecoveryText(status.provider, language, jobs)))
    alertResolved(dir, key);
}

// The child is transport only. All evidence and alertOnce writes happen in this agent process.
function sendModelAuthNotice(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["scripts/model-auth-alert.ts", text],
      { cwd: process.cwd(), timeout: 30_000, maxBuffer: 64 * 1024 },
      (error) => resolve(error === null),
    );
  });
}
export async function runAuthAlert(
  observation?: AuthObservation,
  options: AuthTickOptions = {},
): Promise<void> {
  const dir = options.dir ?? dataDir();
  if (observation) {
    if (observation.reply) {
      try {
        await observation.reply();
        if (observation.ownerReply)
          recordAlert(dir, authKey(observation.provider), "expired");
      } catch (error) {
        console.error("model auth reply:", error);
      }
    }
    observeModelAuth(dir, observation);
  }
  await tickModelAuth({ ...options, dir });
}
