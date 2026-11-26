// POST /api/plugins/installs - an installed Iva says which plugin of the default Marketplace
// it has just installed. GET - the numbers the Plugins page shows. The rules are in
// src/lib/installs.ts; this file only reads the request and writes the answer.
import catalog from "../../../src/data/plugins.json";
import {
  installCounts,
  MAX_BODY,
  nameIn,
  recordInstall,
  type Database,
} from "../../../src/lib/installs.ts";

type Env = { INSTALLS: Database };
type Context = { request: Request; env: Env };

const LISTED: ReadonlySet<string> = new Set(
  catalog.plugins.map((plugin) => plugin.name),
);
const quiet = { "cache-control": "no-store" };

export async function onRequestPost({
  request,
  env,
}: Context): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY)
    return new Response(null, { status: 413, headers: quiet });
  const name = nameIn((await request.text()).slice(0, MAX_BODY + 1));
  if (name === null) return new Response(null, { status: 400, headers: quiet });
  const outcome = await recordInstall(env.INSTALLS, name, LISTED);
  return new Response(null, {
    status: outcome === "unlisted" ? 404 : 204,
    headers: quiet,
  });
}

export async function onRequestGet({ env }: Context): Promise<Response> {
  return Response.json(await installCounts(env.INSTALLS, LISTED), {
    headers: { "cache-control": "public, max-age=300" },
  });
}
