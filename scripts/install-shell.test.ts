import assert from "node:assert/strict";
import {
  execFileSync,
  spawn,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  eveArchive,
  NPM_CLI,
  type ArchiveFault,
} from "./fixtures/eve-archive.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PYTHON = execFileSync("sh", ["-c", "command -v python3"], {
  encoding: "utf8",
}).trim();
const RUN_IN_TTY = `import os,pty,select,signal,sys,time
pid, fd = pty.fork()
if pid == 0:
    os.execvp('bash', ['bash', *sys.argv[1:]])
os.write(fd, sys.stdin.buffer.read())
deadline = time.monotonic() + 15
try:
    while True:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            if os.environ.get('IVA_TEST_DEFAULT_ANSWERS') == '1' and (data.endswith(b': ') or data.endswith(b'[Y/n] ')):
                os.write(fd, b'\\n')
        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished:
            break
        if time.monotonic() > deadline:
            os.killpg(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            raise TimeoutError('installer did not exit after terminal answers')
finally:
    os.close(fd)
sys.exit(os.waitstatus_to_exitcode(status))
`;

/**
 * Every stand-in records the call and succeeds: what the installer must be judged on is
 * which stages it decides to run, so the log is the artifact. `$0` names the tool, so one
 * script serves sudo, systemctl, loginctl, uv and the two globals npm "installs".
 */
const RECORDER = `#!/bin/sh
echo "$(basename "$0") $*" >> "$IVA_TEST_CALLS"
exit 0
`;

/** sudo records root calls and models only D13's private cleanup and failure boundary. */
const SUDO = `#!/bin/sh
echo "sudo $*" >> "$IVA_TEST_CALLS"
[ "$IVA_TEST_SUDO_PASSWORD" != 1 ] || exit 1
[ "$1" != -n ] || shift

replace_managed_path() {
  [ -n "$IVA_TEST_REPLACE_GH_PATH" ] || return
  marker="$IVA_TEST_GH_ETC_DIR/.replacement-$IVA_TEST_REPLACE_GH_PATH-done"
  [ ! -e "$marker" ] || return
  case "$IVA_TEST_REPLACE_GH_PATH" in
    keyring)
      path="$IVA_TEST_GH_ETC_DIR/keyrings/githubcli-archive-keyring.gpg"
      bytes=FOREIGN_KEYRING_PRESENT
      ;;
    source)
      path="$IVA_TEST_GH_ETC_DIR/sources.list.d/github-cli.list"
      bytes=FOREIGN_SOURCE_PRESENT
      ;;
    *) return ;;
  esac
  replacement="$path.foreign.$$"
  printf '%s\n' "$bytes" >"$replacement"
  chmod 0640 "$replacement"
  mv -f "$replacement" "$path"
  : >"$marker"
}

last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  "$TMPDIR"/iva-gh-apt-??????)
    if [ "$1" = rm ]; then
      marker="$TMPDIR/.iva-gh-cleanup-failed-once"
      if [ "$IVA_TEST_FAIL_GH_CLEANUP_ALWAYS" = 1 ]; then exit 74; fi
      if [ "$IVA_TEST_FAIL_GH_CLEANUP_ONCE" = 1 ] && [ ! -e "$marker" ]; then
        : >"$marker"
        exit 73
      fi
      /bin/rm -rf -- "$last"
      exit
    fi
    ;;
esac

saw_apt_get=false
saw_update=false
saw_private_gh_config=false
for arg in "$@"; do
  [ "$arg" = apt-get ] && saw_apt_get=true
  [ "$arg" = update ] && saw_update=true
  case "$arg" in *iva-gh-apt-*) saw_private_gh_config=true ;; esac
done
if [ "$saw_apt_get" = true ] && [ "$saw_update" = true ] \
  && [ "$saw_private_gh_config" = true ]; then
  replace_managed_path
fi

if [ "$IVA_TEST_FAIL_GH_PACKAGE" = 1 ]; then
  for arg in "$@"; do
    if [ "$arg" = gh ]; then exit 1; fi
  done
fi
exit 0
`;

const PINNED_ARTIFACTS = {
  uv: {
    url: "https://github.com/astral-sh/uv/releases/download/0.12.5/uv-installer.sh",
    sha256: "504511fbbbd811aeaba6738abc79408956b6c7da0ca35437b3dcc24a41efc111",
  },
  nvm: {
    url: "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh",
    sha256: "abdb525ee9f5b48b34d8ed9fc67c6013fb0f659712e401ecd88ab989b3af8f53",
  },
  agentBrowser: {
    url: "https://registry.npmjs.org/agent-browser/-/agent-browser-0.34.0.tgz",
    sha256: "a4744fb189e598467abcfb3acdde07118d9e5cb43dc3b31727f869af4eb9d598",
  },
  gws: {
    url: "https://registry.npmjs.org/@googleworkspace/cli/-/cli-0.22.5.tgz",
    sha256: "b3d415a6d1b09589b13f6a71451d3d3927c4dc4701822d6aae549f8ff8f3380a",
  },
} as const;

/** A network-free curl that materializes only the synthetic artifacts the installer knows. */
const CURL = `#!/bin/sh
echo "curl $*" >> "$IVA_TEST_CALLS"
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    http://*|https://*) url="$1" ;;
  esac
  shift
done
case "$url" in
  *cli.github.com*)
    if [ "$IVA_TEST_FAIL_GH_REPOSITORY" = 1 ]; then exit 22; fi
    printf 'synthetic github keyring\n'
    ;;
  *uv-installer.sh)
    if [ "$IVA_TEST_FAIL_ARTIFACT_DOWNLOAD" = uv ]; then exit 22; fi
    cat >"$out" <<'IVA_UV_INSTALLER'
#!/bin/sh
echo "execute uv installer" >> "$IVA_TEST_CALLS"
if [ "$IVA_TEST_FAIL_ARTIFACT_EXECUTE" = uv ]; then exit 70; fi
mkdir -p "$HOME/.local/bin"
ln -sf "$IVA_TEST_RECORDER" "$HOME/.local/bin/uv"
IVA_UV_INSTALLER
    ;;
  *nvm-sh/nvm/v0.40.1/install.sh)
    if [ "$IVA_TEST_FAIL_ARTIFACT_DOWNLOAD" = nvm ]; then exit 22; fi
    cat >"$out" <<'IVA_NVM_INSTALLER'
#!/bin/sh
echo "execute nvm installer" >> "$IVA_TEST_CALLS"
mkdir -p "$NVM_DIR"
cat >"$NVM_DIR/nvm.sh" <<'IVA_NVM_SH'
nvm() {
  case "$1" in
    install)
      mkdir -p "$NVM_DIR/versions/node/v24.19.0/bin"
      ln -sf "$IVA_TEST_NODE" "$NVM_DIR/versions/node/v24.19.0/bin/node"
      : >"$IVA_TEST_NODE_READY_MARKER"
      ;;
    which) printf '%s\n' "$NVM_DIR/versions/node/v24.19.0/bin/node" ;;
  esac
}
IVA_NVM_SH
IVA_NVM_INSTALLER
    ;;
  */repair.sh)
    # The repair script of the channel, which is what the installer hands an existing
    # installation to. The bytes are the real file in the repository.
    cat "$IVA_TEST_REPAIR_SH" >"$out"
    ;;
  *agent-browser-0.34.0.tgz|*cli-0.22.5.tgz)
    case "$url" in
      *agent-browser*) artifact=agent-browser ;;
      *) artifact=gws ;;
    esac
    if [ "$IVA_TEST_FAIL_ARTIFACT_DOWNLOAD" = "$artifact" ]; then exit 22; fi
    printf 'synthetic npm package\n' >"$out"
    ;;
  *google-workspace-cli-*-unknown-linux-musl.tar.gz)
    if [ "$IVA_TEST_FAIL_ARTIFACT_DOWNLOAD" = musl ]; then exit 22; fi
    mkdir -p "$TMPDIR/musl"
    printf '#!/bin/sh\necho "gws 0.22.5"\nexit \${IVA_TEST_MUSL_EXIT:-0}\n' >"$TMPDIR/musl/gws"
    chmod +x "$TMPDIR/musl/gws"
    tar -czf "$out" -C "$TMPDIR/musl" ./gws
    rm -rf "$TMPDIR/musl"
    ;;
esac
exit 0
`;

/** The real hash tool's contract, with one deterministic corruption switch per artifact. */
const SHA256SUM = `#!/bin/sh
echo "sha256sum $*" >> "$IVA_TEST_CALLS"
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  *aarch64-unknown-linux-musl.tar.gz) artifact=musl; expected=e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a ;;
  *x86_64-unknown-linux-musl.tar.gz) artifact=musl; expected=4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920 ;;
  */iva-uv-*) artifact=uv; expected=${PINNED_ARTIFACTS.uv.sha256} ;;
  */iva-nvm-*) artifact=nvm; expected=${PINNED_ARTIFACTS.nvm.sha256} ;;
  */iva-agent-browser-*) artifact=agent-browser; expected=${PINNED_ARTIFACTS.agentBrowser.sha256} ;;
  */iva-gws-*) artifact=gws; expected=${PINNED_ARTIFACTS.gws.sha256} ;;
  *) exit 2 ;;
esac
if [ "$IVA_TEST_CORRUPT_ARTIFACT" = "$artifact" ]; then
  expected=0000000000000000000000000000000000000000000000000000000000000000
fi
printf '%s  %s\n' "$expected" "$last"
`;

/** Package-manager stand-in that can reject only an install containing gh. */
const PACKAGE_MANAGER = `#!/bin/sh
[ "$IVA_TEST_OS" != Darwin ] || [ "$IVA_TEST_BREW_READ_STDIN" != 1 ] || cat >/dev/null
echo "$(basename "$0") $*" >> "$IVA_TEST_CALLS"
if [ "$IVA_TEST_FAIL_GH_PACKAGE" = 1 ]; then
  for arg in "$@"; do
    if [ "$arg" = gh ]; then exit 1; fi
  done
fi
exit 0
`;

/**
 * Non-interactive bash reads this file before install.sh. It lets a world model missing
 * commands without exposing the real host binaries or adding a production-only test hook.
 */
const COMMAND_MASK = `command() {
  if [ "$1" = -v ]; then
    case " $IVA_TEST_MISSING_COMMANDS " in
      *" $2 "*)
        if [ "$2" = node ] && [ -e "$IVA_TEST_NODE_READY_MARKER" ]; then
          builtin command "$@"
          return
        fi
        if [ "$2" = gh ] && [ "$IVA_TEST_GH_READY_AFTER_INSTALL" = 1 ]; then
          if [ -e "$IVA_TEST_GH_READY_MARKER" ]; then
            builtin command "$@"
            return
          fi
          : >"$IVA_TEST_GH_READY_MARKER"
        fi
        return 1
        ;;
    esac
  fi
  builtin command "$@"
}
`;

/**
 * npm as far as install.sh can tell: it records every call, writes the hidden lockfile the
 * way a real `npm ci` does, produces a .output the way a real build does, and drops the
 * global binaries in the requested prefix, or `npm prefix -g` by default.
 */
