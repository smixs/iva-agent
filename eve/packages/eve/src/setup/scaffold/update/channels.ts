import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { pathExists } from "../files.js";
import { getSupportedModuleBaseName, matchesSupportedModuleBaseName } from "./module-files.js";

const NEXT_PACKAGE_NAME = "next";
const PACKAGE_DEPENDENCY_FIELDS = ["dependencies", "devDependencies"] as const;

export type ChannelKind = "slack" | "web";

export interface PackageJsonMutation {
  path: string;
  dependencies: string[];
  devDependencies: string[];
  scripts: string[];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read and parse a project's `package.json` into a plain object, or `undefined`
 * when it is missing or does not parse to a JSON object.
 */
async function readPackageJsonObject(
  packageJsonPath: string,
): Promise<Record<string, unknown> | undefined> {
  if (!(await pathExists(packageJsonPath))) return undefined;

  const parsed: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
  return isJsonObject(parsed) ? parsed : undefined;
}

function packageJsonHasDependency(
  parsed: Record<string, unknown>,
  dependencyName: string,
): boolean {
  for (const field of PACKAGE_DEPENDENCY_FIELDS) {
    const dependencies = parsed[field];
    if (isJsonObject(dependencies) && typeof dependencies[dependencyName] === "string") {
      return true;
    }
  }
  return false;
}

async function hasPackageDependency(
  packageJsonPath: string,
  dependencyName: string,
): Promise<boolean> {
  const parsed = await readPackageJsonObject(packageJsonPath);
  return parsed !== undefined && packageJsonHasDependency(parsed, dependencyName);
}

/**
 * Host-framework dependency → the Vercel Framework Preset slug it must deploy
 * under (so the framework owns the top-level build and eve runs as a sibling).
 */
const VERCEL_HOST_FRAMEWORK_PRESETS: Readonly<Record<string, string>> = {
  "@sveltejs/kit": "sveltekit",
  [NEXT_PACKAGE_NAME]: "nextjs",
  nuxt: "nuxtjs",
  nuxt3: "nuxtjs",
  "nuxt-edge": "nuxtjs",
  "nuxt-nightly": "nuxtjs",
};

/** The Vercel Framework Preset slug for the host framework a project declares. */
export async function resolveVercelHostFrameworkPreset(
  projectRoot: string,
): Promise<string | undefined> {
  const parsed = await readPackageJsonObject(join(projectRoot, "package.json"));
  if (parsed === undefined) return undefined;

  for (const [dependencyName, preset] of Object.entries(VERCEL_HOST_FRAMEWORK_PRESETS)) {
    if (packageJsonHasDependency(parsed, dependencyName)) return preset;
  }
  return undefined;
}

/** Whether the root app declares a Vercel framework that owns its top-level deployment. */
export async function hasVercelHostFramework(projectRoot: string): Promise<boolean> {
  return (await resolveVercelHostFrameworkPreset(projectRoot)) !== undefined;
}

/**
 * Whether the project already carries a Next.js app: `package.json` declares a
 * `next` dependency in the same dependency fields Vercel framework detection
 * checks. A missing `package.json` reads as "no app".
 */
export async function isNextJsProject(projectRoot: string): Promise<boolean> {
  return hasPackageDependency(join(projectRoot, "package.json"), NEXT_PACKAGE_NAME);
}

export async function listAuthoredChannels(agentRoot: string): Promise<string[]> {
  const channelsDir = join(agentRoot, "channels");
  let entries;
  try {
    entries = await readdir(channelsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const channels: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      const baseName = getSupportedModuleBaseName(entry.name);
      if (baseName !== null) channels.push(baseName);
      continue;
    }
    if (entry.isDirectory()) {
      try {
        const inner = await readdir(join(channelsDir, entry.name));
        if (inner.some((fileName) => matchesSupportedModuleBaseName(fileName, "connection"))) {
          channels.push(entry.name);
        }
      } catch {
        // Skip unreadable directories.
      }
    }
  }

  return channels.sort();
}
