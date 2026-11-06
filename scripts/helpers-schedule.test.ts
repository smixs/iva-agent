/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns registration. */
import "./lib/ts-esm-hooks.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
test("one minute Schedule keeps helpers runnable during a pending reminder turn", async () => {
  const run = promisify(execFile);
  const script = `
    import './scripts/lib/ts-esm-hooks.ts';
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, ctx, next) {
      if (url.endsWith('/agent/lib/reminder-tick.ts')) return { format:'module', source:'export const runReminderTick = (o) => o.dispatchOnly ? Promise.resolve() : new Promise(() => {});', shortCircuit:true };
      if (url.endsWith('/agent/lib/helper-tick.ts')) return { format:'module', source:'export const runHelperTick = () => { globalThis.helperTicks = (globalThis.helperTicks ?? 0) + 1; return Promise.resolve(); };', shortCircuit:true };
      return next(url, ctx);
    }});
    const schedule = (await import('./agent/schedules/reminders.ts')).default;
    for (let n=0;n<2;n++) {
      let work; schedule.run({waitUntil:p=>work=p}); await work; await new Promise(setImmediate);
    }
    if (schedule.cron !== '* * * * *' || globalThis.helperTicks !== 2) throw Error('minute stalled');
    console.log('helpers completed two ticks');
  `;
  const result = await run(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 10000 },
  );
  assert.match(result.stdout, /helpers completed two ticks/);
});
test("v7 owner epoch is process-wide across duplicate module loads", async (t) => {
  const { OWNER_STARTED_AT: a } =
    await import("../agent/lib/schedule-runner.ts");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 1000 });
  const path = new URL(
    "../agent/lib/schedule-runner.ts?independent",
    import.meta.url,
  ).href;
  const b = (await import(path)) as { OWNER_STARTED_AT: number };
  assert.equal(a, b.OWNER_STARTED_AT);
});
test("v7 helper header uses the common reminder client and preserves R1 failure", async () => {
  const { runReminderTurn } = await import("./lib/reminder-turn.ts");
  const options = {
    host: "http://fixture.invalid",
    auth: { bearer: () => Promise.resolve("fixture") },
    headers: { "x-iva-turn": "helper" },
  };
  const resets: string[] = [];
  const response = Object.assign(
    (async function* () {
      await Promise.resolve();
      yield { type: "message.completed", data: { message: "intermediate" } };
      yield { type: "turn.failed" };
      yield { type: "session.waiting" };
    })(),
    {
      sessionId: "fixture-session",
      cancel: () => Promise.reject(new Error("unexpected stream cancellation")),
    },
  );
  const turn = await runReminderTurn("fixture", options, {
    createClient: (received) => {
      assert.equal(received, options);
      return Promise.resolve({
        sessions: {
          create: ({ message }) => {
            assert.equal(message, "fixture");
            return Promise.resolve({
              response,
              session: {
                send: () => Promise.resolve(),
                cancel: () =>
                  Promise.reject(new Error("unexpected session cancellation")),
                reset: ({ reason }) => {
                  resets.push(reason);
                  return Promise.resolve();
                },
              },
            });
          },
        },
      });
    },
  });
  assert.equal(turn.status, "failed");
  assert.equal(turn.message, "ход упал");
  assert.equal(turn.cancelled, false);
  assert.deepEqual(resets, ["Reminder finished"]);
});
test("R4 a pending helper step cannot hold later reminder/command minutes", async () => {
  const script = `
 import './scripts/lib/ts-esm-hooks.ts';import {registerHooks} from 'node:module';
 registerHooks({load(url,ctx,next){
 if(url.endsWith('/agent/lib/reminder-tick.ts'))return{format:'module',shortCircuit:true,source:'export const runReminderTick = o => {globalThis.ticks=(globalThis.ticks??0)+1;return Promise.resolve();}'};
 if(url.endsWith('/agent/lib/helper-tick.ts'))return{format:'module',shortCircuit:true,source:'export const runHelperTick = () => new Promise(()=>{});'};
 return next(url,ctx);}});
 const schedule=(await import('./agent/schedules/reminders.ts')).default;
 for(let n=0;n<2;n++){let work;schedule.run({waitUntil:p=>work=p});
 const result=await Promise.race([work,new Promise(r=>setTimeout(()=>r('held'),150))]);
 if(result==='held')throw Error('helper held the minute');}
 if(globalThis.ticks!==4)throw Error('reminder/command minute lost');`;
  await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 2000 },
  );
});