const NPM = `#!/bin/sh
echo "npm $*" >> "$IVA_TEST_CALLS"
# What npm really got: a local path is a tarball only if it is a file with a tarball
# extension, otherwise npm opens <path>/package.json and dies with ENOTDIR.
for arg in "$@"; do
  case "$arg" in
    *iva-agent-browser-*|*iva-gws-*)
      [ -f "$arg" ] && echo "verified tarball file $arg" >> "$IVA_TEST_CALLS"
      ;;
  esac
done
case "$*" in
  *iva-agent-browser-*) [ "$IVA_TEST_FAIL_VERIFIED_NPM" = agent-browser ] && exit 71 ;;
  *iva-gws-*) [ "$IVA_TEST_FAIL_VERIFIED_NPM" = gws ] && exit 71 ;;
esac
case "$1" in
  prefix)
    printf '%s\\n' "$IVA_TEST_NPM_PREFIX"
    ;;
  ci|install)
    if [ -n "$IVA_TEST_REAL_NPM" ]; then
      "$IVA_TEST_NODE" "$IVA_TEST_REAL_NPM" "$@"
      exit $?
    fi
    mkdir -p node_modules/.bin
    cp package-lock.json node_modules/.package-lock.json
    ;;
  exec)
    case "$*" in
      *"eve build"*)
        # The build is where a weak VPS dies: the OOM killer takes it (137), and where the
        # test needs a run to still be alive, it waits here after saying so.
        if [ -n "$IVA_TEST_FREEZE_LOG" ]; then
          # The log every rollback command redirects into stops being writable while the
          # run is still going - a revoked mount, a full disk, another hand on the box.
          chmod 000 "$TMPDIR"/iva-install-*.log
        fi
        if [ -n "$IVA_TEST_BUILD_EXIT" ]; then
          # A real build clears the output directory before it writes into it, which is
          # why a build that dies half-way takes the working installation with it.
          rm -rf .output
          echo "Killed" >&2
          exit "$IVA_TEST_BUILD_EXIT"
        fi
        if [ -n "$IVA_TEST_BUILD_WAIT" ]; then
          : > "$IVA_TEST_BUILD_WAIT"
          sleep 10
        fi
        mkdir -p .output
        printf 'built' > .output/server.mjs
        ;;
    esac
    ;;
  i)
    install_prefix="$IVA_TEST_NPM_PREFIX"
    previous=""
    for arg in "$@"; do
      if [ "$previous" = --prefix ]; then install_prefix="$arg"; fi
      previous="$arg"
    done
    tool=""
    case "$*" in
      *agent-browser*) tool=agent-browser ;;
      *googleworkspace*|*iva-gws-*) tool=gws ;;
    esac
    if [ -n "$tool" ]; then
      mkdir -p "$install_prefix/bin"
      ln -sf "$IVA_TEST_RECORDER" "$install_prefix/bin/$tool"
      if [ "$tool" = gws ]; then
        mkdir -p "$install_prefix/lib/node_modules/@googleworkspace/cli/bin"
        binary="$install_prefix/lib/node_modules/@googleworkspace/cli/bin/gws"
        printf '#!/bin/sh\necho "gws --version" >> "$IVA_TEST_CALLS"\nif [ -n "$IVA_TEST_GWS_ERROR" ]; then echo "$IVA_TEST_GWS_ERROR" >&2; exit 1; fi\necho "gws 0.22.5"\n' >"$binary"
        chmod +x "$binary"
        ln -sf "$binary" "$install_prefix/bin/gws"
      fi
    fi
    ;;
esac
exit 0
`;

/**
 * The iva CLI the installer delegates the units to, including the failure it is famous
 * for. It is also the only thing the test can ask about the installation while the run is
 * still going: on request it writes down where the copy of .env is at that moment, with
 * what permissions, and what the run has put in TMPDIR.
 */
const IVA_CLI = `import { appendFileSync, chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (process.env.IVA_TEST_CALLS)
  appendFileSync(process.env.IVA_TEST_CALLS, \`iva \${args.join(" ")}\\n\`);
const entries = (dir) => {
  try {
    return readdirSync(dir).map((name) => ({
      name,
      mode: (statSync(join(dir, name)).mode & 0o777).toString(8),
    }));
  } catch {
    return [];
  }
};
if (process.env.IVA_TEST_SNAPSHOT && args[0] === "_install-units") {
  const backups = join(process.cwd(), "data/update-backups");
  let dirMode = "";
  try {
    dirMode = (statSync(backups).mode & 0o777).toString(8);
  } catch {}
  writeFileSync(
    process.env.IVA_TEST_SNAPSHOT,
    JSON.stringify({
      cwd: process.cwd(),
      backupsMode: dirMode,
      backups: entries(backups),
      tmp: entries(process.env.TMPDIR ?? "/tmp"),
    }),
  );
}
// Something in the tree where a stashed file has to go back: a directory in its place is
// what an interrupted tool leaves, and it is what makes a restore fail for real.
if (process.env.IVA_TEST_BLOCK_RESTORE && args[0] === "_install-units") {
  const at = join(process.cwd(), process.env.IVA_TEST_BLOCK_RESTORE);
  rmSync(at, { force: true, recursive: true });
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "in-the-way"), "blocked\\n");
}
// A tree that stops accepting writes half-way through - a full disk, a revoked mount, a
// directory somebody made read-only - so the undo cannot finish either.
if (process.env.IVA_TEST_FREEZE_TREE && args[0] === "_install-units")
  chmodSync(process.cwd(), 0o500);
if (args[0] === "_activate-units" && process.env.IVA_TEST_UNITS_FAIL) {
  process.stderr.write("Failed to connect to bus: No such file or directory\\n");
  process.exit(1);
}
`;

type RunOptions = {
  readonly args?: readonly string[];
  readonly calls?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** The installer to run, when it must be one sitting inside the installation. */
  readonly script?: string;
  /** Run it with no stderr at all, the way a terminal that went away leaves it. */
  readonly closedStderr?: boolean;
  readonly pipedStdin?: boolean;
  readonly ttyInput?: string;
};

type World = {
  readonly dir: string;
  readonly install: string;
  /** The installer copy outside the installation: how `curl | bash` arrives. */
  readonly piped: string;
  readonly home: string;
  readonly tmp: string;
  environment(options?: RunOptions): Record<string, string>;
  run(options?: RunOptions): SpawnSyncReturns<string>;
  /**
   * The same run without blocking, so a signal can arrive while it is working - which is
   * the only way to see what a dropped SSH session does to an install.
   */
  runAsync(options?: RunOptions): {
    signal(name: NodeJS.Signals): void;
    done: Promise<{
      code: number | null;
      signal: string | null;
      output: string;
    }>;
  };
  git(...args: string[]): string;
  /** Everything the run called, in order. */
  calls(path?: string): string;
};

const IDENTITY = {
  GIT_AUTHOR_NAME: "iva",
  GIT_AUTHOR_EMAIL: "iva@example.invalid",
  GIT_COMMITTER_NAME: "iva",
  GIT_COMMITTER_EMAIL: "iva@example.invalid",
};

/**
 * The stand-ins are stateless — every path they touch comes from the environment — so one
 * copy serves every world. Written once because macOS verifies each newly created
 * executable the first time it runs, which is seconds per world otherwise.
 */
const TOOLS = realpathSync(mkdtempSync(join(tmpdir(), "iva-install-tools-")));
const RECORDER_PATH = join(TOOLS, "recorder");
writeFileSync(
  join(TOOLS, "uname"),
  '#!/bin/sh\nif [ "$1" = -m ]; then echo "${IVA_TEST_ARCH:-aarch64}"; else echo "${IVA_TEST_OS:-Linux}"; fi\n',
  { mode: 0o755 },
);
writeFileSync(
  join(TOOLS, "launchctl"),
  '#!/bin/sh\necho "launchctl $*" >> "$IVA_TEST_CALLS"\ncase "$1 $2" in "print gui/"*/app.iva.*) [ "${IVA_TEST_UNITS_ENABLED:-1}" = 1 ] || exit 113 ;; esac\n[ "${IVA_TEST_GUI:-1}" = 1 ] || exit 113\n',
  { mode: 0o755 },
);
writeFileSync(
  join(TOOLS, "systemctl"),
  '#!/bin/sh\necho "systemctl $*" >> "$IVA_TEST_CALLS"\nif [ "$2" = is-enabled ] && [ "${IVA_TEST_UNITS_ENABLED:-1}" != 1 ]; then echo "disabled: synthetic user bus unavailable" >&2; exit 1; fi\n',
  { mode: 0o755 },
);
writeFileSync(RECORDER_PATH, RECORDER);
chmodSync(RECORDER_PATH, 0o755);
// Everything the installer may reach for, stubbed by name. The package layer is here on
// purpose: on Ubuntu - the platform this script is written for - /usr/bin carries a real
// apt-get and a real dpkg, and a missing `gh` sends the installer to cli.github.com over
// the network. A test suite must not run either.
for (const name of [
  "loginctl",
  "uv",
  "dpkg",
  "gh",
  "python3",
  "ffmpeg",
  "pandoc",
  "pdftotext",
])
  symlinkSync(RECORDER_PATH, join(TOOLS, name));
writeFileSync(join(TOOLS, "sudo"), SUDO);
chmodSync(join(TOOLS, "sudo"), 0o755);
for (const name of ["apt-get", "dnf", "brew"]) {
  writeFileSync(join(TOOLS, name), PACKAGE_MANAGER);
  chmodSync(join(TOOLS, name), 0o755);
}
writeFileSync(join(TOOLS, "curl"), CURL);
chmodSync(join(TOOLS, "curl"), 0o755);
writeFileSync(join(TOOLS, "sha256sum"), SHA256SUM);
chmodSync(join(TOOLS, "sha256sum"), 0o755);
const COMMAND_MASK_PATH = join(TOOLS, "command-mask.sh");
writeFileSync(COMMAND_MASK_PATH, COMMAND_MASK);
writeFileSync(join(TOOLS, "npm"), NPM);
chmodSync(join(TOOLS, "npm"), 0o755);
// node comes in by name, not by its directory: on nvm and fnm the real node sits beside
// the developer's global binaries, and putting that directory on PATH is how a fixture
// ends up finding a real gws - or launching a real browser and downloading Chromium.
symlinkSync(process.execPath, join(TOOLS, "node"));
// git too: on macOS /usr/bin/git is an Xcode shim that exits 69 until the Xcode licence is
// accepted, so the fixture takes the git this test process itself runs.
symlinkSync(
  execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
  join(TOOLS, "git"),
);
after(() => rmSync(TOOLS, { recursive: true, force: true }));

/**
 * A whole installed Iva as the reported failure had it: a checkout at INSTALL_DIR with an
 * origin to fetch from and a HOME of its own. install.sh itself is the real file, and it
 * runs from inside the installation - `cd ~/iva && bash install.sh`, the command the
 * installer prints and docs/install.md promises. A copy sits outside too, for the runs that
 * have to arrive the way `curl | bash` does: over an installation the installer no longer
 * updates itself but hands to the updater.
 */
