// Imported in every child before application code. Only this scenario's HTTP peers exist.
import { appendFileSync } from "node:fs";

const telegram = new URL(process.env.SMOKE_TELEGRAM_URL!);
const allowed = new Set(
  JSON.parse(process.env.SMOKE_ALLOWED_ORIGINS!) as string[],
);
const realFetch = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const source = new URL(input instanceof Request ? input.url : String(input));
  let target = source;
  if (source.origin === "https://api.telegram.org") {
    target = new URL(source.pathname + source.search, telegram);
  } else if (!allowed.has(source.origin)) {
    const message = `Forbidden smoke network address: ${source.origin}`;
    appendFileSync(process.env.SMOKE_NETWORK_LOG!, message + "\n");
    return Promise.reject(new Error(message));
  }
  if (target.hostname === "localhost") target.hostname = "127.0.0.1";
  return realFetch(
    input instanceof Request ? new Request(target, input) : target,
    { ...init, redirect: "error" },
  );
};
