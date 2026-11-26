// POST /api/roll-call - once a day an installed Iva says it is alive (ADR-0031 in docs/adr of
// Iva). The rules are in src/lib/roll-call.ts; this file only reads the request and writes the
// answer. There is no GET: the numbers are read by the project's owner from the database.
import type { Database } from "../../src/lib/installs.ts";
import { textUpTo } from "../../src/lib/request-body.ts";
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
  const body = await textUpTo(request, MAX_ROLL_CALL_BODY);
  if (body === null) return new Response(null, { status: 413, headers: quiet });
  const call = rollCallIn(body);
  if (call === null) return new Response(null, { status: 400, headers: quiet });
  await recordRollCall(env.INSTALLS, call, new Date());
  return new Response(null, { status: 204, headers: quiet });
}