function createWorld(t: TestContext, options: { env?: boolean } = {}): World {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-install-shell-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const install = join(dir, "iva");
  const remote = join(dir, "remote.git");
  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  const npmPrefix = join(dir, "npm-global");
  const ghEtc = join(dir, "gh-etc");
  const defaultCalls = join(dir, "calls.log");

  for (const path of [
    home,
    tmp,
    npmPrefix,
    join(ghEtc, "keyrings"),
    join(ghEtc, "sources.list.d"),
  ])
    mkdirSync(path, { recursive: true });
  cpSync(join(ROOT, "install.sh"), join(dir, "install.sh"));

  mkdirSync(join(install, "bin"), { recursive: true });
  mkdirSync(join(install, "scripts/lib"), { recursive: true });
  mkdirSync(join(install, "packages/data-dir"), { recursive: true });
  writeFileSync(
    join(install, "package.json"),
    `${JSON.stringify(
      {
        name: "iva",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: { eve: "0.30.8" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(install, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "iva",
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "iva", version: "0.0.0" },
          "node_modules/eve": { version: "0.30.8" },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(install, "bin/iva.mjs"), IVA_CLI);
  writeFileSync(join(install, "scripts/init-vault.mjs"), "");
  for (const name of ["data-dir", "vault-dir"]) {
    mkdirSync(join(install, "packages", name), { recursive: true });
    cpSync(
      join(ROOT, "packages", name, "index.ts"),
      join(install, "packages", name, "index.ts"),
    );
  }
  for (const name of [
    "env-file.ts",
    "link-target.ts",
    "process-command.ts",
    "version-layout.ts",
    "version-store.ts",
  ])
    cpSync(join(ROOT, "scripts/lib", name), join(install, "scripts/lib", name));
  writeFileSync(join(install, "README.md"), "# fixture\n");
  // The installation carries the installer, as the repository does: it is the one a re-run
  // over it executes.
  cpSync(join(ROOT, "install.sh"), join(install, "install.sh"));
  // The shipped ignore rules, so what the installer leaves behind is judged by them.
  cpSync(join(ROOT, ".gitignore"), join(install, ".gitignore"));

  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: install,
      encoding: "utf8",
      env: { ...process.env, ...IDENTITY },
    }).trim();

  git("init", "--quiet", "--initial-branch=main");
  git("add", "-A");
  git("commit", "--quiet", "-m", "fixture");
  // A release is a vX.Y.Z tag: a new installation checks out the newest one.
  git("tag", "v1.0.0");
  // Use Git transport rather than racing a filesystem copy of loose objects.
  execFileSync("git", [
    "clone",
    "--quiet",
    "--no-local",
    "--bare",
    install,
    remote,
  ]);
  git("remote", "add", "origin", remote);

  if (options.env !== false) {
    writeFileSync(join(install, ".env"), "AGENT_LANGUAGE=en\nIVA_PORT=8723\n");
    writeFileSync(join(install, ".iva-installed"), "autostart configured\n");
  } else {
    // The clone stage finished; the first installer has not exited successfully yet.
    writeFileSync(join(install, ".iva-installing"), "pending\n");
  }

  const environment = (runOptions: RunOptions): Record<string, string> => ({
    ...IDENTITY,
    PATH: `${TOOLS}:/usr/bin:/bin:/usr/sbin`,
    HOME: home,
    TMPDIR: tmp,
    NO_COLOR: "1",
    TERM: "dumb",
    INSTALL_DIR: install,
    BRANCH: "main",
    REPO_URL: remote,
    IVA_TEST_CALLS: runOptions.calls ?? defaultCalls,
    IVA_TEST_NPM_PREFIX: npmPrefix,
    IVA_TEST_RECORDER: RECORDER_PATH,
    IVA_TEST_NODE: process.execPath,
    IVA_TEST_NODE_READY_MARKER: join(dir, "node-ready"),
    IVA_TEST_GH_ETC_DIR: ghEtc,
    IVA_TEST_GH_READY_AFTER_INSTALL: "",
    IVA_TEST_GH_READY_MARKER: join(dir, "gh-ready"),
    IVA_TEST_REPAIR_SH: join(ROOT, "repair.sh"),
    IVA_TEST_MISSING_COMMANDS: "",
    BASH_ENV: COMMAND_MASK_PATH,
    ...runOptions.env,
  });

  return {
    dir,
    install,
    piped: join(dir, "install.sh"),
    home,
    tmp,
    environment: (options = {}) => environment(options),
    git,
    calls: (path = defaultCalls) =>
      existsSync(path) ? readFileSync(path, "utf8") : "",
    run: (runOptions = {}) => {
      const installer = runOptions.script ?? join(install, "install.sh");
      const argv = runOptions.pipedStdin
        ? ["-s", "--", ...(runOptions.args ?? ["--non-interactive"])]
        : runOptions.closedStderr
          ? [
              "-c",
              'exec 2>&-; exec bash "$0" "$@"',
              installer,
              "--non-interactive",
            ]
          : [installer, ...(runOptions.args ?? ["--non-interactive"])];
      const shell = runOptions.ttyInput === undefined ? "bash" : PYTHON;
      const command =
        runOptions.ttyInput === undefined ? argv : ["-c", RUN_IN_TTY, ...argv];
      return spawnSync(shell, command, {
        cwd: dir,
        encoding: "utf8",
        env: environment(runOptions),
        input: runOptions.pipedStdin
          ? readFileSync(installer, "utf8")
          : runOptions.ttyInput,
      });
    },
    runAsync: (runOptions = {}) => {
      const child = spawn(
        "bash",
        [runOptions.script ?? join(install, "install.sh"), "--non-interactive"],
        { cwd: dir, env: environment(runOptions) },
      );
      let output = "";
      const collect = (chunk: unknown): void => {
        output += String(chunk);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      return {
        signal: (name) => {
          child.kill(name);
        },
        done: new Promise((resolve) =>
          child.on("close", (code, signal) =>
            resolve({ code, signal, output }),
          ),
        ),
      };
    },
  };
}

/** Temp files this run created; the install log is the one it means to leave. */
function leftovers(tmp: string): string[] {
  return readdirSync(tmp).filter((name) => !name.startsWith("iva-install-"));
}

function backups(install: string): string[] {
  const dir = join(install, "data/update-backups");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function outputBackups(install: string): string[] {
  return readdirSync(install).filter((name) =>
    name.startsWith(".output.iva-install-backup-"),
  );
}

function optionalGhWarnings(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .filter((line) => /^! .*?(?:GitHub CLI|\bgh\b)/u.test(line));
}

function ghAptFiles(world: World): { keyring: string; source: string } {
  return {
    keyring: join(world.dir, "gh-etc/keyrings/githubcli-archive-keyring.gpg"),
    source: join(world.dir, "gh-etc/sources.list.d/github-cli.list"),
  };
}

function assertNoSharedGhAptPaths(calls: string): void {
  assert.doesNotMatch(
    calls,
    /\/etc\/apt\/(?:keyrings\/githubcli-archive-keyring\.gpg|sources\.list\.d\/github-cli\.list)/u,
  );
}

function assertPrivateGhAptBoundary(world: World, calls: string): void {
  assertNoSharedGhAptPaths(calls);
  assert.deepEqual(
    readdirSync(world.tmp).filter((name) => name.startsWith("iva-gh-apt-")),
    [],
  );
}

void test("install.sh is valid bash", () => {
  execFileSync("bash", ["-n", join(ROOT, "install.sh")]);
});

const MINIMAL_ENV =
  "AGENT_LANGUAGE=en\nMODEL_PROVIDER=opencode\nOPENCODE_API_KEY=oc-key-123456\nOPENCODE_MODEL=deepseek-v4-pro\nTELEGRAM_BOT_TOKEN=123:tg-token\nTELEGRAM_ALLOWED_USER_IDS=11,22\nASSISTANT_TIMEZONE=Asia/Tashkent\n";

for (const os of ["Linux", "Darwin"]) {
  for (const current of ["linked", "broken"]) {
    void test(`${os}: versioned installation with disabled units and a ${current === "linked" ? "stale marker" : "broken current link"} goes to updater`, (t) => {
      const world = createWorld(t);
      const target = join(world.dir, "versioned");
      mkdirSync(join(target, "versions/0.5.4-test/bin"), { recursive: true });
      symlinkSync(
        current === "linked" ? "versions/0.5.4-test" : "missing-version",
        join(target, "current"),
      );
      cpSync(
        join(world.install, "bin/iva.mjs"),
        join(target, "versions/0.5.4-test/bin/iva.mjs"),
      );
      writeFileSync(join(target, ".env"), MINIMAL_ENV);
      writeFileSync(join(target, ".iva-installing"), "stale\n");
      const env = { IVA_TEST_OS: os, IVA_TEST_UNITS_ENABLED: "0" };
      const disabled = spawnSync(
        os === "Linux" ? "systemctl" : "launchctl",
        os === "Linux"
          ? ["--user", "is-enabled", "iva.service"]
          : ["print", "gui/501/app.iva.iva"],
        { env: world.environment({ env }), encoding: "utf8" },
      );
      assert.notEqual(
        disabled.status,
        0,
        "the service fixture must model disabled units",
      );
      const result = world.run({
        script: world.piped,
        calls: join(world.dir, "route.log"),
        env: {
          ...env,
          INSTALL_DIR: target,
          REPO_URL: "https://github.com/smixs/iva-agent.git",
        },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(world.calls(join(world.dir, "route.log")), /^iva update$/mu);
      assert.doesNotMatch(
        world.calls(join(world.dir, "route.log")),
        /is-enabled|app\.iva\./u,
      );
      assert.doesNotMatch(result.stderr, /synthetic user bus/u);
      assert.equal(existsSync(join(target, ".git")), false);
      assert.equal(existsSync(join(target, ".iva-installing")), false);
    });
  }
  void test(`${os}: completed checkout with disabled units goes to updater`, (t) => {
    const world = createWorld(t);
    // Legacy installations have neither marker; their checkout and .env identify them.
    rmSync(join(world.install, ".iva-installed"));
    const result = world.run({
      script: world.piped,
      env: {
        IVA_TEST_OS: os,
        IVA_TEST_UNITS_ENABLED: "0",
        REPO_URL: "https://github.com/smixs/iva-agent.git",
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(world.calls(), /^iva update$/mu);
    assert.doesNotMatch(result.stderr, /synthetic user bus/u);
  });
}

for (const kind of ["foreign", "unrecognized"]) {
  void test(`occupied ${kind} INSTALL_DIR is preserved and gets one actionable refusal`, (t) => {
    const world = createWorld(t);
    const target = join(world.dir, "occupied");
    mkdirSync(target);
    writeFileSync(join(target, ".env"), "PERSONAL=keep\n");
    writeFileSync(join(target, ".iva-installing"), "stale\n");
    if (kind === "foreign") {
      execFileSync("git", ["init", "-q", target]);
      writeFileSync(
        join(target, "package.json"),
        '{"name":"someone-else","scripts":{"install":"exit 77"}}\n',
      );
    }
    const before = readdirSync(target).sort();
    const result = world.run({
      script: world.piped,
      env: { INSTALL_DIR: target },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /INSTALL_DIR.*occupied.*ls -la/iu);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /fatal:|Continuing first installation/u,
    );
    assert.equal(readFileSync(join(target, ".env"), "utf8"), "PERSONAL=keep\n");
    assert.deepEqual(readdirSync(target).sort(), before);
    assert.equal(world.calls(), "");
  });
}

for (const os of ["Linux", "Darwin"]) {
  void test(`${os}: a deferred install resumes from the downloaded command and completes autostart`, (t) => {
    const world = fileSetupWorld(t);
    const first = world.run({ env: { IVA_TEST_OS: os } });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(existsSync(join(world.install, ".iva-installing")), false);
    assert.equal(
      readFileSync(join(world.install, ".iva-installed"), "utf8"),
      "autostart=false\n",
    );
    // The documented npm run setup step has saved the person's configuration.
    writeFileSync(join(world.install, ".env"), MINIMAL_ENV);
    const callsPath = join(world.dir, "resume.log");
    const second = world.run({
      script: world.piped,
      args: [],
      ttyInput: "1\n",
      calls: callsPath,
      env: {
        IVA_TEST_OS: os,
        REPO_URL: "https://github.com/smixs/iva-agent.git",
        NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/setup-wizard-fetch.ts")}`,
        IVA_TEST_DEFAULT_ANSWERS: "1",
      },
    });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const calls = world.calls(callsPath);
    assert.match(second.stdout, /Continuing first installation/u);
    assert.match(second.stdout, /Provider \(1\/2\/3\/4\/5\/6\)/u);
    assert.doesNotMatch(calls, /^iva update$|^npm ci$/mu);
    // Adding .env changes a build input; dependencies are still reusable.
    assert.match(calls, /^npm exec -- eve build$/mu);
    assert.match(calls, /^iva _install-units$/mu);
    assert.match(calls, /^iva _activate-units$/mu);
    if (os === "Linux") {
      const linger = calls.indexOf("loginctl enable-linger ");
      assert.ok(linger >= 0, calls);
      assert.ok(linger < calls.indexOf("iva _install-units"), calls);
    }
    assert.match(calls, /^curl -s --config - --data-urlencode chat_id=11 /mu);
    assert.match(second.stdout, /Sent you a confirmation in Telegram/u);
    assert.equal(
      readFileSync(join(world.install, ".iva-installed"), "utf8"),
      "autostart=true\n",
    );
    assert.equal(existsSync(join(world.install, ".iva-installing")), false);

    const thirdCalls = join(world.dir, "completed.log");
    const third = world.run({
      script: world.piped,
      calls: thirdCalls,
      env: {
        IVA_TEST_OS: os,
        REPO_URL: "https://github.com/smixs/iva-agent.git",
      },
    });
    assert.equal(third.status, 0, third.stdout + third.stderr);
    assert.match(world.calls(thirdCalls), /^iva update$/mu);
    assert.doesNotMatch(world.calls(thirdCalls), /iva _activate-units/u);
  });

  void test(`${os}: declined autostart resumes with the existing build`, (t) => {
    const world = createWorld(t);
    const first = world.run({
      args: ["--skip-setup"],
      ttyInput: "1\nn\n",
      env: { IVA_TEST_OS: os },
    });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(
      readFileSync(join(world.install, ".iva-installed"), "utf8"),
      "autostart=false\n",
    );
    const callsPath = join(world.dir, "resume.log");
    const second = world.run({
      script: world.piped,
      calls: callsPath,
      env: { IVA_TEST_OS: os },
    });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /Continuing first installation/u);
    assert.match(second.stdout, /Build is current/u);
    assert.doesNotMatch(
      world.calls(callsPath),
      /^iva update$|^npm ci$|eve build/mu,
    );
    assert.match(world.calls(callsPath), /^iva _activate-units$/mu);
    assert.equal(
      readFileSync(join(world.install, ".iva-installed"), "utf8"),
      "autostart=true\n",
    );
  });
}

