import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  installation,
  service,
  finish,
  BEFORE,
  NEW,
} from "./fixtures/update-run-installation.ts";
const PORT_BASE = 18_700 + (process.pid % 200);
type Units = Record<string, { active: boolean; enabled: boolean }>;
const KILLS = [
  // After the last old writer stopped: quiesce returned, nothing else ran.
  "stop:iva-telegram-poll.service",
  "migrate",
  "vault",
  // After the flip, before the candidate's services start.
  "restart:iva.service",
];

for (const [index, killAt] of KILLS.entries()) {
  void test(`UpdateRun UnitsReturn, SessionsAccounted: update-finish killed at ${killAt} and run again brings back every unit that ran before`, async (t) => {
    const port = PORT_BASE + index;
    const at = installation(port);
    const server = await service(at.state, port);
    t.after(() => server.close());

    const killed = await finish(at, killAt);
    assert.equal(killed.signal, "SIGKILL", killed.out);
    const stopped = JSON.parse(readFileSync(at.state, "utf8")) as Units;
    assert.equal(
      stopped["iva.service"].active,
      false,
      `the kill left Iva down\n${killed.out}\n${readFileSync(join(at.root, "trace.log"), "utf8")}`,
    );

    const again = await finish(at, "");
    assert.equal(
      again.code,
      0,
      `${again.out}\n${readFileSync(join(at.root, "outcome-retry.json"), "utf8")}`,
    );
    assert.equal(at.store.currentName(), NEW);
    const after = JSON.parse(readFileSync(at.state, "utf8")) as Units;
    for (const unit of ["iva.service", "iva-telegram-poll.service"])
      assert.equal(after[unit].active, true, `${unit} after the retry`);
    assert.deepEqual(
      after["iva-brain.timer"],
      BEFORE["iva-brain.timer"],
      `the brain timer ran before the update and must run after it\n${again.out}`,
    );
    // The userbot ran before: the retry must try to bring it back (its venv cannot be
    // built here, so the recovery fails and says so) rather than keep it off in silence.
    assert.match(
      again.out,
      /userbot proxy did not come up/u,
      "the retry did not try to bring back the userbot that ran before",
    );
    // The session state the dead run took away is accounted for: retired, on a path that
    // is written down, and never lost without a name.
    const trash = readdirSync(join(at.home, ".eve")).filter((name) =>
      name.startsWith(".workflow-data.trash-"),
    );
    assert.ok(trash.length >= 1, "the quarantined sessions are gone");
    assert.ok(
      trash.some((name) =>
        existsSync(join(at.home, ".eve", name, "session-1.json")),
      ),
      "the sessions of the old version are on no path",
    );
  });
}
