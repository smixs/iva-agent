// POST /api/roll-call - once a day an installed Iva says it is alive (ADR-0031 in docs/adr of
// Iva). The rules are in src/lib/roll-call.ts; this file only reads the request and writes the
// answer. There is no GET: the numbers are read by the project's owner from the database.
import type { Database } from "../../src/lib/installs.ts";
import {
  MAX_ROLL_CALL_BODY,
  recordRollCall,
  rollCallIn,
} from "../../src/lib/roll-call.ts";

type Env = { INSTALLS: Database };
type Context = { request: Request; env: Env };

const quiet = { "cache-control": "no-store" };

export async function onRequestPost({
  request,
  env,
}: Context): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_ROLL_CALL_BODY)
    return new Response(null, { status: 413, headers: quiet });
  const call = rollCallIn(
    (await request.text()).slice(0, MAX_ROLL_CALL_BODY + 1),
  );
  if (call === null) return new Response(null, { status: 400, headers: quiet });
  await recordRollCall(env.INSTALLS, call, new Date());
  return new Response(null, { status: 204, headers: quiet });
}
