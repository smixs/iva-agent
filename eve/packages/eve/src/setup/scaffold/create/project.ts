import { stat } from "node:fs/promises";
import { join } from "node:path";

import { SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS } from "../update/module-files.js";
import { resolveVersionToken } from "../version-tokens.js";

export const CURRENT_DIRECTORY_PROJECT_NAME = ".";

export const DEFAULT_AI_PACKAGE_VERSION = "__AI_SDK_VERSION__";
export const DEFAULT_CONNECT_PACKAGE_VERSION = "__VERCEL_CONNECT_VERSION__";
export const DEFAULT_ZOD_PACKAGE_VERSION = "__ZOD_VERSION__";

/**
 * The eve package metadata that generated projects consume together. Keeping
 * the dependency version and Node.js requirement in one value prevents a
 * scaffold from installing one eve release while declaring another release's
 * runtime contract.
 */
export interface EvePackageContract {
  /** eve dependency version or npm specifier written to the generated package. */
  version: string;
  /** The matching eve release's authored `package.json` `engines.node` value. */
  nodeEngine: string;
}

export const DEFAULT_EVE_PACKAGE_CONTRACT: EvePackageContract = {
  version: "__EVE_PACKAGE_DEPENDENCY_VERSION__",
  nodeEngine: "__NODE_ENGINE__",
};

/** Resolves a stamped or explicitly supplied eve package contract. */
export function resolveEvePackageContract(
  contract: EvePackageContract = DEFAULT_EVE_PACKAGE_CONTRACT,
): EvePackageContract {
  return {
    version: resolveVersionToken("evePackage.version", contract.version),
    nodeEngine: resolveVersionToken("evePackage.nodeEngine", contract.nodeEngine),
  };
}

/**
 * Provider slug a gateway model id routes through: the segment before the
 * first "/" (e.g. `anthropic/claude-sonnet-5` → `anthropic`). The slug is
 * injected into generated source, so characters outside the catalog's slug
 * alphabet are dropped; an id without a usable prefix falls back to
 * `anthropic`.
 */
export function modelProviderSlug(modelId: string): string {
  const provider = (modelId.split("/")[0] ?? "").replaceAll(/[^A-Za-z0-9._-]/gu, "");
  return provider.length > 0 ? provider : "anthropic";
}

/**
 * Env var the byok scaffold reads the provider API key from, derived from the
 * model's provider slug (e.g. `anthropic/...` → `ANTHROPIC_API_KEY`). The name
 * is the scaffold's convention: the key is passed to the gateway `byok` block
 * explicitly, so users can rename it freely. Non-alphanumerics fold to `_`
 * and a leading digit is prefixed, keeping `process.env.<name>` valid source.
 */
export function byokProviderEnvVar(modelId: string): string {
  const name = modelProviderSlug(modelId)
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "_");
  return `${/^[0-9]/.test(name) ? "_" : ""}${name}_API_KEY`;
}

/** Trailing fields only written when the scaffold is not a workspace member. */
export const ROOT_ONLY_PACKAGE_JSON_TEMPLATE_SUFFIX = `,
  "engines": {
    "node": "__EVE_INIT_NODE_ENGINE__"
  }
`;

export async function isEveProject(projectRoot: string): Promise<boolean> {
  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    try {
      await stat(join(projectRoot, "agent", `agent${extension}`));
      return true;
    } catch {
      // Continue trying the other authored module extensions.
    }
  }
  return false;
}
