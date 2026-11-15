/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Якоря состояния плагинов: что попадает в plugins.json, что из него выпадает и что
// делает битый файл. Свойства на случайном JSON — ниже, в том же файле: генератор
// здесь нужен ровно один и держит инвариант «любой вход → состояние, не исключение».
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { pluginNameProblem } from "./plugin-reader.ts";
import {
  assignPluginPorts,
  EMPTY_PLUGINS_STATE,
  enabledPlugins,
  FIRST_PLUGIN_PORT,
  findPlugin,
  normalizePluginsState,
  pluginDataDir,
  pluginMode,
  pluginRoot,
  pluginsDir,
  pluginsStateFile,
  readPluginsState,
  readPluginsStateSafe,
  removePlugin,
  RESERVED_PLUGIN_PORTS,
  takenPluginPorts,
  upsertPlugin,
  writePluginsState,
  type PluginEntry,
  type PluginMode,
  type PluginsState,
} from "./plugin-store.ts";

const worlds: string[] = [];

after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-plugin-store-"));
  worlds.push(dir);
  return dir;
}

function entry(overrides: Partial<PluginEntry> = {}): PluginEntry {
  return {
    name: "demo",
    source: "smixs/iva-plugins/trace",
    ref: "main",
    sha: "a".repeat(40),
    digest: "d".repeat(64),
    enabled: true,
    trusted: false,
    installedAt: "2026-08-17T10:00:00.000Z",
    ...overrides,
  };
}

test("the layout keeps plugin data outside the plugins folder", () => {
  const data = "/srv/iva/data";
  assert.equal(pluginsDir(data), "/srv/iva/data/custom/plugins");
  assert.equal(pluginRoot(data, "trace"), "/srv/iva/data/custom/plugins/trace");
  assert.equal(pluginsStateFile(data), "/srv/iva/data/custom/plugins.json");
  assert.equal(pluginDataDir(data, "trace"), "/srv/iva/data/plugin-data/trace");
});

test("a missing state file reads as empty state, not as an error", async () => {
  assert.deepEqual(await readPluginsState(world()), EMPTY_PLUGINS_STATE);
});

test("state survives a write and a read byte for byte", async () => {
  const data = world();
  const state = {
    marketplaces: ["smixs/iva-plugins"],
    plugins: [entry(), entry({ name: "alpha", enabled: false, trusted: true })],
    riskNoticeShownAt: "2026-08-17T09:00:00.000Z",
  };

  await writePluginsState(data, state);
  const read = await readPluginsState(data);

  assert.deepEqual(read.marketplaces, ["smixs/iva-plugins"]);
  assert.deepEqual(
    read.plugins.map((item) => item.name),
    ["alpha", "demo"],
  );
  assert.equal(read.riskNoticeShownAt, "2026-08-17T09:00:00.000Z");
  assert.equal(findPlugin(read, "alpha")?.trusted, true);
  assert.deepEqual(
    enabledPlugins(read).map((item) => item.name),
    ["demo"],
  );
  // Пишем в data/custom/, каталог создаём сами: свежая инсталляция его не имеет.
  assert.ok(existsSync(pluginsStateFile(data)));
});

test("PluginMode: the four modes are the four pairs of toggles, and the file still holds two booleans", async () => {
  const pairs: Record<PluginMode, readonly [boolean, boolean]> = {
    full: [true, true],
    "no-processes": [true, false],
    paused: [false, true],
    off: [false, false],
  };
  const data = world();
  await writePluginsState(data, {
    marketplaces: [],
    plugins: Object.entries(pairs).map(([name, [enabled, trusted]]) =>
      entry({ name, enabled, trusted }),
    ),
  });

  // Формат на диске прежний: слово режима живёт в коде, в файл не попадает, и
  // версия до режимов читает запись как раньше.
  const onDisk = JSON.parse(readFileSync(pluginsStateFile(data), "utf8")) as {
    plugins: Record<string, unknown>[];
  };
  for (const item of onDisk.plugins) {
    const [enabled, trusted] = pairs[item.name as PluginMode];
    assert.equal(item.enabled, enabled);
    assert.equal(item.trusted, trusted);
    assert.equal("mode" in item, false);
  }
  for (const item of (await readPluginsState(data)).plugins)
    assert.equal(pluginMode(item), item.name);

  // Запись без тумблеров (файл старше их появления): поставлен — значит включён, а
  // доверия, которого никто не давал, нет.
  const [old] = normalizePluginsState({ plugins: [{ name: "old" }] }).plugins;
  assert.equal(pluginMode(old), "no-processes");
});

test("junk entries fall out and the survivors keep their order", () => {
  const state = normalizePluginsState({
    marketplaces: ["ok", 7, { name: "x" }],
    plugins: [
      { name: "zeta", source: "./z" },
      "not an entry",
      { name: "Bad Name" },
      { name: "alpha", enabled: false, trusted: "yes" },
      { name: "alpha", source: "duplicate" },
      null,
    ],
    unknownField: true,
  });

  assert.deepEqual(state.marketplaces, ["ok"]);
  assert.deepEqual(
    state.plugins.map((item) => item.name),
    ["alpha", "zeta"],
  );
  // Отсутствующий тумблер = включён; trusted включается только явным true.
  assert.equal(findPlugin(state, "zeta")?.enabled, true);
  assert.equal(findPlugin(state, "alpha")?.enabled, false);
  assert.equal(findPlugin(state, "alpha")?.trusted, false);
  assert.equal(findPlugin(state, "alpha")?.source, "");
});

