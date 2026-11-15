import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freePort,
  prepareApp,
  runNode,
  startEve,
  stopEve,
  waitForHealth,
  type EveProcess,
} from "./lib/eve-app.ts";
import { envFor, killEve, post, startProvider } from "./fixtures/restart-app.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function waitFor(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// Регрессии жизненного цикла каталога just-bash-сессии на реальном пути:
// каталог уходит только когда run-владелец (сессия workflowEntry) в конечном
// состоянии по хранилищу workflow. (1) каталог открытой сессии переживает
// уборку; (2) рестарт, create чужой сессии и репривязка незавершённого run
// сохраняют файлы; (3) каталог завершённого run освобождается без
// перезапуска сервера.
void test(
  "just-bash session dirs follow their owner run lifecycle",
  { timeout: 600_000 },
  async (t) => {
    const sandbox = await mkdtemp(join(tmpdir(), "iva-sbx-lifecycle-"));
    const provider = await startProvider();
    let eve: EveProcess | null = null;
    t.after(async () => {
      await stopEve(eve);
      await provider.close();
      await rm(sandbox, { recursive: true, force: true });
    });

    const app = await prepareApp(sandbox);
    await cp(
      join(ROOT, "scripts/fixtures/sandbox-probe-channel.ts"),
      join(app, "agent/channels/sandbox-probe.ts"),
    );
    const port = await freePort();
    const bearer = randomBytes(24).toString("hex");
    const env = envFor(sandbox, app, port, provider.baseUrl, bearer);
    await writeFile(join(app, ".env"), `ASSISTANT_BEARER=${bearer}\n`, {
      mode: 0o600,
    });

    const sessionsDir = join(app, ".eve/sandbox-cache/just-bash/sessions");
    const probeFile = join(app, "data/sandbox-probe.jsonl");
    const probeEntries = async () =>
      (await readFile(probeFile, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const dirFor = async (sessionId: string) =>
      (await readdir(sessionsDir).catch(() => [] as string[])).find((name) =>
        name.includes(sessionId),
      );
    const send = async (address: string, message: string) => {
      const response = await post(port, bearer, "/sandbox-probe/send", {
        address,
        message,
      });
      assert.equal(response.status, 200);
      return ((await response.json()) as { sessionId: string }).sessionId;
    };
    const completedFor = async (sessionId: string) =>
      (await probeEntries()).find(
        (entry) => entry.event === "completed" && entry.sessionId === sessionId,
      );
    const waitCompleted = async (sessionId: string, label: string) =>
      waitFor(async () => (await completedFor(sessionId)) !== undefined, label);

    await runNode([join(app, "scripts/init-vault.mjs")], app, env, () => {});
    await runNode(
      [join(app, "node_modules/eve/bin/eve.js"), "build"],
      app,
      env,
      () => {},
    );

    eve = startEve(app, env, port, () => {});
    await waitForHealth(port, eve);

    // Ход X открывает sandbox и пишет маркер; сессия остаётся открытой
    // (её run-владелец — running), каталог на диске.
    const runX = await send("1::", "first message on session x");
    await waitCompleted(runX, "session X first turn");
    assert.ok((await dirFor(runX)) !== undefined, "session X dir missing");

    // Рестарт сервера. Сессия X не завершена — её каталог должен пережить
    // и рестарт, и уборку при create следующей чужой сессии.
    await killEve(eve);
    eve = startEve(app, env, port, () => {});
    await waitForHealth(port, eve);

    const runY = await send("2::", "message on session y");
    await waitCompleted(runY, "session Y turn");
    // Уборка идёт фоном после create — короткое окно, затем проверка.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.ok(
      (await dirFor(runX)) !== undefined,
      "session dir of an unfinished run was removed by another session's create",
    );
    assert.ok((await dirFor(runY)) !== undefined, "session Y dir missing");

    // Репривязка: второе сообщение в ту же сессию открывает тот же
    // каталог через persisted состояние — маркер, записанный до рестарта,
    // читается, а не перезаписывается.
    const runX2 = await send("1::", "second message on session x");
    assert.equal(runX2, runX, "the resumed session got a different run id");
    await waitFor(
      async () =>
        (await probeEntries()).some(
          (entry) =>
            entry.event === "opened" &&
            entry.sessionId === runX &&
            entry.reattached === true,
        ),
      "session X reattach with the pre-restart marker",
    );
    const openedX = (await probeEntries()).find(
      (entry) => entry.event === "opened" && entry.sessionId === runX && entry.reattached,
    );
    assert.equal(
      openedX?.marker,
      runX,
      "reattached session lost the files written before the restart",
    );

    // Reset завершает сессию X: её run уходит в конечное состояние.
    const reset = await post(port, bearer, "/eve/v1/telegram/reset", {
      address: { chatId: "1" },
    });
    assert.equal(reset.status, 200);

    // Следующая чужая сессия гонит уборку: каталог завершённого X уходит
    // без перезапуска сервера, открытые каталоги Y и Z остаются.
    const runZ = await send("3::", "message on session z");
    await waitCompleted(runZ, "session Z turn");
    await waitFor(
      async () => (await dirFor(runX)) === undefined,
      "finished session dir to be freed",
      30_000,
    );
    assert.ok(
      (await dirFor(runY)) !== undefined,
      "still-open session Y dir was collected",
    );
    assert.ok(
      (await dirFor(runZ)) !== undefined,
      "the session opened by run Z was collected",
    );
  },
);
