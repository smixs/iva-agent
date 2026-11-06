/**
 * The one place the CLI reaches the plugin code that lives in the authored tree.
 *
 * `iva` has to start on an installation whose `agent/` is missing or half-written,
 * because that is exactly when `iva doctor` and `iva update` are run (ADR-0003,
 * scripts/authored-tree-guard.test.ts). A static import of `#lib/…` from a CLI
 * module breaks that; a lazy import inside the command does not. Keeping the lazy
 * import here means there is one such import in the tree instead of one per command.
 */
export type PluginCore = {
  readonly skills: typeof import("#lib/custom-skills.ts");
  readonly reader: typeof import("#lib/plugin-reader.ts");
  readonly store: typeof import("#lib/plugin-store.ts");
  readonly config: typeof import("#lib/plugin-config.ts");
  readonly install: typeof import("./plugin-install.ts");
};

export async function loadPluginCore(): Promise<PluginCore> {
  return {
    skills: await import("#lib/custom-skills.ts"),
    reader: await import("#lib/plugin-reader.ts"),
    store: await import("#lib/plugin-store.ts"),
    config: await import("#lib/plugin-config.ts"),
    install: await import("./plugin-install.ts"),
  };
}

/** The same, for callers that must keep working when the tree is not there. */
export async function tryLoadPluginCore(): Promise<PluginCore | null> {
  try {
    return await loadPluginCore();
  } catch {
    return null;
  }
}
