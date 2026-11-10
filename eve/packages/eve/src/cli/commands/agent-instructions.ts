
/**
 * Pre-scaffold guide for a coding agent that ran `eve extension init` with no
 * target. Mirrors agent bare-init: collect a package name, then re-run with it.
 */
export function initExtensionInstructions(): string {
  return [
    "You are scaffolding an eve extension package (a reusable package of tools,",
    "connections, skills, and hooks that a consuming agent mounts under",
    "agent/extensions/).",
    "",
    "Ask the user for a package directory name, then run:",
    "",
    "    npx eve@latest extension init <name>",
    "",
    "That creates the package, installs dependencies, and initializes Git. It",
    "prints what was set up and how to author, build, and mount the extension —",
    "it does not start eve dev (extensions are not standalone agents).",
    "",
    "Build with `eve extension build` (or the package `build` script).",
  ].join("\n");
}

/**
 * Post-scaffold handoff after `eve extension init`. Same text for human and
 * coding-agent launches: what was written and what to do next. Never assumes
 * `eve dev`.
 */
export function initExtensionHandoff(options: {
  packageManager: string;
  packageName: string;
  projectPath: string;
}): string {
  const buildCommand = `${options.packageManager} run build`;
  return [
    "",
    "What we set up:",
    "  - package.json with eve.extension source/dist roots, peer+dev eve, and zod",
    "  - extension/extension.ts (config schema via defineExtension)",
    "  - build/prepare scripts → eve extension build",
    "",
    "Next:",
    "  - Add tools, skills, hooks, or connections under extension/",
    "    (see AGENTS.md and node_modules/eve/docs/extensions.md)",
    `  - ${buildCommand}   # builds dist/extension and package exports`,
    "  - Mount from a consumer agent:",
    `      // agent/extensions/${options.packageName}.ts`,
    `      import ext from "${options.packageName}";`,
    "      export default ext({ apiKey: process.env.API_KEY });",
    "",
    `Working directory: ${options.projectPath}`,
  ].join("\n");
}
