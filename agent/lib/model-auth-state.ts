import { dataDir } from "./data-dir.ts";
import { readAlertState } from "../../packages/alert-state/index.ts";

export const authKey = (provider: string) => `model-auth:${provider}`;
export const authFactKey = (provider: string) => `model-auth-fact:${provider}`;
export type ModelAuthStatus = {
  provider: string;
  since: number;
  failedAt: number;
  successAt: number;
  answers: boolean;
  jobs: string[];
};

export function parseAuthStatus(essence: string): ModelAuthStatus | null {
  try {
    const value = JSON.parse(essence) as ModelAuthStatus;
    return typeof value.provider === "string" &&
      [value.since, value.failedAt, value.successAt].every(Number.isFinite) &&
      typeof value.answers === "boolean" &&
      Array.isArray(value.jobs) &&
      value.jobs.every((job) => typeof job === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Read-only consumers. The agent dispatcher is the sole writer. */
export function readModelAuthStatuses(dir = dataDir()): ModelAuthStatus[] {
  return Object.entries(readAlertState(dir)).flatMap(([key, value]) => {
    if (!key.startsWith("model-auth-fact:")) return [];
    const status = parseAuthStatus(value.essence);
    return status ? [status] : [];
  });
}
export function pendingModelAuth(dir = dataDir()): ModelAuthStatus[] {
  return readModelAuthStatuses(dir).filter(
    (status) => status.failedAt > status.successAt,
  );
}

export type AuthObservation = {
  provider: string;
  at: number;
  failed: boolean;
  answers?: boolean;
  /** Transient channel transport; never stored. The agent queue owns delivery. */
  reply?: () => Promise<unknown>;
  ownerReply?: boolean;
};