void test("a completion marker overrides a stale first-install marker", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, ".iva-installed"), "autostart=true\n");
  writeFileSync(join(world.install, ".iva-installing"), "stale\n");
  const result = world.run({
    script: world.piped,
    env: {
      REPO_URL: "https://github.com/smixs/iva-agent.git",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(world.calls(), /^iva update$/mu);
  assert.doesNotMatch(world.calls(), /npm ci|iva _activate-units/u);
  assert.equal(existsSync(join(world.install, ".iva-installing")), false);
});

void test("an explicit configured checkout asks only whether to reconfigure", (t) => {
  const world = fileSetupWorld(t);
  writeFileSync(join(world.install, ".env"), MINIMAL_ENV);
  writeFileSync(join(world.install, ".iva-installed"), "complete\n");
  const result = world.run({
    args: [],
    ttyInput: "1\n",
    env: {
      NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/setup-wizard-fetch.ts")}`,
      IVA_TEST_DEFAULT_ANSWERS: "1",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Reconfigure from scratch\?/u);
  assert.doesNotMatch(result.stdout, /Provider \(1\/2\/3\/4\/5\/6\)/u);
});

void test("the installer takes Russian from the supplied env file", (t) => {
  const world = fileSetupWorld(t);
  const source = join(world.dir, "answers.env");
  writeFileSync(
    source,
    MINIMAL_ENV.replace("AGENT_LANGUAGE=en", "AGENT_LANGUAGE=ru"),
  );
  const result = world.run({
    args: ["--env-file", source],
    env: {
      NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/setup-wizard-fetch.ts")}`,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Установка завершена/u);
  assert.doesNotMatch(result.stdout, /Installation complete/u);
});

void test("--env-file alone asks no questions with a controlling terminal", (t) => {
  const world = fileSetupWorld(t);
  const source = join(world.dir, "answers.env");
  writeFileSync(source, MINIMAL_ENV);
  const result = world.run({
    args: ["--env-file", source],
    ttyInput: "1\n\n",
    env: {
      NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/setup-wizard-fetch.ts")}`,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(
    result.stdout,
    /Reconfigure from scratch\?|\[Y\/n\]|current\/default/u,
  );
  const complete = readFileSync(join(world.install, ".env"), "utf8");
  assert.match(complete, /^TELEGRAM_WEBHOOK_SECRET_TOKEN=[a-f0-9]{48}\r?$/mu);
  assert.match(world.calls(), /iva _activate-units/u);
});

void test("an unfinished checkout resumes first installation from the downloaded installer", (t) => {
  const world = fileSetupWorld(t);
  writeFileSync(join(world.install, ".env"), MINIMAL_ENV);
  const result = world.run({
    script: world.piped,
    args: [],
    ttyInput: "1\n",
    env: {
      NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/setup-wizard-fetch.ts")}`,
      IVA_TEST_DEFAULT_ANSWERS: "1",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Provider \(1\/2\/3\/4\/5\/6\)/u);
  assert.doesNotMatch(world.calls(), /^iva update$/mu);
  assert.match(world.calls(), /^iva _activate-units$/mu);
  assert.equal(existsSync(join(world.install, ".iva-installed")), true);
});

void test("deferred setup finishes explicitly through the first-install wizard", (t) => {
  const world = fileSetupWorld(t);
  const first = world.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(existsSync(join(world.install, ".iva-installed")), true);
  assert.equal(existsSync(join(world.install, ".iva-installing")), false);
  writeFileSync(join(world.install, ".env"), MINIMAL_ENV);
  const result = world.run({
    args: [],
    ttyInput: "1\n",
    calls: join(world.dir, "resume.log"),
    env: {
      NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/setup-wizard-fetch.ts")}`,
      IVA_TEST_DEFAULT_ANSWERS: "1",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls(join(world.dir, "resume.log"));
  assert.doesNotMatch(calls, /^iva update$|^npm ci$/mu);
  assert.match(calls, /^iva _activate-units$/mu);
  assert.doesNotMatch(result.stdout, /Reconfigure from scratch\?/u);
  assert.match(result.stdout, /Provider \(1\/2\/3\/4\/5\/6\)/u);
  assert.equal(
    readFileSync(join(world.install, ".iva-installed"), "utf8"),
    "autostart=true\n",
  );
});

void test("failed first activation resumes even when both legacy unit files exist", (t) => {
  const world = fileSetupWorld(t);
  const source = join(world.dir, "answers.env");
  writeFileSync(source, MINIMAL_ENV);
  const options = {
    script: world.piped,
    args: ["--env-file", source],
    env: {
      NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/setup-wizard-fetch.ts")}`,
    },
  };
  const failed = world.run({
    ...options,
    env: { ...options.env, IVA_TEST_UNITS_FAIL: "1" },
  });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.equal(existsSync(join(world.install, ".iva-installed")), false);
  const units = join(world.home, ".config/systemd/user");
  mkdirSync(units, { recursive: true });
  for (const unit of ["iva.service", "iva-telegram-poll.service"])
    writeFileSync(join(units, unit), "written before activation failed\n");
  const resumed = world.run(options);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(existsSync(join(world.install, ".iva-installed")), true);
  assert.equal(existsSync(join(world.install, ".iva-installing")), false);
  assert.doesNotMatch(world.calls(), /^iva update$/mu);
});

const DROP_SETUP_TTY = `import os,pty,select,signal,sys,time
mode, installer = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp('bash', ['bash', installer])
output = b''
dropped = False
deadline = time.monotonic() + 12
try:
    while True:
        if fd >= 0 and select.select([fd], [], [], 0.05)[0]:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            output += data
            if b'current/default' in output and b'LANG_SENT' not in output:
                os.write(fd, b'1\\n')
                output += b'LANG_SENT'
            if (b'Reconfigure from scratch?' in output or b'Provider (1/2/3/4/5/6)' in output) and not dropped:
                dropped = True
                deadline = time.monotonic() + 2
                if mode == 'signal':
                    os.kill(pid, signal.SIGHUP)
                else:
                    os.close(fd)
                    fd = -1
        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished:
            if not dropped:
                sys.stdout.buffer.write(output)
            sys.exit(0 if dropped and os.waitstatus_to_exitcode(status) != 0 else 97)
        if time.monotonic() > deadline:
            sys.stdout.buffer.write(output)
            sys.exit(98)
finally:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if fd >= 0:
        os.close(fd)
`;

void test("setup EOF fails instead of leaving an unfinished configuration successful", async (t) => {
  const world = fileSetupWorld(t);
  const input = join(world.dir, "answers.env");
  const output = join(world.dir, "candidate.env");
  writeFileSync(input, MINIMAL_ENV);
  const child = spawn(
    process.execPath,
    [join(world.install, "scripts/setup.mjs")],
    {
      detached: true,
      cwd: world.install,
      env: world.environment({
        env: {
          IVA_CONFIG_INPUT: input,
          IVA_CONFIG_OUTPUT: output,
          AGENT_LANGUAGE: "en",
          NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/setup-wizard-fetch.ts")}`,
        },
      }),
    },
  );
  let transcript = "";
  child.stdout.on("data", (data: Buffer) => {
    transcript += data.toString();
    if (transcript.includes("Reconfigure from scratch?")) child.stdin.end();
  });
  child.stderr.on("data", (data: Buffer) => {
    transcript += data.toString();
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const code = await new Promise<number | null>((done) =>
    child.once("close", done),
  );
  clearTimeout(timer);
  assert.match(transcript, /Reconfigure from scratch/u);
  assert.equal(code, 1, transcript);
  assert.equal(existsSync(output), false);
});

for (const mode of ["signal", "terminal"]) {
  void test(`a lost setup ${mode} stops promptly and releases the installer lock`, (t) => {
    const world = fileSetupWorld(t);
    writeFileSync(join(world.install, ".env"), MINIMAL_ENV);
    const result = spawnSync(
      PYTHON,
      ["-c", DROP_SETUP_TTY, mode, join(world.install, "install.sh")],
      {
        cwd: world.dir,
        encoding: "utf8",
        env: world.environment({
          calls: join(world.dir, "drop.log"),
          env: {
            NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/setup-wizard-fetch.ts")}`,
          },
        }),
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(join(world.install, "data/install.lock")), false);
    assert.equal(existsSync(join(world.install, ".iva-installed")), false);
    assert.doesNotMatch(
      world.calls(join(world.dir, "drop.log")),
      /iva _activate-units/u,
    );
  });
}

function fileSetupWorld(t: TestContext): World {
  const world = createWorld(t, { env: false });
  // Run the real setup against synthetic HTTP, inside the installer's isolated tree.
  cpSync(join(ROOT, "scripts/setup"), join(world.install, "scripts/setup"), {
    recursive: true,
  });
  cpSync(join(ROOT, "scripts/lib"), join(world.install, "scripts/lib"), {
    recursive: true,
  });
  cpSync(
    join(ROOT, "scripts/setup.mjs"),
    join(world.install, "scripts/setup.mjs"),
  );
  cpSync(join(ROOT, "packages"), join(world.install, "packages"), {
    recursive: true,
  });
  mkdirSync(join(world.install, "node_modules"));
  for (const entry of readdirSync(join(ROOT, "node_modules"))) {
    if (!entry.startsWith("."))
      symlinkSync(
        join(ROOT, "node_modules", entry),
        join(world.install, "node_modules", entry),
      );
  }
  return world;
}

void test("--env-file completes minimal answers through setup before activating units", (t) => {
  const world = fileSetupWorld(t);
  const source = join(world.dir, "answers.env");
  writeFileSync(source, MINIMAL_ENV, { mode: 0o644 });
  const result = world.run({
    args: ["--non-interactive", "--env-file", source],
    env: {
      NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/setup-wizard-fetch.ts")}`,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const complete = readFileSync(join(world.install, ".env"), "utf8");
  assert.match(complete, /^ASSISTANT_BEARER=[A-Za-z0-9_-]{43}$/mu);
  assert.match(complete, /^TELEGRAM_WEBHOOK_SECRET_TOKEN=[a-f0-9]{48}$/mu);
  assert.match(complete, /^TELEGRAM_BOT_USERNAME=ivabot$/mu);
  const port = /^IVA_PORT=(\d+)$/mu.exec(complete)?.[1];
  assert.ok(port);
  assert.ok(Number(port) >= 1 && Number(port) <= 65535);
  assert.ok(complete.includes(`ASSISTANT_HOST=http://127.0.0.1:${port}\n`));
  for (const value of [
    "ASSISTANT_VAULT_DIR=vault",
    "ASSISTANT_DATA_DIR=data",
    "IVA_PORT=",
    "ASSISTANT_HOST=http://127.0.0.1:",
    "TELEGRAM_DIGEST_CHAT_ID=11",
    "ASSISTANT_TIMEZONE=Asia/Tashkent",
    "OPENCODE_CONTEXT_WINDOW=131072",
  ])
    assert.ok(complete.includes(value), value);
  assert.equal(statSync(join(world.install, ".env")).mode & 0o777, 0o600);
  assert.equal(readFileSync(source, "utf8"), MINIMAL_ENV);
  assert.match(world.calls(), /iva _install-units/u);
  assert.match(world.calls(), /iva _activate-units/u);
  assert.doesNotMatch(
    result.stdout + result.stderr + world.calls(),
    /oc-key-123456|123:tg-token/u,
  );
  assert.doesNotMatch(result.stdout, /Configure the keys first/u);
  assert.match(result.stdout, /Done — everything written to \.env/u);
  assert.doesNotMatch(result.stdout, /Ready — settings validated for apply/u);
});

for (const fault of ["provider", "telegram"]) {
  void test(`--env-file rejects invalid ${fault} credentials before writing units`, (t) => {
    const world = fileSetupWorld(t);
    const source = join(world.dir, "answers.env");
    writeFileSync(source, MINIMAL_ENV);
    const result = world.run({
      args: ["--non-interactive", "--env-file", source],
      env: {
        NODE_OPTIONS: `--import=${join(ROOT, "scripts/fixtures/setup-wizard-fetch.ts")}`,
        IVA_TEST_SETUP_FAULT: fault,
      },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stdout + result.stderr,
      fault === "provider"
        ? /OpenCode.*(?:key|credentials|ключ)/iu
        : /Telegram.*(?:token|токен)/iu,
    );
    assert.doesNotMatch(world.calls(), /iva _(?:install|activate)-units/u);
    assert.equal(existsSync(join(world.install, ".env")), false);
  });
}

void test("--env-file refuses configured installations and missing input before changes", (t) => {
  const world = createWorld(t);
  const original = readFileSync(join(world.install, ".env"), "utf8");
  const source = join(world.dir, "answers.env");
  writeFileSync(source, MINIMAL_ENV);
  const existing = world.run({ args: ["--env-file", source] });
  assert.equal(existing.status, 1);
  assert.match(
    existing.stdout + existing.stderr,
    /--env-file.*first install/iu,
  );
  assert.equal(readFileSync(join(world.install, ".env"), "utf8"), original);
  assert.equal(world.calls(), "");
  const absent = world.run({ args: ["--env-file"] });
  assert.equal(absent.status, 1);
  assert.match(absent.stdout + absent.stderr, /--env-file.*file/iu);
});

for (const os of ["Linux", "Darwin"]) {
  for (const configured of [false, true]) {
    void test(`${os}: ${configured ? "declined autostart" : "unconfigured installation"} omits bot readiness and status hints`, (t) => {
      const world = createWorld(t, { env: configured });
      const result = world.run({
        env: { IVA_TEST_OS: os },
        ...(configured ? { args: ["--skip-setup"], ttyInput: "1\nn\n" } : {}),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      if (configured) assert.match(result.stdout, /\[Y\/n\]/u);
      else assert.match(result.stdout, /Configure the keys first/u);
      const summary = result.stdout.slice(
        result.stdout.lastIndexOf("Installation complete"),
      );
      assert.doesNotMatch(
        summary,
        /✅ The bot is ready|✅ Бот готов|Bot status:|Bot logs:|iva-telegram-poll/u,
      );
      assert.doesNotMatch(summary, /^ {4}iva (?:status|logs -f)\r?$/mu);
      assert.doesNotMatch(world.calls(), /iva _(?:install|activate)-units/u);
    });
  }
  void test(`${os}: enabled autostart retains bot readiness and status hints`, (t) => {
    const world = createWorld(t);
    const result = world.run({ env: { IVA_TEST_OS: os } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const summary = result.stdout.slice(
      result.stdout.lastIndexOf("Installation complete"),
    );
    assert.match(summary, /✅ The bot is ready/u);
    if (os === "Darwin") {
      assert.match(summary, /^ {4}iva status\r?$/mu);
      assert.match(summary, /^ {4}iva logs -f\r?$/mu);
    } else {
      assert.match(summary, /Bot status:.*iva-telegram-poll/u);
      assert.match(summary, /Bot logs:.*iva-telegram-poll/u);
    }
  });
}

void test("headless sudo refusal names root bootstrap before optional package work", (t) => {
  const world = createWorld(t, { env: false });
  const result = world.run({
    env: { IVA_TEST_SUDO_PASSWORD: "1", IVA_TEST_MISSING_COMMANDS: "gh" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout + result.stderr,
    /sudo.*(?:terminal|TTY).*bootstrap\.sh.*root/iu,
  );
  assert.match(world.calls(), /sudo -n/u);
  assert.doesNotMatch(world.calls(), /sudo -v/u);
  assert.match(world.calls(), /agent-browser install\n/u);
  assert.doesNotMatch(world.calls(), /agent-browser install --with-deps/u);
});

void test("all downloaded installers and packages use exact pinned artifacts", () => {
  const source = readFileSync(join(ROOT, "install.sh"), "utf8");
  for (const artifact of Object.values(PINNED_ARTIFACTS)) {
    assert.match(
      source,
      new RegExp(artifact.url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
    assert.match(source, new RegExp(`\\b${artifact.sha256}\\b`, "u"));
  }
  assert.doesNotMatch(source, /npm i -g agent-browser(?:\s|$)/u);
  assert.doesNotMatch(source, /npm i -g @googleworkspace\/cli@latest(?:\s|$)/u);
  assert.doesNotMatch(source, /https:\/\/astral\.sh\/uv\/install\.sh/u);
});

void test("matching uv and nvm downloads execute only after SHA-256 verification", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: { IVA_TEST_MISSING_COMMANDS: "uv node" },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  for (const artifact of [PINNED_ARTIFACTS.uv, PINNED_ARTIFACTS.nvm]) {
    assert.match(
      calls,
      new RegExp(artifact.url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
  const uvHash = calls.indexOf("sha256sum ", calls.indexOf("iva-uv-"));
  const uvExec = calls.indexOf("execute uv installer");
  const nvmHash = calls.indexOf("sha256sum ", calls.indexOf("iva-nvm-"));
  const nvmExec = calls.indexOf("execute nvm installer");
  assert.ok(uvHash >= 0 && uvExec > uvHash, calls);
  assert.ok(nvmHash > uvHash && nvmExec > nvmHash, calls);
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("a missing SHA-256 tool stops before executing a download", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: { IVA_TEST_MISSING_COMMANDS: "uv sha256sum shasum" },
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /SHA-256/iu);
  assert.doesNotMatch(world.calls(), /execute uv installer/u);
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("a failed artifact download leaves no verified-download temp file", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_FAIL_ARTIFACT_DOWNLOAD: "uv",
      IVA_TEST_MISSING_COMMANDS: "uv",
    },
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(world.calls(), /sha256sum|execute uv installer/u);
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("a verified installer failure leaves no downloaded script", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_FAIL_ARTIFACT_EXECUTE: "uv",
      IVA_TEST_MISSING_COMMANDS: "uv",
    },
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(world.calls(), /sha256sum[\s\S]*execute uv installer/u);
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("a verified npm install failure leaves no downloaded tarball", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: { IVA_TEST_FAIL_VERIFIED_NPM: "agent-browser" },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout + result.stderr,
    /couldn't install agent-browser/u,
  );
  assert.match(world.calls(), /^npm i -g .*iva-agent-browser-/mu);
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("npm is handed the tarball itself, and the download outlives nothing", (t) => {
  const world = createWorld(t);
  const result = world.run();

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  // npm takes a local path without a tarball extension for a package directory and opens
  // <path>/package.json in it, which is ENOTDIR when the path is the downloaded file.
  for (const [label, artifact] of [
    ["agent-browser", PINNED_ARTIFACTS.agentBrowser],
    ["gws", PINNED_ARTIFACTS.gws],
  ] as const) {
    const file = artifact.url.slice(artifact.url.lastIndexOf("/") + 1);
    assert.ok(file.endsWith(".tgz"), artifact.url);
    assert.match(
      calls,
      new RegExp(
        `^verified tarball file .*/iva-${label}-[^/\\s]+/${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
        "mu",
      ),
    );
  }
  assert.deepEqual(leftovers(world.tmp), []);
});

for (const scenario of [
  {
    name: "uv",
    missing: "uv",
    url: PINNED_ARTIFACTS.uv.url,
    forbidden: /execute uv installer/u,
  },
  {
    name: "nvm",
    missing: "node",
    url: PINNED_ARTIFACTS.nvm.url,
    forbidden: /execute nvm installer/u,
  },
  {
    name: "agent-browser",
    missing: "",
    url: PINNED_ARTIFACTS.agentBrowser.url,
    forbidden: /^npm i -g .*iva-agent-browser-/mu,
  },
  {
    name: "gws",
    missing: "",
    url: PINNED_ARTIFACTS.gws.url,
    forbidden: /^npm i -g .*iva-gws-/mu,
  },
] as const) {
  void test(`${scenario.name} checksum mismatch stops before execution or install`, (t) => {
    const world = createWorld(t);
    const result = world.run({
      env: {
        IVA_TEST_CORRUPT_ARTIFACT: scenario.name,
        IVA_TEST_MISSING_COMMANDS: scenario.missing,
      },
    });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /SHA-256|checksum/iu);
    const calls = world.calls();
    assert.match(
      calls,
      new RegExp(scenario.url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
    assert.match(calls, /sha256sum/u);
    assert.doesNotMatch(calls, scenario.forbidden);
    assert.doesNotMatch(result.stdout, /Installation complete/u);
    assert.deepEqual(leftovers(world.tmp), []);
  });
}

void test("optional GitHub CLI repository failure does not stop required apt work", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_FAIL_GH_REPOSITORY: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  const requiredInstall = calls
    .split("\n")
    .find(
      (line) =>
        line.includes("apt-get") &&
        line.includes("install") &&
        line.includes("pandoc"),
    );
  assert.ok(requiredInstall, `required package was not attempted:\n${calls}`);
  assert.doesNotMatch(requiredInstall, /(?:^| )gh(?: |$)/u);
  assert.match(calls, /^npm ci$/mu);
  assert.match(calls, /^iva _activate-units$/mu);
  assert.match(result.stdout, /Installation complete/u);
  assertPrivateGhAptBoundary(world, calls);
  const managed = ghAptFiles(world);
  assert.equal(existsSync(managed.keyring), false);
  assert.equal(existsSync(managed.source), false);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
    "! GitHub CLI is optional and could not be installed; continuing without it",
  ]);
});

void test("optional GitHub CLI apt package failure warns once and installation completes", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_FAIL_GH_PACKAGE: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  const requiredInstall = calls
    .split("\n")
    .find(
      (line) =>
        line.includes("apt-get") &&
        line.includes("install") &&
        line.includes("pandoc"),
    );
  assert.ok(requiredInstall, `required package was not attempted:\n${calls}`);
  assert.doesNotMatch(requiredInstall, /(?:^| )gh(?: |$)/u);
  assert.match(calls, /^iva _activate-units$/mu);
  assert.match(result.stdout, /Installation complete/u);
  assert.match(calls, /Dir::Etc::sourcelist=.*iva-gh-apt-/u);
  assert.match(calls, /Dir::Etc::sourceparts=-/u);
  assert.match(calls, /Dir::State::lists=.*iva-gh-apt-/u);
  assertPrivateGhAptBoundary(world, calls);
  const managed = ghAptFiles(world);
  assert.equal(existsSync(managed.keyring), false);
  assert.equal(existsSync(managed.source), false);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
    "! GitHub CLI is optional and could not be installed; continuing without it",
  ]);
});

void test("optional GitHub CLI availability wins over a package-manager failure", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_FAIL_GH_PACKAGE: "1",
      IVA_TEST_GH_READY_AFTER_INSTALL: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  assert.match(calls, /^iva _activate-units$/mu);
  assert.match(result.stdout, /Installation complete/u);
  assert.match(result.stdout, /^✓ gh ready$/mu);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), []);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /GitHub CLI is optional and could not be installed/u,
  );
  assertPrivateGhAptBoundary(world, calls);
});

void test("optional GitHub CLI retries a transient private cleanup failure", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_GH_READY_AFTER_INSTALL: "1",
      IVA_TEST_FAIL_GH_CLEANUP_ONCE: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  assert.equal(
    calls
      .split("\n")
      .filter((line) => /sudo -n rm -rf -- .*\/iva-gh-apt-/u.test(line)).length,
    2,
  );
  assertPrivateGhAptBoundary(world, calls);
  assert.match(calls, /^iva _activate-units$/mu);
  assert.match(result.stdout, /Installation complete/u);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), []);
});

void test("optional GitHub CLI reports a persistent private cleanup failure", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_GH_READY_AFTER_INSTALL: "1",
      IVA_TEST_FAIL_GH_CLEANUP_ALWAYS: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  assert.equal(
    calls
      .split("\n")
      .filter((line) => /sudo -n rm -rf -- .*\/iva-gh-apt-/u.test(line)).length,
    2,
  );
  assertNoSharedGhAptPaths(calls);
  const retained = readdirSync(world.tmp).filter((name) =>
    name.startsWith("iva-gh-apt-"),
  );
  assert.equal(retained.length, 1);
  assert.match(calls, /^iva _activate-units$/mu);
  assert.match(result.stdout, /Installation complete/u);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
    `! GitHub CLI is ready, but private apt cleanup failed; retained directory: ${join(world.tmp, retained[0])}`,
  ]);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /GitHub CLI is optional and could not be installed/u,
  );
});

void test("optional GitHub CLI apt failure preserves foreign repository files exactly", (t) => {
  const world = createWorld(t);
  const managed = ghAptFiles(world);
  writeFileSync(managed.keyring, "foreign keyring bytes\n");
  writeFileSync(managed.source, "foreign source bytes\n");
  chmodSync(managed.keyring, 0o600);
  chmodSync(managed.source, 0o640);

  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_FAIL_GH_PACKAGE: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    readFileSync(managed.keyring, "utf8"),
    "foreign keyring bytes\n",
  );
  assert.equal(readFileSync(managed.source, "utf8"), "foreign source bytes\n");
  assert.equal(statSync(managed.keyring).mode & 0o777, 0o600);
  assert.equal(statSync(managed.source).mode & 0o777, 0o640);
  const calls = world.calls();
  assert.match(calls, /^iva _activate-units$/mu);
  assertPrivateGhAptBoundary(world, calls);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
    "! GitHub CLI is optional and could not be installed; continuing without it",
  ]);
});

for (const replacementKind of ["keyring", "source"] as const) {
  void test(`optional GitHub CLI private apt failure preserves a foreign ${replacementKind} replacement`, (t) => {
    const world = createWorld(t);
    const result = world.run({
      env: {
        IVA_TEST_MISSING_COMMANDS: "gh pandoc",
        IVA_TEST_FAIL_GH_PACKAGE: "1",
        IVA_TEST_REPLACE_GH_PATH: replacementKind,
      },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    const managed = ghAptFiles(world);
    const replaced = managed[replacementKind];
    const owned =
      replacementKind === "keyring" ? managed.source : managed.keyring;
    assert.equal(
      readFileSync(replaced, "utf8"),
      `FOREIGN_${replacementKind.toUpperCase()}_PRESENT\n`,
    );
    assert.equal(statSync(replaced).mode & 0o777, 0o640);
    assert.equal(existsSync(owned), false);
    const calls = world.calls();
    assert.ok(
      calls
        .split("\n")
        .some(
          (line) =>
            line.includes("apt-get") &&
            line.includes("install") &&
            line.includes("pandoc"),
        ),
      `required package was not attempted:\n${calls}`,
    );
    assert.match(calls, /^iva _activate-units$/mu);
    assert.match(result.stdout, /Installation complete/u);
    assert.match(calls, /Dir::Etc::sourcelist=.*iva-gh-apt-/u);
    assertPrivateGhAptBoundary(world, calls);
    assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
      "! GitHub CLI is optional and could not be installed; continuing without it",
    ]);
  });
}

for (const manager of ["dnf", "brew"] as const) {
  void test(`optional GitHub CLI package failure is isolated under ${manager}`, (t) => {
    const world = createWorld(t);
    const hidden =
      manager === "dnf" ? "apt-get gh pandoc" : "apt-get dnf gh pandoc";
    const result = world.run({
      env: {
        IVA_TEST_MISSING_COMMANDS: hidden,
        IVA_TEST_FAIL_GH_PACKAGE: "1",
      },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = world.calls();
    const requiredInstall = calls
      .split("\n")
      .find(
        (line) =>
          line.includes(`${manager} install `) && line.includes("pandoc"),
      );
    assert.ok(requiredInstall, `required package was not attempted:\n${calls}`);
    assert.doesNotMatch(requiredInstall, /(?:^| )gh(?: |$)/u);
    assert.match(calls, /^npm ci$/mu);
    assert.match(calls, /^iva _activate-units$/mu);
    assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
      "! GitHub CLI is optional and could not be installed; continuing without it",
    ]);
  });
}

void test("an exit before any work is done stays quiet and succeeds", () => {
  // --help is the earliest exit there is, and it runs the same exit handler every failure
  // runs: everything it touches has to exist by then.
  const help = spawnSync("bash", [join(ROOT, "install.sh"), "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
  });
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /--skip-setup/u);
  assert.match(help.stdout, /--env-file/u);
  assert.match(help.stdout, /-h, --help\s+show this help/u);
});

void test("a stage killed mid-way fails the install and gives the old build back", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  // 137: what the OOM killer leaves on a 512MB VPS, the failure this installer exists for.
  const result = world.run({ env: { IVA_TEST_BUILD_EXIT: "137" } });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Installation complete/u);
  assert.match(result.stderr, /Install stopped during/u);
  // The previous build is back where it was, not deleted as if the install had worked.
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
  );
  assert.deepEqual(outputBackups(world.install), []);
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.deepEqual(leftovers(world.tmp), []);
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  // The units were never touched: the run stopped at the build.
  assert.doesNotMatch(world.calls(), /iva _install-units/u);
});

void test("a build that could not be put back is kept and named", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root writes into a read-only directory, so nothing fails here");
    return;
  }
  const world = createWorld(t);
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  // The tree stops accepting writes after the build has already replaced .output, so the
  // rollback cannot move the backup back into place.
  const result = world.run({
    env: { IVA_TEST_UNITS_FAIL: "1", IVA_TEST_FREEZE_TREE: "1" },
  });
  chmodSync(world.install, 0o700);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  const said = result.stdout + result.stderr;
  // The only copy of the previous build is that backup: removing it because the run is
  // over would destroy it, so it stays and the user is told where.
  const kept = outputBackups(world.install);
  assert.equal(kept.length, 1, `the backup was removed: ${said}`);
  assert.equal(
    readFileSync(join(world.install, kept[0], "marker"), "utf8"),
    "previous build\n",
  );
  assert.match(said, /previous build is kept at/u);
  assert.match(said, new RegExp(kept[0], "u"));
});

void test("a log that stops being writable does not stop the undo", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root writes into a read-only directory, so nothing fails here");
    return;
  }
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  // Every command of the rollback redirects into the install log. With the log gone, a
  // redirect fails before its command runs - and the undo would be skipped in silence.
  const result = world.run({
    env: { IVA_TEST_FREEZE_LOG: "1", IVA_TEST_BUILD_EXIT: "137" },
  });
  for (const name of readdirSync(world.tmp))
    chmodSync(join(world.tmp, name), 0o600);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
    "the previous build was not restored once the log went away",
  );
  assert.deepEqual(outputBackups(world.install), []);
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
});

void test("a terminal that went away does not take the undo with it", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  // No stderr at all, which is what a dropped session leaves behind: the first thing the
  // exit handler does is say where it stopped, and that write fails. Under errexit that
  // ends the handler before it restores anything - and rewrites the exit code on the way.
  const result = world.run({
    closedStderr: true,
    env: { IVA_TEST_BUILD_EXIT: "137" },
  });

  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
    "the undo stopped at the line it could not print",
  );
  assert.deepEqual(outputBackups(world.install), []);
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  // The code the build died with, not one invented by a handler that fell over.
  assert.equal(result.status, 137);
});

void test("a failure is reported once, with the stage that failed", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");

  const result = world.run({ env: { IVA_TEST_UNITS_FAIL: "1" } });

  assert.notEqual(result.status, 0);
  const said = result.stdout + result.stderr;
  // The rollback runs commands that fail as a matter of course - `git rebase --abort`
  // with no rebase in progress is the usual one - and `set +e` does not disarm the ERR
  // trap. Left armed, each of them printed an "Install aborted (code 128)" over the real
  // reason, which is how the cause of a failure gets lost.
  assert.deepEqual(
    said.match(/Install aborted[^\n]*/gu) ?? [],
    [],
    `the rollback reported failures of its own:\n${said}`,
  );
  // The real reason is stated once, and the stage is named.
  assert.equal(
    (said.match(/couldn't enable and start the systemd units/gu) ?? []).length,
    1,
  );
  assert.equal(
    (said.match(/Install stopped during: systemd units/gu) ?? []).length,
    1,
  );
});

void test("an unwritable temporary directory stops the install before it starts", (t) => {
  const world = createWorld(t);
  const blocked = join(world.dir, "blocked-tmp");
  mkdirSync(blocked, { recursive: true });
  chmodSync(blocked, 0o500);

  const result = world.run({ env: { TMPDIR: `${blocked}/` } });
  chmodSync(blocked, 0o700);

  // Every step of the undo redirects into that log. Failing here, before anything has been
  // touched, beats a rollback that silently does nothing later.
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /install log/iu);
  assert.match(result.stderr, /TMPDIR/u);
  assert.doesNotMatch(world.calls(), /npm ci/u);
});

void test("a second installer in the same checkout is refused, a dead one is not", (t) => {
  const world = createWorld(t);
  const lock = join(world.install, "data/install.lock");
  mkdirSync(lock, { recursive: true });
  // A live owner: this test process itself.
  writeFileSync(join(lock, "pid"), `${process.pid}\n`);

  const refused = world.run();
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, new RegExp(`pid ${process.pid}`, "u"));
  assert.match(refused.stderr, new RegExp(`kill -TERM ${process.pid}`, "u"));
  // The path is part of the answer: a pid the system has since reused is a dead end
  // without it.
  assert.match(refused.stderr, /data\/install\.lock/u);
  assert.doesNotMatch(world.calls(), /npm ci/u);
  // A refused run touches nothing at all.
  assert.equal(world.git("stash", "list"), "");
  assert.deepEqual(backups(world.install), []);

  // A lock with no owner written into it yet belongs to an installer that is a moment from
  // writing one - taking it over would run two of them at once.
  rmSync(join(lock, "pid"));
  const starting = world.run();
  assert.notEqual(starting.status, 0, starting.stdout + starting.stderr);
  assert.match(starting.stderr, /starting/u);

  // The same lock left by a run that really is gone is taken over, not honoured forever.
  const dead = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(dead.status, 0);
  writeFileSync(join(lock, "pid"), `${dead.pid}\n`);
  const taken = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(taken.status, 0, taken.stdout + taken.stderr);
  assert.equal(
    existsSync(lock),
    false,
    "the lock outlived the run that took it",
  );
});

void test("installer ownership files follow the canonical custom data directory", async (t) => {
  const world = createWorld(t);
  writeFileSync(
    join(world.install, ".env"),
    "AGENT_LANGUAGE=en\nASSISTANT_DATA_DIR= state/../runtime \n",
  );
  const dataDir = join(world.install, "runtime");
  const lock = join(dataDir, "install.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), `${process.pid}\n`);

  const refused = world.run();
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /runtime\/install\.lock/u);
  assert.equal(existsSync(join(world.install, "data/install.lock")), false);

  rmSync(lock, { recursive: true, force: true });
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  const waiting = join(world.dir, "custom-data-building");
  const run = world.runAsync({ env: { IVA_TEST_BUILD_WAIT: waiting } });
  for (let waited = 0; !existsSync(waiting) && waited < 20000; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(waiting), "the run never reached the build");
  assert.equal(existsSync(lock), true);
  assert.match(
    readdirSync(join(dataDir, "update-backups")).join("\n"),
    /^\.env-/mu,
  );
  assert.equal(existsSync(join(world.install, "data/update-backups")), false);

  run.signal("SIGHUP");
  const result = await run.done;
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(lock), false);
});

void test("the fallback copy of .env is private from the first byte", (t) => {
  const world = createWorld(t);
  // data/ cannot be written, so the copy has to go to TMPDIR - the path that used to
  // inherit 0644 from a world-readable .env through `cp -p`.
  chmodSync(join(world.install, ".env"), 0o644);
  mkdirSync(join(world.install, "data"), { recursive: true });
  chmodSync(join(world.install, "data"), 0o500);
  const snapshot = join(world.dir, "snapshot.json");

  const result = world.run({ env: { IVA_TEST_SNAPSHOT: snapshot } });
  chmodSync(join(world.install, "data"), 0o700);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const live = JSON.parse(readFileSync(snapshot, "utf8")) as {
    tmp: { name: string; mode: string }[];
  };
  const copy = live.tmp.filter((entry) => entry.name.startsWith("iva-env."));
  assert.equal(copy.length, 1, JSON.stringify(live.tmp));
  assert.equal(copy[0].mode, "600");
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("an unreadable untracked file rebuilds instead of answering blind", (t) => {
  const world = createWorld(t);
  // A source file of the user's own, and a symlink with nothing behind it. git cannot hash
  // the symlink and the hashing stops there, so everything after it - the source file
  // included - drops out of the answer while its name stays in the file list.
  writeFileSync(join(world.install, "extra.ts"), "export const version = 1;\n");
  symlinkSync(
    join(world.dir, "nothing-here"),
    join(world.install, "dangling.ts"),
  );
  assert.equal(world.run().status, 0);

  // Only contents change now: the set of paths is exactly the one the first run saw.
  writeFileSync(join(world.install, "extra.ts"), "export const version = 2;\n");

  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(
    world.calls(join(world.dir, "second.log")),
    /eve build/u,
    "the changed source was not rebuilt",
  );
});

void test("a dropped connection rolls the install back like any other failure", async (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  const waiting = join(world.dir, "building");
  const run = world.runAsync({ env: { IVA_TEST_BUILD_WAIT: waiting } });
  // Hang up the moment the run is provably inside the build, past the point where it has
  // moved the old output aside and written down everything it has to put back.
  for (let waited = 0; !existsSync(waiting) && waited < 20000; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(waiting), "the run never reached the build");
  run.signal("SIGHUP");
  const result = await run.done;

  assert.notEqual(result.code, 0);
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
  );
  assert.deepEqual(outputBackups(world.install), []);
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
});

void test("the copy of .env lives beside the installation, never in /tmp", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  const snapshot = join(world.dir, "snapshot.json");

  const result = world.run({ env: { IVA_TEST_SNAPSHOT: snapshot } });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  // Taken while the install was still running, so it is the live state, not the leftovers.
  const live = JSON.parse(readFileSync(snapshot, "utf8")) as {
    backupsMode: string;
    backups: { name: string; mode: string }[];
    tmp: { name: string; mode: string }[];
  };
  const envCopy = live.backups.filter((entry) => entry.name.startsWith(".env"));
  assert.equal(envCopy.length, 1, JSON.stringify(live.backups));
  assert.equal(envCopy[0].mode, "600");
  assert.equal(live.backupsMode, "700");
  // The only thing this run may leave in a world-readable directory is its log.
  assert.deepEqual(
    live.tmp.filter((entry) => !entry.name.startsWith("iva-install-")),
    [],
  );
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );
});

void test("a failure while preserving the checkout keeps the files it was preserving", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can read a file with no permissions, so nothing fails here");
    return;
  }
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");
  // The copy of .env is the first thing a run saves, and it cannot be made: the failure
  // lands before anything else has been written down, while the user's files sit in the
  // tree with nothing holding a second copy of them.
  chmodSync(join(world.install, ".env"), 0o000);

  const result = world.run();
  chmodSync(join(world.install, ".env"), 0o600);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  // The user's files are still theirs - a rollback with nothing to restore from must not
  // delete what it recorded.
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(backups(world.install), []);
});

void test("a run that can save nothing at all leaves nothing behind", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads a file with no permissions, so nothing fails here");
    return;
  }
  const world = createWorld(t);
  // Both places a copy of .env could go are refused: the installation's own directory
  // cannot be written, and the file itself cannot be read.
  mkdirSync(join(world.install, "data"), { recursive: true });
  chmodSync(join(world.install, "data"), 0o500);
  chmodSync(join(world.install, ".env"), 0o000);

  const result = world.run();
  chmodSync(join(world.install, "data"), 0o700);
  chmodSync(join(world.install, ".env"), 0o600);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Cannot copy/u);
  // Not even the empty file the fallback had to create to try: a run that copied nothing
  // leaves no stub of a copy anywhere.
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("a pending reboot stops a first install and only warns over a configured one", (t) => {
  const world = createWorld(t, { env: false });
  const flag = join(world.dir, "reboot-required");
  writeFileSync(flag, "");
  writeFileSync(`${flag}.pkgs`, "linux-headers-6.8.0-137\n");

  // Nothing is configured yet, and every package stage is still ahead: refuse.
  const fresh = world.run({ env: { IVA_REBOOT_FLAG: flag } });
  assert.notEqual(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.match(fresh.stderr, /sudo reboot/u);
  assert.doesNotMatch(world.calls(), /npm ci/u);

  // Configured: unattended-upgrades raises this flag for any security update, and a re-run
  // that installs nothing must not be refused for days.
  writeFileSync(
    join(world.install, ".env"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8723\n",
  );
  const incomplete = world.run({ env: { IVA_REBOOT_FLAG: flag } });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /sudo reboot/u);
  writeFileSync(
    join(world.install, ".iva-installed"),
    "autostart configured\n",
  );
  const rerun = world.run({
    calls: join(world.dir, "rerun.log"),
    env: { IVA_REBOOT_FLAG: flag },
  });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.match(rerun.stdout, /reboot/iu);
  assert.match(
    world.calls(join(world.dir, "rerun.log")),
    /iva _activate-units/u,
  );
});

void test("an occupied tree without git is refused with its previous build preserved", (t) => {
  const world = createWorld(t);
  cpSync(join(ROOT, "install.sh"), join(world.install, "install.sh"));
  rmSync(join(world.install, ".git"), { recursive: true, force: true });
  mkdirSync(join(world.install, ".output"));
  writeFileSync(join(world.install, ".output/server.mjs"), "previous build\n");
  const before = readFileSync(join(world.install, ".env"), "utf8");
  const result = world.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /INSTALL_DIR.*occupied.*ls -la/iu);
  assert.equal(
    readFileSync(join(world.install, ".output/server.mjs"), "utf8"),
    "previous build\n",
  );
  assert.equal(readFileSync(join(world.install, ".env"), "utf8"), before);
  assert.equal(world.calls(), "");
});

void test("a failure at the last stage restores the checkout and leaves nothing behind", (t) => {
  const world = createWorld(t);
  // What the user has: an edit of their own, a file of their own, and a build.
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  const result = world.run({ env: { IVA_TEST_UNITS_FAIL: "1" } });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Install stopped during/u);

  // Nothing of this run survives it: no copy of .env anywhere, no stash entry, no backup
  // ref, no half-moved build output.
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  assert.deepEqual(outputBackups(world.install), []);

  // And everything of the user's survives it.
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.equal(
    readFileSync(join(world.install, ".env"), "utf8"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8723\n",
  );
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
  );
  assert.equal(existsSync(join(world.install, ".output/server.mjs")), false);

  // The ignore rules keep a backup that somehow survives out of the next stash.
  mkdirSync(join(world.install, ".output.iva-install-backup-999"), {
    recursive: true,
  });
  writeFileSync(
    join(world.install, ".output.iva-install-backup-999/server.mjs"),
    "old\n",
  );
  assert.doesNotMatch(
    world.git("status", "--porcelain=v1", "--untracked-files=all"),
    /iva-install-backup/u,
  );
});

void test("a re-run over a finished install skips the stages that are already done", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");

  const first = world.run({ calls: join(world.dir, "first.log") });
  assert.equal(first.status, 0, first.stdout + first.stderr);

  const firstCalls = world.calls(join(world.dir, "first.log"));
  assert.match(firstCalls, /^npm ci$/mu);
  assert.match(
    firstCalls,
    /^npm i -g .*\/iva-agent-browser-[^/\s]+\/[^/\s]+$/mu,
  );
  assert.match(
    firstCalls,
    /^npm i -g --prefix .*\/home\/\.local .*\/iva-gws-[^/\s]+\/[^/\s]+$/mu,
  );
  assert.match(firstCalls, /^npm exec -- eve build$/mu);
  // A finished install keeps nothing either.
  assert.deepEqual(leftovers(world.tmp), []);
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );

  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);

  const secondCalls = world.calls(join(world.dir, "second.log"));
  assert.doesNotMatch(secondCalls, /^npm ci$/mu);
  assert.doesNotMatch(secondCalls, /^npm install$/mu);
  assert.doesNotMatch(secondCalls, /^npm i -g /mu);
  assert.doesNotMatch(secondCalls, /eve build/u);
  assert.doesNotMatch(secondCalls, /agent-browser install/u);
  // The lockfile is still checked, and the units are still written and enabled.
  assert.match(secondCalls, /^iva _install-units$/mu);
  assert.match(secondCalls, /^iva _activate-units$/mu);

  // The user's own state is still theirs after two runs.
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.equal(
    readFileSync(join(world.install, ".output/server.mjs"), "utf8"),
    "built",
  );
  assert.deepEqual(leftovers(world.tmp), []);
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
});

void test("a changed .env rebuilds instead of reusing the output", (t) => {
  const world = createWorld(t);
  assert.equal(world.run().status, 0);
  writeFileSync(
    join(world.install, ".env"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8724\n",
  );
  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(world.calls(join(world.dir, "second.log")), /eve build/u);
});

void test("a first install into an empty directory still runs every stage", (t) => {
  const world = createWorld(t);
  const fresh = join(world.dir, "fresh");

  // Пришли как `curl | bash`: установщик вне установки, ставить некуда - значит клон.
  const result = world.run({
    script: world.piped,
    env: { INSTALL_DIR: fresh },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  for (const stage of [
    /^npm ci$/mu,
    /^npm i -g .*\/iva-agent-browser-[^/\s]+\/[^/\s]+$/mu,
    /^agent-browser install --with-deps$/mu,
    /^npm i -g --prefix .*\/home\/\.local .*\/iva-gws-[^/\s]+\/[^/\s]+$/mu,
    /^npm exec -- eve build$/mu,
  ])
    assert.match(calls, stage);
  assert.equal(existsSync(join(fresh, ".output/server.mjs")), true);
  // Nothing was preserved, so nothing had to be cleaned up either.
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(backups(fresh), []);
  assert.equal(
    execFileSync("git", ["stash", "list"], { cwd: fresh, encoding: "utf8" }),
    "",
  );
});

void test("the deferred wizard ends with enabled units and lingering, in that order", (t) => {
  const world = createWorld(t, { env: false });

  const first = world.run({ calls: join(world.dir, "first.log") });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const firstCalls = world.calls(join(world.dir, "first.log"));
  assert.doesNotMatch(firstCalls, /iva _install-units/u);
  // Both places that tell the user what to do next name the same two commands: the
  // wizard, then the installer - never `iva restart`, which leaves the units disabled.
  const advice = (first.stdout + first.stderr).match(
    /npm run setup[\s\S]*?install\.sh/gu,
  );
  assert.equal(advice?.length, 2, first.stdout + first.stderr);
  assert.doesNotMatch(first.stdout, /iva restart/u);

  // What `npm run setup` leaves behind.
  writeFileSync(
    join(world.install, ".env"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8723\n",
  );

  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const secondCalls = world.calls(join(world.dir, "second.log"));
  const linger = secondCalls.indexOf("loginctl enable-linger");
  const activate = secondCalls.indexOf("iva _activate-units");
  assert.ok(linger >= 0, `lingering was never enabled:\n${secondCalls}`);
  assert.match(secondCalls, /^iva _install-units$/mu);
  assert.ok(
    activate > linger,
    `the units were activated before lingering:\n${secondCalls}`,
  );
});

/**
 * Один обновлятор: установщик над существующей установкой ничего не обновляет сам, а
 * отдаёт дерево repair.sh того же канала - тому же пути, которым идут `iva update`, мост
 * и команда ремонта. Своей копии решения «можно ли обновлять это дерево» у него нет.
 *
 * Сеть не нужна: repair.sh приходит через стаб curl из файла репозитория, origin
 * установки - локальный bare, а обновлятор в дереве - стаб `bin/iva.mjs`.
 */
void test("a re-run over a checkout puts it back on the release and hands the update over", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "bin/iva.mjs"), "// my own updater\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");
  const released = world.git("rev-parse", "HEAD");
  world.git("commit", "--quiet", "-am", "an edit of the owner's");

  const result = world.run({
    script: world.piped,
    env: { REPO_URL: "https://github.com/smixs/iva-agent.git" },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Дерево - на релизе, правка в коде Ивы затёрта, неотслеживаемое на месте.
  assert.equal(world.git("rev-parse", "HEAD"), released);
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  // И работу дальше делает обновлятор, а не установщик: своих стадий он не проходил.
  const calls = world.calls();
  assert.match(calls, /^iva update$/mu);
  assert.doesNotMatch(calls, /eve build/u);
  assert.doesNotMatch(calls, /^npm ci$/mu);
});

void test("a second installer over the same checkout is refused by name before the hand-over", (t) => {
  const world = createWorld(t);
  const lock = join(world.install, "data/install.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), `${process.pid}\n`);
  const head = world.git("rev-parse", "HEAD");

  const refused = world.run({
    script: world.piped,
    env: { REPO_URL: "https://github.com/smixs/iva-agent.git" },
  });
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, new RegExp(`pid ${process.pid}`, "u"));
  // Дерево не двигалось и обновлятор не вызывался.
  assert.equal(world.git("rev-parse", "HEAD"), head);
  assert.doesNotMatch(world.calls(), /iva update/u);
});

void test("a checkout too old to resolve its data directory is still handed over", (t) => {
  const world = createWorld(t);
  rmSync(join(world.install, "packages/data-dir"), {
    recursive: true,
    force: true,
  });
  const result = world.run({
    script: world.piped,
    env: { REPO_URL: "https://github.com/smixs/iva-agent.git" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(world.calls(), /^iva update$/mu);
});

void test("a re-run over a development checkout is refused and changes nothing", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, ".iva-dev"), "");
  writeFileSync(join(world.install, "bin/iva.mjs"), "// work in progress\n");
  const head = world.git("rev-parse", "HEAD");

  const result = world.run({
    script: world.piped,
    env: { REPO_URL: "https://github.com/smixs/iva-agent.git" },
  });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /development checkout \(\.iva-dev\)/u);
  // Работа на месте, история не двинулась, обновление никому не передано.
  assert.equal(
    readFileSync(join(world.install, "bin/iva.mjs"), "utf8"),
    "// work in progress\n",
  );
  assert.equal(world.git("rev-parse", "HEAD"), head);
  assert.doesNotMatch(world.calls(), /^iva update$/mu);
});

void test("a re-run over a versioned installation starts the updater it already has", (t) => {
  const world = createWorld(t);
  const versioned = join(world.dir, "v2");
  mkdirSync(join(versioned, "versions/0.3.20-0123456789ab/bin"), {
    recursive: true,
  });
  mkdirSync(join(versioned, "current/bin"), { recursive: true });
  cpSync(
    join(world.install, "bin/iva.mjs"),
    join(versioned, "current/bin/iva.mjs"),
  );
  cpSync(join(world.install, ".env"), join(versioned, ".env"));
  const units = join(world.home, ".config/systemd/user");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "iva.service"), "legacy unit\n");
  writeFileSync(join(units, "iva-telegram-poll.service"), "legacy unit\n");

  const result = world.run({
    script: world.piped,
    env: {
      INSTALL_DIR: versioned,
      REPO_URL: "https://github.com/smixs/iva-agent.git",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(world.calls(), /^iva update$/mu);
  // Клона в версионную раскладку не бывает: чекаута там нет и не появляется.
  assert.equal(existsSync(join(versioned, ".git")), false);
});

for (const fault of [
  "ok",
  "404",
  "drop",
  "integrity",
  "truncated",
] satisfies ArchiveFault[]) {
  void test(`fresh installer fetches the locked eve archive: ${fault}`, async (t) => {
    const world = createWorld(t, { env: false });
    const archive = await eveArchive(t, world.dir);
    archive.setFault(fault);
    archive.writeManifest(world.install, "1.0.1");
    world.git("add", "package.json", "package-lock.json", ".npmrc");
    world.git("commit", "--quiet", "-m", "archive dependency");
    world.git("tag", "v1.0.1");
    world.git("push", "--quiet", "--tags", "origin", "main");
    rmSync(world.install, { recursive: true, force: true });
    const options = {
      script: world.piped,
      env: { IVA_TEST_REAL_NPM: NPM_CLI },
    };
    const result = await world.runAsync(options).done;
    assert.match(world.calls(), /^npm ci$/mu);
    assert.ok(archive.requests.includes("/asset.tgz"), result.output);
    assert.equal(result.code, fault === "ok" ? 0 : 1, result.output);
    if (fault === "ok") {
      assert.equal(
        (
          JSON.parse(
            readFileSync(
              join(world.install, "node_modules/eve/package.json"),
              "utf8",
            ),
          ) as { version: string }
        ).version,
        "0.51.1-iva.1",
      );
    } else {
      assert.equal(existsSync(join(world.install, "current")), false);
      assert.equal(
        existsSync(join(world.install, ".output/server.mjs")),
        false,
      );
      assert.match(
        result.output,
        fault === "404"
          ? /E404/u
          : fault === "integrity"
            ? /EINTEGRITY/u
            : /ECONNRESET|ETIMEDOUT|EIDLETIMEOUT|ERR_SOCKET_TIMEOUT/u,
      );
    }
    if (fault === "truncated") {
      archive.setFault("ok");
      const retryLog = join(world.dir, "retry-npm.log");
      const retry = await world.runAsync({
        ...options,
        calls: retryLog,
        env: {
          ...options.env,
          REPO_URL: "https://github.com/smixs/iva-agent.git",
          IVA_TEST_NPM_LOG: retryLog,
        },
      }).done;
      assert.equal(retry.code, 0, retry.output);
      assert.match(retry.output, /Continuing first installation/u);
      assert.doesNotMatch(retry.output, /handing it to the updater/u);
      assert.match(readFileSync(retryLog, "utf8"), /^npm ci$/mu);
      assert.equal(
        (
          JSON.parse(
            readFileSync(
              join(world.install, "node_modules/eve/package.json"),
              "utf8",
            ),
          ) as { version: string }
        ).version,
        "0.51.1-iva.1",
      );
      assert.equal(existsSync(join(world.install, ".output/server.mjs")), true);
      assert.equal(existsSync(join(world.install, "current")), false);
    }
    assert.ok(
      archive.requests.every((url) => ["/eve.tgz", "/asset.tgz"].includes(url)),
      archive.requests.join("\n"),
    );
  });
}

for (const field of ["resolved", "integrity"] as const) {
  void test(`installer runs npm ci for the same eve version with a different ${field}`, (t) => {
    const world = createWorld(t);
    const first = world.run({ calls: join(world.dir, "first.log") });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const file = join(world.install, "node_modules/.package-lock.json");
    const lock = JSON.parse(readFileSync(file, "utf8")) as {
      packages: Record<string, Record<string, string>>;
    };
    lock.packages["node_modules/eve"][field] =
      field === "resolved"
        ? "https://example.invalid/other.tgz"
        : "sha512-other";
    writeFileSync(file, JSON.stringify(lock));
    const second = world.run({ calls: join(world.dir, "second.log") });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(world.calls(join(world.dir, "second.log")), /^npm ci$/mu);
  });
}

for (const existing of [false, true]) {
  void test(`installation repairs GLIBC gws (already installed: ${existing})`, (t) => {
    const world = createWorld(t);
    if (existing) {
      mkdirSync(join(world.home, ".local/bin"), { recursive: true });
      writeFileSync(
        join(world.home, ".local/bin/gws"),
        "#!/bin/sh\necho GLIBC_2.39 >&2\nexit 1\n",
        { mode: 0o755 },
      );
    }
    const result = world.run({
      env: { IVA_TEST_GWS_ERROR: "GLIBC_2.39 not found" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(world.calls(), /unknown-linux-musl/u);
    assert.match(result.stdout, /gws ready/u);
    assert.deepEqual(leftovers(world.tmp), []);
  });
}

void test("installation continues when the musl repair fails", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_GWS_ERROR: "GLIBC_2.39 not found",
      IVA_TEST_CORRUPT_ARTIFACT: "musl",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /couldn't install gws/u);
  assert.deepEqual(leftovers(world.tmp), []);
});

for (const arch of ["aarch64", "x86_64"]) {
  void test(`updater GWS replaces a GLIBC failure with verified musl on ${arch}`, (t) => {
    const world = createWorld(t);
    const prefix = join(world.home, "prefix with spaces");
    const result = world.run({
      args: ["--update-gws", prefix],
      env: {
        IVA_TEST_GWS_ERROR: "version GLIBC_2.39 not found",
        IVA_TEST_ARCH: arch,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /gws 0\.22\.5/u);
    assert.ok(
      world
        .calls()
        .includes(`google-workspace-cli-${arch}-unknown-linux-musl.tar.gz`),
    );
    assert.deepEqual(leftovers(world.tmp), []);
  });
}

const gwsRepairFailures: Array<Record<string, string>> = [
  { IVA_TEST_CORRUPT_ARTIFACT: "musl" },
  { IVA_TEST_FAIL_ARTIFACT_DOWNLOAD: "musl" },
  { IVA_TEST_MUSL_EXIT: "1" },
  { IVA_TEST_ARCH: "riscv64" },
];
for (const env of gwsRepairFailures) {
  void test(`GWS repair reports failure and cleans downloads: ${JSON.stringify(env)}`, (t) => {
    const world = createWorld(t);
    const result = world.run({
      args: ["--update-gws", join(world.home, ".local")],
      env: { IVA_TEST_GWS_ERROR: "version GLIBC_2.39 not found", ...env },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Google.*unavailable/u);
    assert.deepEqual(leftovers(world.tmp), []);
  });
}

void test("GWS errors unrelated to GLIBC do not download musl", (t) => {
  const world = createWorld(t);
  const result = world.run({
    args: ["--update-gws", join(world.home, ".local")],
    env: { IVA_TEST_GWS_ERROR: "permission denied" },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(world.calls(), /unknown-linux-musl/u);
  assert.match(result.stdout + result.stderr, /permission denied/u);
});

void test("updater GWS path checks the same pinned bytes and preserves credentials", (t) => {
  const world = createWorld(t);
  const prefix = join(world.home, "user with spaces", ".local");
  const credentials = join(world.home, ".config/gws/credentials.json");
  mkdirSync(join(world.home, ".config/gws"), { recursive: true });
  writeFileSync(credentials, "fixture authorization");
  const result = world.run({ args: ["--update-gws", prefix] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  assert.ok(calls.includes(PINNED_ARTIFACTS.gws.url));
  assert.ok(calls.indexOf("sha256sum ") < calls.indexOf("npm i -g "));
  assert.ok(calls.includes(`npm i -g --prefix ${prefix} `));
  assert.doesNotMatch(calls, /latest|systemctl|git |iva |apt-get/u);
  assert.equal(readFileSync(credentials, "utf8"), "fixture authorization");
  assert.deepEqual(leftovers(world.tmp), []);
});
void test("updater GWS entry works with HOME and INSTALL_DIR unset", (t) => {
  const world = createWorld(t);
  const script = join(world.dir, "update-without-home.sh");
  writeFileSync(
    script,
    'unset HOME INSTALL_DIR\nexec bash "$1" --update-gws "$2"\n',
  );
  const prefix = join(world.home, "prefix with spaces");
  const result = world.run({
    script,
    args: [join(world.install, "install.sh"), prefix],
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(world.calls().includes(`npm i -g --prefix ${prefix} `));
  assert.deepEqual(leftovers(world.tmp), []);
});
void test("updater GWS path rejects corrupt bytes before npm and removes its download", (t) => {
  const world = createWorld(t);
  const result = world.run({
    args: ["--update-gws", join(world.home, ".local")],
    env: { IVA_TEST_CORRUPT_ARTIFACT: "gws" },
  });
  assert.equal(result.status, 86, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /SHA-256 mismatch/u);
  assert.doesNotMatch(world.calls(), /npm i/u);
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("Darwin installer uses brew and launchd without swap or linger", (t) => {
  const world = createWorld(t);
  const result = world.run({ env: { IVA_TEST_OS: "Darwin" } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(world.calls(), /launchctl print gui\//u);
  assert.doesNotMatch(world.calls(), /loginctl|swapon|mkswap|apt-get|dnf/u);
  assert.match(result.stdout, /iva logs -f/u);
  assert.match(result.stdout, /Mac is on, awake/u);
});
void test("Darwin installer stops without a GUI login or Homebrew", (t) => {
  for (const env of [
    { IVA_TEST_OS: "Darwin", IVA_TEST_GUI: "0", IVA_TEST_MISSING_COMMANDS: "" },
    {
      IVA_TEST_OS: "Darwin",
      IVA_TEST_GUI: "1",
      IVA_TEST_MISSING_COMMANDS: "brew",
    },
  ]) {
    const world = createWorld(t);
    const result = world.run({ env });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stdout + result.stderr,
      /войдите в систему на экране|Install Homebrew/u,
    );
    assert.doesNotMatch(world.calls(), /_activate-units|loginctl|swapon/u);
  }
});

void test("repair 8: Darwin package installs preserve piped installer stdin", (t) => {
  const world = createWorld(t);
  rmSync(world.install, { recursive: true, force: true });
  const result = world.run({
    pipedStdin: true,
    script: world.piped,
    env: {
      IVA_TEST_OS: "Darwin",
      IVA_TEST_BREW_READ_STDIN: "1",
      IVA_TEST_MISSING_COMMANDS: "ffmpeg pandoc pdftotext gh",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(world.calls(), /brew install/);
  assert.match(result.stdout, /Mac is on, awake/);
});
