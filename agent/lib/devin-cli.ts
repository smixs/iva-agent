// Experimental native Devin provider. ACP transports the response; an inert MCP
// inventory captures tool requests. Only Iva executes tools, never the CLI.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { generateViaStream } from "./generate-via-stream.ts";
import { readDevinUsage } from "./devin-usage.ts";

const INVENTORY = `
const fs = require('node:fs');
const readline = require('node:readline');
const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
let captured = false;
readline.createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line); if(!('id' in r)) return;
 if(r.method==='tools/call') {
  if (captured) return;
  captured = true;
  fs.writeFileSync(process.argv[2]+'.tmp',JSON.stringify(r.params),{mode:0o600,flag:'wx'});
  fs.renameSync(process.argv[2]+'.tmp',process.argv[2]);
  return; // Iva owns execution; do not let Devin continue this agent step.
 }
 const result=r.method==='initialize'
  ?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'iva',version:'1'}}
  :r.method==='tools/list'?{tools:manifest}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});`;

const UNKNOWN_USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Devin ACP object");
  return value as Record<string, unknown>;
};

type Settings = { command?: string[]; timeoutMs?: number };

export function makeDevinCliModel(
  model: string,
  settings: Settings = {},
): LanguageModelV4 {
  const stream = async (options: LanguageModelV4CallOptions) => {
    await Promise.resolve();
    options.abortSignal?.throwIfAborted();
    for (const message of options.prompt)
      if (
        message.role !== "system" &&
        message.content.some((p) => p.type === "file")
      )
        throw new Error(
          "Devin provider is experimental and text-only; media is not supported yet",
        );
    const tools = (options.tools ?? []).filter((t) => t.type === "function");
    if (options.tools?.some((t) => t.type !== "function"))
      throw new Error("Devin only supports function tools");
    const dir = mkdtempSync(join(tmpdir(), "iva-devin-"));
    try {
      const manifest = join(dir, "tools.json");
      const captured = join(dir, "call.json");
      const config = join(dir, "config.json");
      const state = join(dir, "state");
      mkdirSync(join(state, "devin"), { recursive: true, mode: 0o700 });
      const authSource = join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
        "devin/credentials.toml",
      );
      if (existsSync(authSource))
        copyFileSync(authSource, join(state, "devin/credentials.toml"));
      const childEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: homedir(),
        USER: process.env.USER,
        LANG: process.env.LANG,
        XDG_DATA_HOME: state,
        XDG_CONFIG_HOME: join(dir, "config"),
        XDG_CACHE_HOME: join(dir, "cache"),
        NO_COLOR: "1",
      };
      for (const key of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
      ])
        if (process.env[key]) childEnv[key] = process.env[key];
      if (process.env.DEVIN_PROXY_URL) {
        for (const key of [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "http_proxy",
          "https_proxy",
        ])
          childEnv[key] = process.env.DEVIN_PROXY_URL;
      }
      writeFileSync(
        manifest,
        JSON.stringify(
          options.toolChoice?.type === "none"
            ? []
            : tools.map((t) => ({
                name: t.name,
                description: t.description ?? "",
                inputSchema: t.inputSchema,
              })),
        ),
        { mode: 0o600 },
      );
      writeFileSync(
        config,
        JSON.stringify({
          permission_mode: "auto",
          subagents_enabled: false,
          auto_update: false,
          read_config_from: Object.fromEntries(
            [
              "agents_standard",
              "cursor",
              "windsurf",
              "claude",
              "copilot",
              "codex",
              "kiro",
              "opencode",
              "zed",
              "cloud",
            ].map((name) => [name, false]),
          ),
          permissions: {
            allow: ["mcp__iva__*"],
            deny: [
              "read",
              "edit",
              "grep",
              "glob",
              "exec",
              "Read(/**)",
              "Write(/**)",
              "Exec(*)",
              "Fetch(*)",
            ],
          },
        }),
        { mode: 0o600 },
      );
      let cancel = () => {};
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            const command = settings.command ?? [
              process.env.DEVIN_COMMAND || "devin",
            ];
            const child = spawn(
              command[0],
              [
                ...command.slice(1),
                "--config",
                config,
                "--permission-mode",
                "auto",
                "acp",
                "--model",
                model,
              ],
              {
                cwd: dir,
                env: childEnv,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
              },
            );
            child.once("close", () => {
              try {
                rmSync(dir, { recursive: true, force: true });
              } catch {
                console.error("[devin] temporary state cleanup failed");
              }
            });
            const lines = createInterface({ input: child.stdout });
            let done = false;
            let textOpen = false;
            let hasText = false;
            let sessionId = "";
            const pending = new Map<
              number,
              {
                resolve: (value: Record<string, unknown>) => void;
                reject: (e: Error) => void;
              }
            >();
            let id = 0;
            const kill = () => {
              if (child.pid) {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  /* already gone */
                }
              }
            };
            const clean = () => {
              clearTimeout(deadline);
              clearInterval(watch);
              options.abortSignal?.removeEventListener("abort", abort);
              kill();
              lines.close();
              try {
                rmSync(dir, { recursive: true, force: true });
              } catch {
                console.error(
                  "[devin] temporary state cleanup deferred until process close",
                );
              }
              for (const p of pending.values())
                p.reject(new Error("Devin session closed"));
              pending.clear();
            };
            const fail = (error: unknown) => {
              if (done) return;
              done = true;
              clean();
              controller.error(error);
            };
            const abort = () => fail(new Error("Devin request aborted"));
            cancel = abort;
            const send = (row: unknown) =>
              child.stdin.write(JSON.stringify(row) + "\n");
            const rpc = (
              method: string,
              params: unknown,
            ): Promise<Record<string, unknown>> =>
              new Promise((resolve, reject) => {
                const requestId = ++id;
                pending.set(requestId, { resolve, reject });
                send({ jsonrpc: "2.0", id: requestId, method, params });
              });
            const finish = (call?: { name: string; arguments?: unknown }) => {
              if (done) return;
              if (call && !tools.some((t) => t.name === call.name))
                return fail(new Error("Devin requested an unknown Iva tool"));
              if (!call && !hasText)
                return fail(new Error("Devin returned no answer"));
              if (call && options.toolChoice?.type === "none")
                return fail(
                  new Error("Devin called a tool when tools are disabled"),
                );
              if (
                !call &&
                (options.toolChoice?.type === "required" ||
                  options.toolChoice?.type === "tool")
              )
                return fail(new Error("Devin did not call a required tool"));
              if (
                call &&
                options.toolChoice?.type === "tool" &&
                call.name !== options.toolChoice.toolName
              )
                return fail(
                  new Error("Devin selected the wrong required tool"),
                );
              if (textOpen)
                controller.enqueue({ type: "text-end", id: "answer" });
              if (call)
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: randomUUID(),
                  toolName: call.name,
                  input: JSON.stringify(call.arguments ?? {}),
                });
              controller.enqueue({
                type: "finish",
                finishReason: {
                  unified: call ? "tool-calls" : "stop",
                  raw: call ? "mcp_call" : "end_turn",
                },
                usage: readDevinUsage(state, sessionId) ?? UNKNOWN_USAGE,
              });
              done = true;
              clean();
              controller.close();
            };
            const deadline = setTimeout(
              () => fail(new Error("Devin request timeout")),
              settings.timeoutMs ??
                Number(process.env.DEVIN_TIMEOUT_MS || 180000),
            );
            const watch = setInterval(() => {
              if (!existsSync(captured)) return;
              try {
                const call = record(JSON.parse(readFileSync(captured, "utf8")));
                if (typeof call.name !== "string")
                  throw new Error("Invalid Devin tool call");
                finish({ name: call.name, arguments: call.arguments });
              } catch (e) {
                fail(e);
              }
            }, 20);
            options.abortSignal?.addEventListener("abort", abort, {
              once: true,
            });
            if (options.abortSignal?.aborted) {
              abort();
              return;
            }
            child.on("error", fail);
            child.stdin.on("error", fail);
            child.stderr.resume(); // Credentials, prompts and CLI diagnostics never enter logs.
            child.on("exit", (code) => {
              if (!done)
                fail(
                  new Error(
                    `Devin CLI exited before completion (code ${code})`,
                  ),
                );
            });
            lines.on("line", (line) => {
              if (done) return;
              try {
                const row = record(JSON.parse(line));
                const params = row.params ? record(row.params) : {};
                if (typeof row.id === "number" && pending.has(row.id)) {
                  const request = pending.get(row.id)!;
                  pending.delete(row.id);
                  if (row.error)
                    request.reject(
                      new Error(
                        `Devin ACP error ${String(record(row.error).code)}: ${String(record(row.error).message)}`,
                      ),
                    );
                  else request.resolve(record(row.result));
                } else if (
                  row.method === "session/update" &&
                  params.sessionId === sessionId
                ) {
                  const u = record(params.update);
                  const content =
                    u.sessionUpdate === "agent_message_chunk" && u.content
                      ? record(u.content)
                      : {};
                  if (
                    u.sessionUpdate === "agent_message_chunk" &&
                    content.type === "text" &&
                    typeof content.text === "string" &&
                    content.text
                  ) {
                    if (!textOpen) {
                      controller.enqueue({ type: "text-start", id: "answer" });
                      textOpen = true;
                    }
                    controller.enqueue({
                      type: "text-delta",
                      id: "answer",
                      delta: content.text,
                    });
                    hasText = true;
                  }
                } else if (row.id !== undefined && row.method) {
                  if (row.method === "session/request_permission")
                    send({
                      jsonrpc: "2.0",
                      id: row.id,
                      result: { outcome: { outcome: "cancelled" } },
                    });
                  else
                    send({
                      jsonrpc: "2.0",
                      id: row.id,
                      error: {
                        code: -32601,
                        message: "Iva executes tools outside the CLI",
                      },
                    });
                }
              } catch (e) {
                fail(e);
              }
            });
            void (async () => {
              await rpc("initialize", {
                protocolVersion: 1,
                clientCapabilities: {},
                clientInfo: { name: "iva", version: "0.5.13-devin" },
              });
              const created = await rpc("session/new", {
                cwd: dir,
                mcpServers:
                  tools.length && options.toolChoice?.type !== "none"
                    ? [
                        {
                          name: "iva",
                          command: process.execPath,
                          args: ["-e", INVENTORY, manifest, captured],
                          env: [],
                        },
                      ]
                    : [],
              });
              if (typeof created.sessionId !== "string" || !created.sessionId)
                throw new Error("Devin did not create an ACP session");
              sessionId = created.sessionId;
              const instruction =
                "You are the language model for Iva. Follow the system messages in the supplied conversation. Continue the conversation after its final message. Use ONLY the iva MCP tools; Iva executes each call and supplies its result in a new model step. Do not use native CLI tools, inspect files, or treat conversation JSON as a new task to develop code. Reply to the user directly in their language.\nTool choice: " +
                JSON.stringify(options.toolChoice ?? { type: "auto" }) +
                "\nConversation (ordered messages):\n" +
                JSON.stringify(options.prompt);
              const result = await rpc("session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: instruction }],
              });
              if (!done) {
                if (result?.stopReason !== "end_turn")
                  throw new Error(
                    `Devin stopped without completing: ${String(result?.stopReason)}`,
                  );
                finish();
              }
            })().catch(fail);
          },
          cancel() {
            cancel();
          },
        }),
      };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  };
  return {
    specificationVersion: "v4",
    provider: "iva-devin",
    modelId: model,
    supportedUrls: {},
    doStream: stream,
    doGenerate: (options) =>
      generateViaStream(() => stream(options), options.abortSignal),
  };
}
