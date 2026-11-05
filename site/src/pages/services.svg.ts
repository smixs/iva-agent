import { sprite } from "../lib/services";

// The hero's flying service marks, one symbol per service (lib/services.ts).
export const GET = () => new Response(sprite, { headers: { "Content-Type": "image/svg+xml" } });
