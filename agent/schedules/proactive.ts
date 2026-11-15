// Тик Watch, Brief и Insight (ADR-0020, ADR-0022) — тонкий спавнер: каждые полчаса запускает
// scripts/proactive/tick.ts, который сам берёт свой замок, проверяет источники без модели и
// будит её только при новом. Тумблер «Сама пишет» читает сам тик: сбои идут и при выключенном.
// Срок 30 минут; killGraceMs 90 с, как у ночи: в IVA_JOB_STOP_AT (за 90 с до SIGTERM) тик сам
// отменяет свой ход на сервере и снимает замок. Агента о себе не будит (провал виден в
// открытых провалах), успех пишет фактом только после провала — иначе 48 строк в сутки
// вытеснили бы остальные факты.
import { defineSchedule } from "eve/schedules";
import { resolvePaths } from "../lib/schedule-paths.js";
import { JOB_STOP_GRACE_MS, runScheduledJob } from "../lib/schedule-runner.js";
import {
  PROACTIVE_SCHEDULE,
  PROACTIVE_TIMEOUT_MS,
  PROACTIVE_TICK_CRON,
} from "../lib/schedule-table.js";

export default defineSchedule({
  cron: PROACTIVE_TICK_CRON,
  run({ waitUntil }) {
    const { root, statusPath, factsPath } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: PROACTIVE_SCHEDULE,
        argv: ["scripts/proactive/tick.ts"],
        root,
        nodeBin: process.execPath,
        statusPath,
        factsPath,
        guardMs: 0,
        timeoutMs: PROACTIVE_TIMEOUT_MS,
        killGraceMs: JOB_STOP_GRACE_MS,
        wake: false,
        factOnSuccess: "after-failure",
      }),
    );
  },
});
