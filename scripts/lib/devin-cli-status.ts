import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function cliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...process.env, ...env };
  if (env.DEVIN_PROXY_URL)
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
    ])
      result[key] = env.DEVIN_PROXY_URL;
  return result;
}

export async function devinStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { stdout } = await exec(
    env.DEVIN_COMMAND || "devin",
    ["auth", "status"],
    { timeout: 15000, env: cliEnv(env) },
  );
  if (!stdout.includes("Logged in"))
    throw new Error("Devin CLI is not signed in — run devin auth login");
}

export async function listDevinModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const { stdout } = await exec(
    env.DEVIN_COMMAND || "devin",
    ["models", "list", "--format", "json"],
    { timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: cliEnv(env) },
  );
  const value: unknown = JSON.parse(stdout);
  if (
    !value ||
    typeof value !== "object" ||
    !("families" in value) ||
    !Array.isArray(value.families)
  )
    throw new Error("Invalid Devin model catalog");
  const ids: string[] = [];
  for (const family of value.families as unknown[]) {
    if (
      !family ||
      typeof family !== "object" ||
      !("variants" in family) ||
      !Array.isArray(family.variants)
    )
      throw new Error("Invalid Devin model family");
    for (const variant of family.variants as unknown[]) {
      if (
        !variant ||
        typeof variant !== "object" ||
        !("model_uid" in variant) ||
        typeof variant.model_uid !== "string" ||
        !variant.model_uid.trim()
      )
        throw new Error("Invalid Devin model id");
      ids.push(variant.model_uid);
    }
  }
  if (!ids.length) throw new Error("Devin returned an empty model catalog");
  return [...new Set(ids)];
}