test("provenance is kept when it is a name, and dropped when it is anything else", async () => {
  const data = world();
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [entry({ marketplace: "iva-plugins" })],
  });
  assert.equal(
    (await readPluginsState(data)).plugins[0].marketplace,
    "iva-plugins",
  );

  // Прямая установка провенанса не имеет, и пустого поля тоже: его отсутствие —
  // это ответ «не через Marketplace», а не «неизвестно».
  const direct = normalizePluginsState({ plugins: [{ name: "demo" }] });
  assert.equal("marketplace" in direct.plugins[0], false);
  const junk = normalizePluginsState({
    plugins: [
      { name: "demo", marketplace: 7 },
      { name: "alpha", marketplace: "" },
    ],
  });
  assert.equal("marketplace" in junk.plugins[0], false);
  assert.equal("marketplace" in junk.plugins[1], false);
});

test("upsert replaces one plugin and remove takes only its entry", () => {
  const first = upsertPlugin(EMPTY_PLUGINS_STATE, entry());
  const replaced = upsertPlugin(first, entry({ sha: "b".repeat(40) }));
  assert.equal(replaced.plugins.length, 1);
  assert.equal(replaced.plugins[0].sha, "b".repeat(40));
  // Чистая функция: исходное состояние не тронуто.
  assert.equal(first.plugins[0].sha, "a".repeat(40));

  const both = upsertPlugin(replaced, entry({ name: "alpha" }));
  assert.deepEqual(
    removePlugin(both, "demo").plugins.map((item) => item.name),
    ["alpha"],
  );
});

test("a damaged plugins.json is reported and left exactly where it is", async () => {
  const data = world();
  mkdirSync(join(data, "custom"), { recursive: true });
  const file = pluginsStateFile(data);
  writeFileSync(file, "{ not json");

  // Читает КАЖДЫЙ ход агента: чтение, которое чинит файл, однажды унесло бы список
  // плагинов молча, посреди разговора.
  const first = await readPluginsStateSafe(data);
  assert.deepEqual(first.state, EMPTY_PLUGINS_STATE);
  assert.match(first.damaged?.message ?? "", /not valid JSON/u);
  assert.match(first.damaged?.message ?? "", /iva plugin sync/u);
  const second = await readPluginsStateSafe(data);
  assert.equal(second.damaged !== null, true);

  assert.deepEqual(readdirSync(join(data, "custom")), ["plugins.json"]);
  assert.equal(readFileSync(file, "utf8"), "{ not json");

  // Команда владельца обязана упереться, а не работать на пустом состоянии.
  await assert.rejects(readPluginsState(data), /not valid JSON/u);
});

test("an unreadable state file is damaged, not empty", async () => {
  const data = world();
  mkdirSync(join(data, "custom"), { recursive: true });
  mkdirSync(pluginsStateFile(data)); // каталог вместо файла — читается с EISDIR

  const { state, damaged } = await readPluginsStateSafe(data);
  assert.deepEqual(state, EMPTY_PLUGINS_STATE);
  assert.match(damaged?.message ?? "", /unreadable/u);
});

const RUNS = { numRuns: 100 };

// Половина входа — чистый мусор, половина — правдоподобное состояние: иначе ветка
// разбора записи почти никогда бы не выполнилась.
const rawState = fc.oneof(
  fc.json().map((raw) => JSON.parse(raw) as unknown),
  fc.record(
    {
      marketplaces: fc.oneof(fc.array(fc.string()), fc.string()),
      riskNoticeShownAt: fc.oneof(fc.string(), fc.integer()),
      plugins: fc.array(
        fc.oneof(
          fc.record(
            {
              // Алфавит имён нарочно крошечный: повторы должны выпадать часто,
              // иначе дедупликация никогда бы не проверялась.
              name: fc.oneof(
                fc.constantFrom("demo", "alpha", "demo", "a.b", "Bad Name", ""),
                fc.string({ maxLength: 4 }),
              ),
              source: fc.oneof(fc.string(), fc.integer()),
              ref: fc.string(),
              sha: fc.string(),
              digest: fc.oneof(fc.string(), fc.integer()),
              enabled: fc.oneof(fc.boolean(), fc.string()),
              trusted: fc.oneof(fc.boolean(), fc.string()),
              installedAt: fc.string(),
            },
            // Имя есть всегда: запись без имени выпадает раньше всех прочих
            // проверок, и генератор без имён проверял бы одну ветку из пяти.
            { requiredKeys: ["name"] },
          ),
          fc.string(),
          fc.constant(null),
        ),
        { maxLength: 5 },
      ),
    },
    { requiredKeys: [] },
  ),
);

