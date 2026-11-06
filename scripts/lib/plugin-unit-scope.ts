import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export type PluginUnitScope = {
  readonly dataRoot: string;
  readonly id: string;
};
export type PluginUnitIdentity = {
  readonly scope: PluginUnitScope;
  readonly kind: "mcp" | "service";
  readonly plugin: string;
  readonly part: string;
  readonly layout: "legacy" | "scoped";
};
export const UNIT_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const HASH = /^[0-9a-f]{64}$/u;
const MARKER = "IvaPluginUnitOwner=v1:";
const LINE =
  /^(?:# IvaPluginUnitOwner=v1:([0-9a-f]+)|<!-- IvaPluginUnitOwner=v1:([0-9a-f]+) -->)\n/mu;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** The caller canonicalizes the data path; this module has no filesystem effects. */
export function pluginUnitScope(dataRoot: string): PluginUnitScope {
  if (!isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot)
    throw new Error("plugin unit data root must be canonical and absolute");
  return {
    dataRoot,
    id: sha(JSON.stringify(["iva-plugin-data", 1, dataRoot])),
  };
}

export function scopedPluginUnitName(identity: PluginUnitIdentity): string {
  const { scope, kind, plugin, part, layout } = identity;
  if (!UNIT_PART.test(plugin) || !UNIT_PART.test(part))
    throw new Error("invalid plugin unit name part");
  const prefix = kind === "mcp" ? "iva-mcp-" : "iva-plugin-";
  const name = `${prefix}${layout === "scoped" ? `${scope.id}-` : ""}${plugin}-${part}.service`;
  if (Buffer.byteLength(name) > 255)
    throw new Error("plugin unit filename exceeds 255 bytes");
  return name;
}

export function pluginUnitPayload(body: string): string {
  return body.replace(LINE, "");
}

export function markPluginUnit(
  body: string,
  identity: PluginUnitIdentity,
): string {
  const payload = pluginUnitPayload(body);
  const { scope, kind, plugin, part, layout } = identity;
  const tuple = [
    1,
    scope.id,
    scope.dataRoot,
    kind,
    plugin,
    part,
    layout,
    sha(payload),
  ];
  const encoded = Buffer.from(JSON.stringify(tuple), "utf8").toString("hex");
  if (!payload.startsWith("<?xml")) return `# ${MARKER}${encoded}\n${payload}`;
  const newline = payload.indexOf("\n") + 1;
  return `${payload.slice(0, newline)}<!-- ${MARKER}${encoded} -->\n${payload.slice(newline)}`;
}

function decodedTuple(encoded: string): unknown[] | null {
  if (!/^(?:[0-9a-f]{2})+$/u.test(encoded)) return null;
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(encoded, "hex"),
    ),
  );
  if (!Array.isArray(parsed) || parsed.length !== 8 || parsed[0] !== 1)
    return null;
  if (!parsed.slice(1).every((value) => typeof value === "string")) return null;
  return parsed as unknown[];
}

function tupleIdentity(tuple: unknown[]): PluginUnitIdentity | null {
  const [, id, dataRoot, kind, plugin, part, layout] = tuple as string[];
  if (!HASH.test(id)) return null;
  if (kind !== "mcp" && kind !== "service") return null;
  if (layout !== "legacy" && layout !== "scoped") return null;
  const scope = pluginUnitScope(dataRoot);
  if (scope.id !== id) return null;
  return { scope, kind, plugin, part, layout };
}
/** Decode the reversible tuple, including stale keys absent from plugins.json. */
export function readPluginUnitMarker(
  body: string,
  unit: string,
): PluginUnitIdentity | null {
  try {
    if ((body.match(/IvaPluginUnitOwner=/gu) ?? []).length !== 1) return null;
    const line = LINE.exec(body);
    if (!line) return null;
    const tuple = decodedTuple(line[1] ?? line[2]);
    if (!tuple) return null;
    const identity = tupleIdentity(tuple);
    if (!identity || tuple[7] !== sha(pluginUnitPayload(body))) return null;
    return scopedPluginUnitName(identity) === unit ? identity : null;
  } catch {
    return null;
  }
}
