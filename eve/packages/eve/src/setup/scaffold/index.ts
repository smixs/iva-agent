export {
  byokProviderEnvVar,
  CURRENT_DIRECTORY_PROJECT_NAME,
  isEveProject,
  type EvePackageContract,
} from "./create/project.js";

export {
  scaffoldExtensionProject,
  type ScaffoldExtensionProjectOptions,
} from "./create/extension.js";

export {
  hasVercelHostFramework,
  isNextJsProject,
  listAuthoredChannels,
  resolveVercelHostFrameworkPreset,
  type ChannelKind,
} from "./update/channels.js";

export {
  ensureConnection,
  ensureConnectionDependencies,
  listAuthoredConnections,
  type ConnectionInput,
  type ConnectionMutationAction,
  type ConnectionMutationResult,
  type EnsureConnectionOptions,
  type EnsureConnectionDependenciesOptions,
} from "./update/connections.js";

export {
  catalogSlugs,
  CONNECTION_CATALOG,
  CUSTOM_CONNECTION_SLUG,
  effectiveProtocols,
  endpointForProtocol,
  getCatalogEntry,
  isValidConnectionSlug,
  SUPPORTED_PROTOCOLS,
  type ConnectionAuthSpec,
  type ConnectionCatalogEntry,
  type ConnectionProtocol,
  type CustomConnectionInput,
  type EnvHeader,
  type McpEndpoint,
  type OpenApiEndpoint,
} from "./connections/catalog.js";

export { WriteFileExistsError } from "./files.js";

export { HumanActionRequiredError, type HumanAction } from "../human-action.js";
