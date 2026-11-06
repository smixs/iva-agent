// Trust, the toggles, and the processes that follow them.
//
// MCP servers and the services a plugin declares are processes on this machine, so they
// wait for a second switch: `trusted` (ADR-0009). Without it a plugin still gives its
// skills - only nothing runs and nothing calls out. `enabled` is the other switch, and it
// gates everything the plugin has, skills included.
//
// State decides, units follow: every command that writes `plugins.json` ends with one
// reconcile, and the plan comes from what the plugin declares right now, never from what
// the units happen to say.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PluginReport } from "#lib/plugin-reader.ts";
import type { PluginsState } from "#lib/plugin-store.ts";
import {
  canonicalPluginScope,
  pluginUnitPlan,
  reconcilePluginUnits,
  runningPluginUnits,
  unitPartProblem,
  type PluginUnitSource,
} from "../lib/plugin-units.ts";
import { systemdExecArgument } from "../lib/systemd-control.ts";
import {
  pluginReadProblem,
  type PluginCliContext,
} from "./plugin-cli-context.ts";

export function createPluginTrustCommands(context: PluginCliContext) {
  const { runtime, core, args, translate, locked, buildCode, mustFind } =
    context;
  const {
    ok,
    warn,
    bad,
    dataDirAbs,
    hasSystemd,
    systemd,
    NODE,
    NODE_BIN_DIR,
    ROOT,
    UNIT_DIR,
  } = runtime;
  const { expandPluginPlaceholders, readPlugin } = core.reader;
  const {
    assignPluginPorts,
    findPlugin,
    pluginDataDir,
    pluginRoot,
    pluginTokenFile,
    readPluginsState,
    upsertPlugin,
    writePluginsState,
  } = core.store;

  /**
   * Что плагин просит запустить на этой машине: `stdio`-серверы `mcp.json` и сервисы,
   * объявленные в `sh.iva/`. Ровно эти строки владелец и видит перед вопросом о
   * доверии — не «плагин просит доверия», а команда, которая пойдёт в юнит.
   */
  function processCommands(report: PluginReport): string[] {
    const lines: string[] = [];
    for (const [server, declared] of Object.entries(report.mcp)) {
      if (declared.type !== "stdio") continue;
      lines.push(
        `mcp ${server}: ${[declared.command, ...(declared.args ?? [])].join(" ")}`,
      );
    }
    for (const [service, declared] of Object.entries(report.services))
      lines.push(
        `service ${service}: ${[declared.command, ...(declared.args ?? [])].join(" ")}`,
      );
    return lines;
  }

  /**
   * Есть ли у плагина то, что живёт в версии: код или connection-файлы. Сервисы в
   * версию не попадают вовсе — они запускаются из стора юнитом (ADR-0009), поэтому
   * плагин с одними сервисами ничего не пересобирает.
   */
  function inVersion(report: PluginReport, trusted: boolean): boolean {
    return report.code || (trusted && Object.keys(report.mcp).length > 0);
  }

  /** Серверы, которым нужен MCP proxy: только `stdio`, остальные ходят напрямую. */
  function proxiedServers(report: PluginReport): string[] {
    return Object.entries(report.mcp)
      .filter(([, declared]) => declared.type === "stdio")
      .map(([server]) => server)
      .sort();
  }

  /**
   * Токен MCP proxy: 32 байта hex, режим 0600, создаётся один раз. Существующий не
   * перезаписываем — его уже читает работающий прокси, и новый файл означал бы
   * 401 до рестарта юнита.
   */
  function ensureProxyToken(data: string, name: string, server: string): void {
    const file = pluginTokenFile(data, name, server);
    if (existsSync(file)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, {
      mode: 0o600,
    });
  }

  /** Порты и токены плагина, которому только что доверили. Состояние — наружу. */
  function grantPorts(
    data: string,
    state: PluginsState,
    name: string,
    report: PluginReport,
  ): PluginsState {
    const servers = proxiedServers(report).filter(
      (server) => unitPartProblem("MCP server", server) === null,
    );
    const services: Record<string, number> = {};
    for (const [service, declared] of Object.entries(report.services)) {
      if (unitPartProblem("service", service) === null)
        services[service] = declared.port;
    }
    const next = assignPluginPorts(state, { name, mcp: servers, services });
    // PLUGIN_DATA — дом токена, и он обязан быть до того, как юнит стартует.
    mkdirSync(pluginDataDir(data, name), { recursive: true });
    for (const server of servers) ensureProxyToken(data, name, server);
    return next;
  }

  /**
   * Порты и токены ВСЕМ доверенным плагинам по тому, что они объявляют сейчас. Зовут это
   * `update` и `sync`: обновление могло привезти новый MCP-сервер или сервис, а починка
   * могла найти плагин, которому доверяют, но портов у него в состоянии нет. Без этого
   * версия собралась бы с connection без порта, а юнита у сервера не было бы вовсе.
   */
  async function grantPortsToTrusted(
    data: string,
    state: PluginsState,
  ): Promise<PluginsState> {
    let next = state;
    for (const entry of next.plugins) {
      if (!entry.trusted) continue;
      const report = await readPlugin(pluginRoot(data, entry.name));
      if (report.manifest) next = grantPorts(data, next, entry.name, report);
    }
    return next;
  }

  /** Что юниты должны знать о каждом плагине: прочитанное, а не догадки. */
  async function unitSources(
    data: string,
    state: PluginsState,
  ): Promise<PluginUnitSource[]> {
    const sources: PluginUnitSource[] = [];
    for (const entry of state.plugins) {
      if (!entry.enabled || !entry.trusted) continue;
      const root = pluginRoot(data, entry.name);
      if (!existsSync(root)) continue;
      const report = await readPlugin(root);
      if (!report.manifest) continue;
      const paths = { root, data: pluginDataDir(data, entry.name) };
      sources.push({
        name: entry.name,
        enabled: entry.enabled,
        trusted: entry.trusted,
        root,
        data: paths.data,
        mcp: proxiedServers(report).map((server) => ({
          server,
          port: entry.mcp?.[server]?.port,
          // Имя, из которого нельзя сделать имя файла, до токена не доходит: план
          // назовёт его сам, а `pluginTokenFile` на нём кидает.
          tokenFile:
            unitPartProblem("MCP server", server) === null
              ? pluginTokenFile(data, entry.name, server)
              : "",
        })),
        services: Object.entries(report.services).map(
          ([service, declared]) => ({
            service,
            command: declared.command,
            args: (declared.args ?? []).map((argument) =>
              expandPluginPlaceholders(argument, paths),
            ),
            port: entry.services?.[service]?.port,
          }),
        ),
      });
    }
    return sources;
  }

  /**
   * Привести юниты к состоянию: написать нужные, поднять их, снять лишние. Идёт после
   * каждой команды, которая меняет `plugins.json`, — состояние решает, юниты следуют.
   *
   * Без systemd (macOS, контейнер разработчика) юниты не пишутся вовсе: состояние всё
   * равно обновлено, а на сервере его подхватит первый же `iva plugin sync`.
   */
  async function reconcileUnits(
    data: string,
    state: PluginsState,
    moved: readonly string[] = [],
  ): Promise<readonly string[]> {
    const scope = canonicalPluginScope(data);
    const plan = pluginUnitPlan({
      scope,
      plugins: await unitSources(scope.dataRoot, state),
      root: ROOT,
      node: NODE,
      nodeBinDir: NODE_BIN_DIR,
      dataDir: scope.dataRoot,
      dataDirEnvironment: systemdExecArgument(
        `ASSISTANT_DATA_DIR=${scope.dataRoot}`,
      ),
    });
    for (const line of plan.diagnostics) warn(line);
    if (!hasSystemd()) {
      if (plan.units.length)
        warn(
          translate(
            "no systemd here: the units of the plugin are not written (they only run on a Linux server)",
            "systemd здесь нет: юниты плагина не пишутся (они работают только на Linux-сервере)",
          ),
        );
      return [];
    }
    // Отказ systemd не отменяет уже записанное состояние: он называется и остаётся
    // задачей владельца (её же повторит `iva doctor`).
    let done;
    try {
      done = reconcilePluginUnits({
        plan,
        moved,
        manager: systemd.manager,
        root: ROOT,
        unitDir: UNIT_DIR,
        systemd,
        ensureDataDir: (plugin) =>
          mkdirSync(pluginDataDir(data, plugin), { recursive: true }),
        log: (message) => ok(message),
      });
    } catch (error) {
      bad(
        `the plugin units were not brought up to date: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    if (done.started.length) ok(`running: ${done.started.join(", ")}`);
    if (done.restarted.length) ok(`restarted: ${done.restarted.join(", ")}`);
    for (const failure of done.failures) bad(failure);
    return done.restartAttempted;
  }

  /**
   * Перезапустить юниты плагинов, чьё содержимое только что сменилось. `enable --now`
   * работающий юнит не трогает, а рестарт — единственное, что переводит его на новый
   * код: у плагина с одними сервисами версия вообще не пересобирается, и другого
   * момента подхватить обновление у него нет.
   */
  function restartMoved(
    data: string,
    state: PluginsState,
    names: readonly string[],
    already: readonly string[],
  ): void {
    if (names.length === 0 || !hasSystemd()) return;
    const entries = state.plugins.filter(
      (entry) => entry.enabled && entry.trusted && names.includes(entry.name),
    );
    const live = runningPluginUnits({
      scope: canonicalPluginScope(data),
      entries,
      unitDir: UNIT_DIR,
      manager: systemd.manager,
      systemd,
    }).filter((unit) => !already.includes(unit));
    if (live.length === 0) return;
    try {
      systemd.restart(live);
      ok(`restarted: ${live.join(", ")}`);
    } catch (error) {
      bad(
        `${live.join(", ")} did not restart onto the new code: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function setTrusted(trusted: boolean): Promise<void> {
    const data = dataDirAbs();
    const { entry, report, changed } = await locked(data, async () => {
      const state = await readPluginsState(data);
      const found = mustFind(state, args[0]);
      const read = await readPlugin(pluginRoot(data, found.name));
      if (!read.manifest && trusted)
        throw new Error(
          `${found.name} is not readable: ${pluginReadProblem(read)}`,
        );
      if (found.trusted === trusted) {
        // Состояние уже такое: юниты всё равно сверяем — их могли снести руками.
        await reconcileUnits(data, state);
        return { entry: found, report: read, changed: false };
      }
      let next = upsertPlugin(state, { ...found, trusted });
      if (trusted) next = grantPorts(data, next, found.name, read);
      await writePluginsState(data, next);
      await reconcileUnits(data, next);
      return {
        entry: findPlugin(next, found.name) ?? found,
        report: read,
        changed: true,
      };
    });
    if (!changed) {
      ok(`${entry.name} is already ${trusted ? "trusted" : "untrusted"}`);
      return;
    }
    // Connection-файлы живут в версии, поэтому смена доверия у плагина с MCP — это
    // сборка и рестарт. Доверие, которое не собралось, снимается обратно: иначе
    // владелец остался бы с записью «доверен» и без тулов в работающей версии.
    if (Object.keys(report.mcp).length && entry.enabled) {
      const { failure } = await buildCode(entry.name, trusted);
      if (failure !== null) {
        if (trusted) {
          await locked(data, async () => {
            const state = await readPluginsState(data);
            const back = upsertPlugin(state, { ...entry, trusted: false });
            await writePluginsState(data, back);
            await reconcileUnits(data, back);
          });
          throw new Error(`${entry.name} stays untrusted: ${failure}`);
        }
        warn(failure);
      }
    }
    const running = processCommands(report).length;
    ok(
      trusted
        ? translate(
            `${entry.name} trusted${running ? ` — ${running} process(es) run as systemd units` : ""}`,
            `${entry.name} доверен${running ? ` — процессов под systemd: ${running}` : ""}`,
          )
        : translate(
            `${entry.name} untrusted — its processes are stopped and its units removed`,
            `${entry.name} больше не доверен — процессы погашены, юниты сняты`,
          ),
    );
  }

  async function toggle(enabled: boolean): Promise<void> {
    const data = dataDirAbs();
    const { entry, code } = await locked(data, async () => {
      const state = await readPluginsState(data);
      const found = mustFind(state, args[0]);
      let next = state;
      if (found.enabled !== enabled) {
        next = upsertPlugin(state, { ...found, enabled });
        await writePluginsState(data, next);
      }
      const report = await readPlugin(pluginRoot(data, found.name));
      // Выключенный плагин ничего не запускает: `enabled` гасит и юниты тоже.
      await reconcileUnits(data, next);
      return { entry: found, code: inVersion(report, found.trusted) };
    });
    if (entry.enabled === enabled) {
      ok(`${entry.name} is already ${enabled ? "enabled" : "disabled"}`);
      return;
    }
    // Тумблер у плагина с кодом — это состав версии, значит сборка и рестарт.
    // Включение, которое не собралось, возвращается в выключенное: иначе владелец
    // остался бы с записью «включён» и без кода в работающей версии.
    if (code) {
      const { failure } = await buildCode(entry.name, enabled);
      if (failure !== null) {
        if (enabled) {
          await locked(data, async () => {
            const state = await readPluginsState(data);
            await writePluginsState(
              data,
              upsertPlugin(state, { ...entry, enabled: false }),
            );
          });
          throw new Error(`${entry.name} stays disabled: ${failure}`);
        }
        warn(failure);
      }
    }
    ok(
      enabled
        ? translate(
            `${entry.name} enabled — its skills return on the next turn`,
            `${entry.name} включён — скиллы вернутся со следующего хода`,
          )
        : translate(
            `${entry.name} disabled — its skills are gone from the next turn`,
            `${entry.name} выключен — скиллов не будет со следующего хода`,
          ),
    );
  }

  return {
    setTrusted,
    toggle,
    /** Что нужно установке и обновлению: они меняют то же состояние и те же юниты. */
    inVersion,
    processCommands,
    grantPorts,
    grantPortsToTrusted,
    reconcileUnits,
    restartMoved,
  };
}
