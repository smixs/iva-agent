import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { TestContext } from "node:test";

export const NPM_CLI = execFileSync("sh", ["-c", "command -v npm"], {
  encoding: "utf8",
}).trim();
export type ArchiveFault = "ok" | "404" | "drop" | "integrity" | "truncated";

/** An archive dependency on the wire, with a redirect and a private empty npm cache. */
export async function eveArchive(t: TestContext, root: string) {
  const packageRoot = join(root, "archive-input/package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "eve", version: "0.51.1-iva.1" }),
  );
  writeFileSync(join(packageRoot, "index.js"), "export const ready = true;\n");
  const archive = join(root, "eve.tgz");
  execFileSync("tar", [
    "-czf",
    archive,
    "-C",
    join(root, "archive-input"),
    "package",
  ]);
  const bytes = readFileSync(archive);
  const sri = (data: Buffer) =>
    "sha512-" + createHash("sha512").update(data).digest("base64");
  let fault: ArchiveFault = "ok";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/eve.tgz") {
      response.writeHead(302, { location: "/asset.tgz" }).end();
    } else if (request.url !== "/asset.tgz" || fault === "404") {
      response.writeHead(404).end("missing");
    } else if (fault === "drop") {
      request.socket.destroy();
    } else if (fault === "truncated") {
      response.writeHead(200, { "content-length": bytes.length });
      response.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      response.end();
    } else {
      response
        .writeHead(200, { "content-type": "application/octet-stream" })
        .end(bytes);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("no archive port");
  const url = `http://127.0.0.1:${address.port}/eve.tgz`;
  return {
    url,
    requests,
    setFault(value: ArchiveFault) {
      fault = value;
    },
    writeManifest(directory: string, version = "0.5.12") {
      const dependencies = { eve: url };
      const pkg = {
        name: "iva",
        version,
        type: "module",
        dependencies,
        scripts: {
          build: `node -e 'require("fs").appendFileSync(process.env.IVA_TEST_NPM_LOG, "CI_OK " + process.cwd() + "\\n"); console.error("EVE_TEST_STOP_AFTER_CI"); process.exit(42)'`,
        },
      };
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify(pkg));
      writeFileSync(
        join(directory, "package-lock.json"),
        JSON.stringify({
          name: "iva",
          version,
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": pkg,
            "node_modules/eve": {
              version: "0.51.1-iva.1",
              resolved: url,
              integrity: sri(
                fault === "integrity" ? Buffer.from("wrong archive") : bytes,
              ),
            },
          },
        }),
      );
      writeFileSync(
        join(directory, ".npmrc"),
        [
          `cache=${join(root, "npm-cache")}`,
          `registry=http://127.0.0.1:${address.port}/registry/`,
          "audit=false",
          "fund=false",
          "fetch-retries=0",
          "fetch-timeout=1500",
          "update-notifier=false",
        ].join("\n") + "\n",
      );
    },
  };
}

export function runChild(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, { env, cwd });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    },
  );
}
