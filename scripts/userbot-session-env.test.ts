import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import fc from "fast-check";

void test("userbot session labels preserve names and reject invalid labels (seed 20261020)", () => {
  const python = process.env.IVA_USERBOT_TEST_PYTHON ?? "python3";
  const valid = fc.stringMatching(/^[a-z0-9_]{1,16}$/);
  fc.assert(
    fc.property(
      fc.array(fc.oneof(valid, fc.string({ maxLength: 16 })), {
        maxLength: 12,
      }),
      (labels) => {
        const directory = mkdtempSync(join(tmpdir(), "iva-userbot-labels-"));
        try {
          const safeLabels = labels.filter(
            (label) => !label.includes("/") && !label.includes("\0"),
          );
          writeFileSync(join(directory, "telegram-userbot.session"), "");
          for (const label of safeLabels)
            writeFileSync(
              join(directory, `telegram-userbot-${label}.session`),
              "",
            );
          const result = spawnSync(
            python,
            [
              "-c",
              [
                "import json, os, serve",
                "serve._seed_session_env()",
                "print(json.dumps({k: v for k, v in os.environ.items() if k.startswith('TELEGRAM_SESSION_')}))",
              ].join("\n"),
            ],
            {
              encoding: "utf8",
              env: {
                PATH: process.env.PATH,
                PYTHONPATH: resolve("services/telegram-userbot"),
                ASSISTANT_DATA_DIR: directory,
                ...Object.fromEntries(
                  [...new Set(["default", ...safeLabels])]
                    .filter((label) => /^[a-z0-9_]+$/.test(label))
                    .flatMap((label) => [
                      [`TELEGRAM_SESSION_NAME_${label.toUpperCase()}`, "stale"],
                      [
                        `TELEGRAM_SESSION_STRING_${label}`,
                        "invalid-stale-string",
                      ],
                    ]),
                ),
              },
            },
          );
          assert.equal(result.status, 0, result.stderr);
          const environment = JSON.parse(result.stdout) as Record<
            string,
            string
          >;
          assert.equal(environment.TELEGRAM_SESSION_STRING, "");
          const sessions = Object.fromEntries(
            Object.entries(environment).filter(([, value]) => value !== ""),
          );
          const expected = new Set([
            "default",
            ...safeLabels.filter(
              (label) => /^[a-z0-9_]+$/.test(label) && label !== "default",
            ),
          ]);
          if (expected.size === 1) {
            assert.deepEqual(sessions, {
              TELEGRAM_SESSION_NAME: join(directory, "telegram-userbot"),
            });
          } else {
            assert.equal(sessions.TELEGRAM_SESSION_NAME, undefined);
            assert.deepEqual(
              new Set(Object.keys(sessions)),
              new Set(
                [...expected].map(
                  (label) => `TELEGRAM_SESSION_NAME_${label.toUpperCase()}`,
                ),
              ),
            );
            for (const label of expected)
              assert.equal(
                sessions[`TELEGRAM_SESSION_NAME_${label.toUpperCase()}`],
                join(
                  directory,
                  `telegram-userbot${label === "default" ? "" : `-${label}`}`,
                ),
              );
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    ),
    { seed: 20261020, numRuns: 60 },
  );
});

void test("userbot file boundary requires private permissions (seed 332)", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 0o77 }), (permissions) => {
      const directory = mkdtempSync(join(tmpdir(), "iva-userbot-roots-"));
      try {
        const result = spawnSync(
          process.env.IVA_USERBOT_TEST_PYTHON ?? "python3",
          [
            "-c",
            [
              "import json, os, pathlib, serve, types",
              "root = pathlib.Path(os.environ['ASSISTANT_DATA_DIR']) / 'userbot-files'",
              `root.mkdir(); root.chmod(0o700 | ${permissions})`,
              "runtime = types.SimpleNamespace(SERVER_ALLOWED_ROOTS=[], clients={}, _path_is_within_root=lambda p, r: p.resolve().is_relative_to(r.resolve()))",
              "serve._configure_media_roots(runtime)",
              "print(json.dumps([bool(runtime.SERVER_ALLOWED_ROOTS), runtime._path_is_within_root(root / 'audio.oga', root), runtime._path_is_within_root(root.parent / 'secret', root.parent)]))",
            ].join("\n"),
          ],
          {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              PYTHONPATH: resolve("services/telegram-userbot"),
              ASSISTANT_DATA_DIR: directory,
            },
          },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), [
          permissions === 0,
          permissions === 0,
          false,
        ]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }),
    { seed: 332, numRuns: 64, examples: [[0], [0o77]] },
  );
});