test("property: any JSON becomes a state, and normalizing twice changes nothing", () => {
  fc.assert(
    fc.property(rawState, (raw) => {
      const state = normalizePluginsState(raw);
      for (const market of state.marketplaces)
        assert.equal(typeof market, "string");
      const names = state.plugins.map((item) => item.name);
      // Имя записи — имя папки: всё, что сюда доехало, обязано быть годным именем,
      // единственным и отсортированным, иначе `sync` полез бы не в ту папку.
      for (const item of state.plugins) {
        assert.equal(pluginNameProblem(item.name), null);
        assert.equal(typeof item.enabled, "boolean");
        assert.equal(typeof item.trusted, "boolean");
        assert.equal(typeof item.sha, "string");
        assert.equal(typeof item.digest, "string");
      }
      assert.deepEqual(names, [...new Set(names)], "names must be unique");
      assert.deepEqual(names, [...names].sort(), "names must be sorted");
      assert.deepEqual(normalizePluginsState(state), state);
    }),
    RUNS,
  );
});

test("ports are handed out from 8730 up, once, and never over Iva's own", () => {
  let state: PluginsState = {
    marketplaces: [],
    plugins: [entry({ name: "alpha" }), entry({ name: "beta" })],
  };
  state = assignPluginPorts(state, {
    name: "alpha",
    mcp: ["viewer", "api"],
    services: {},
  });
  // Первый свободный от 8730 вверх, в порядке имён серверов.
  assert.deepEqual(findPlugin(state, "alpha")?.mcp, {
    api: { port: 8730 },
    viewer: { port: 8731 },
  });

  // Второй плагин получает следующие свободные, а не те же.
  state = assignPluginPorts(state, {
    name: "beta",
    mcp: ["only"],
    // Сервис просит свой порт: он свободен, значит достаётся ему.
    services: { viewer: 9000, taken: 8730, reserved: 8723 },
  });
  const beta = findPlugin(state, "beta");
  assert.deepEqual(beta?.mcp, { only: { port: 8732 } });
  assert.deepEqual(beta?.services, {
    // Порты выдаются в порядке имён сервисов. Порт самой Ивы не выдаётся никогда...
    reserved: { port: 8733 },
    // ...и просимый порт, уже занятый другим плагином, тоже: берётся следующий свободный.
    taken: { port: 8734 },
    viewer: { port: 9000 },
  });

  // Повторный вызов ничего не двигает: порт стабилен до `remove`.
  const again = assignPluginPorts(state, {
    name: "alpha",
    mcp: ["viewer", "api", "third"],
    services: {},
  });
  assert.deepEqual(findPlugin(again, "alpha")?.mcp, {
    api: { port: 8730 },
    viewer: { port: 8731 },
    third: { port: 8735 },
  });
  assert.equal(
    assignPluginPorts(state, { name: "absent", mcp: ["x"], services: {} }),
    state,
    "a plugin that is not installed gets nothing",
  );
});

test("property: every handed-out port is unique and never one of Iva's own", () => {
  const names = fc.constantFrom("alpha", "beta", "gamma", "a.b");
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          name: names,
          mcp: fc.array(fc.stringMatching(/^[a-z]{1,4}$/u), { maxLength: 3 }),
          services: fc.dictionary(
            fc.stringMatching(/^[a-z]{1,4}$/u),
            fc.oneof(
              fc.integer({ min: 1, max: 70000 }),
              fc.constantFrom(...RESERVED_PLUGIN_PORTS),
            ),
            { maxKeys: 3 },
          ),
        }),
        { maxLength: 6 },
      ),
      (rounds) => {
        let state: PluginsState = {
          marketplaces: [],
          plugins: ["alpha", "beta", "gamma", "a.b"].map((name) =>
            entry({ name }),
          ),
        };
        for (const round of rounds) state = assignPluginPorts(state, round);
        const ports: number[] = [];
        for (const item of state.plugins)
          for (const map of [item.mcp, item.services])
            for (const value of Object.values(map ?? {}))
              ports.push(value.port);
        // Уникальны между собой и не пересекаются с портами самой Ивы.
        assert.deepEqual([...new Set(ports)].length, ports.length);
        for (const port of ports) {
          assert.equal(RESERVED_PLUGIN_PORTS.includes(port), false);
          assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535);
        }
        // Всё, что попросили в этом прогоне, теперь выдано.
        for (const round of rounds) {
          const item = findPlugin(state, round.name);
          for (const server of round.mcp)
            assert.ok(item?.mcp?.[server], `${round.name}/${server}`);
          for (const service of Object.keys(round.services))
            assert.ok(item?.services?.[service], `${round.name}:${service}`);
        }
        // Занятость — это ровно то, что видит следующая выдача.
        const taken = takenPluginPorts(state);
        for (const port of [...ports, ...RESERVED_PLUGIN_PORTS])
          assert.ok(taken.has(port));
        assert.ok(FIRST_PLUGIN_PORT > Math.max(...RESERVED_PLUGIN_PORTS));
        return true;
      },
    ),
    RUNS,
  );
});
