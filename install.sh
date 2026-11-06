#!/usr/bin/env bash
#
# Install Iva (a personal long-term-memory agent) with one command on a bare VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh | bash
#
# Installs system dependencies (git, gh, python3, ffmpeg, pandoc, poppler), uv, Node 24+ (nvm),
# npm dependencies, runs an interactive setup (Ollama + model + Telegram +
# Deepgram + timezone + vault), builds the agent and sets up a systemd user service plus
# watchdog timers (brain, update check). Memory rollups (daily/weekly/monthly/yearly)
# run as in-process eve schedules, not systemd. The live vault is initialized as a separate
# git repo for backup.
#
# The interactive setup reads input from /dev/tty — so it works with `curl | bash` too
# (over SSH with a real terminal). If there's no terminal (Docker/CI), setup is skipped,
# and the command to run it manually is printed at the end (`npm run setup`).
#
# Flags (via `curl ... | bash -s -- <flags>`):
#   --skip-setup        don't run the setup wizard (run it yourself: npm run setup)
#   --non-interactive   don't ask any questions (use defaults; skip setup)
#   --env-file <path>   validate and complete first-install settings without the wizard
#   -h, --help          show this help
# Instant reassurance: print something right away so there's no silence at startup.
printf '\n  \033[36m⏳ Preparing environment / Идёт подготовка окружения — up to a minute, do not interrupt…\033[0m\n'
set -Eeuo pipefail

IVA_OS="$(uname -s)"
REPO_URL="${REPO_URL:-https://github.com/smixs/iva-agent.git}"
# IVA_BETA=1 - бета-обновления: всегда ветка beta, в main только выпуски (ADR-0018).
if [ "${IVA_BETA:-}" = 1 ]; then
  [ "${BRANCH:-beta}" = beta ] || printf 'IVA_BETA=1: BRANCH=%s ignored, installing the beta branch\n' "$BRANCH" >&2
  BRANCH=beta
fi
BRANCH="${BRANCH:-main}"
UPDATE_CHANNEL="$BRANCH"
NODE_MAJOR_MIN=24
UV_INSTALLER_URL="https://github.com/astral-sh/uv/releases/download/0.12.5/uv-installer.sh"
UV_INSTALLER_SHA256="504511fbbbd811aeaba6738abc79408956b6c7da0ca35437b3dcc24a41efc111"
NVM_INSTALLER_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"
NVM_INSTALLER_SHA256="abdb525ee9f5b48b34d8ed9fc67c6013fb0f659712e401ecd88ab989b3af8f53"
AGENT_BROWSER_TARBALL_URL="https://registry.npmjs.org/agent-browser/-/agent-browser-0.34.0.tgz"
AGENT_BROWSER_TARBALL_SHA256="a4744fb189e598467abcfb3acdde07118d9e5cb43dc3b31727f869af4eb9d598"
GWS_TARBALL_URL="https://registry.npmjs.org/@googleworkspace/cli/-/cli-0.22.5.tgz"
GWS_TARBALL_SHA256="b3d415a6d1b09589b13f6a71451d3d3927c4dc4701822d6aae549f8ff8f3380a"
GWS_MUSL_RELEASE="https://github.com/googleworkspace/cli/releases/download/v0.22.5"
GWS_MUSL_X86_64_SHA256="4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920"
GWS_MUSL_AARCH64_SHA256="e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a"
CHECKSUM_MISMATCH_RC=86
VERIFIED_DOWNLOAD_DIR=""
VERIFIED_DOWNLOAD=""

# Every apt run below has to be unattended. On Ubuntu 24.04 with a pending kernel upgrade,
# needrestart draws an ncurses "Pending kernel upgrade" dialog and dpkg asks about modified
# config files — both are painted into INSTALL_LOG behind the spinner, where nobody can see
# them or press Ok, so the install hangs forever ("stuck on Chromium").
# Exported for the root path and for child processes. sudo does NOT carry them across
# (env_reset, and neither name is in its default env_keep), so the sudo path gets them
# injected explicitly — see apt_get() next to run_root below.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

if [ -n "${NO_COLOR:-}" ] || [ "${TERM:-}" = dumb ]; then
  c_blue=""; c_green=""; c_yellow=""; c_red=""; c_bold=""; c_reset=""
else
  c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_bold=$'\033[1m'; c_reset=$'\033[0m'
fi
step() { echo "${c_blue}▸ $*${c_reset}"; }
ok()   { echo "${c_green}✓ $*${c_reset}"; }
warn() { echo "${c_yellow}! $*${c_reset}"; }
die()  { echo "${c_red}✗ $*${c_reset}" >&2; exit 1; }

# Installer language and the agent's default reply language. Default is English (global audience);
# asked as the FIRST question (pick_language below). t en ru — picks a string by language.
IVA_LANG=en
t() { if [ "$IVA_LANG" = ru ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

cleanup_verified_download() {
  if [ -n "$VERIFIED_DOWNLOAD_DIR" ]; then rm -rf -- "$VERIFIED_DOWNLOAD_DIR" || true; fi
  VERIFIED_DOWNLOAD_DIR=""
  VERIFIED_DOWNLOAD=""
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 127
  fi
}

# Download into a directory owned by this run, keeping the published file name. npm reads
# a local path without a .tgz/.tar.gz/.tar extension as a package directory and opens
# <path>/package.json inside it, so a bare mktemp file died with ENOTDIR; the installer
# scripts are indifferent to the name. Nothing executes or reaches npm before the exact
# published bytes match the digest pinned beside their immutable URL.
download_verified() {
  local label="$1" url="$2" expected="$3" actual="" rc=0
  cleanup_verified_download
  VERIFIED_DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/iva-$label-XXXXXX")" || return
  VERIFIED_DOWNLOAD="$VERIFIED_DOWNLOAD_DIR/${url##*/}"
  if curl -fsSL "$url" -o "$VERIFIED_DOWNLOAD"; then
    :
  else
    rc=$?
    return "$rc"
  fi
  if actual="$(sha256_file "$VERIFIED_DOWNLOAD")"; then
    :
  else
    rc=$?
    echo "No SHA-256 tool is available for $label" >&2
    return "$rc"
  fi
  if [ "$actual" != "$expected" ]; then
    echo "SHA-256 mismatch for $label: expected $expected, got $actual" >&2
    return "$CHECKSUM_MISMATCH_RC"
  fi
}

install_verified_npm_tarball() {
  local label="$1" url="$2" expected="$3" rc=0
  shift 3
  if download_verified "$label" "$url" "$expected"; then
    :
  else
    rc=$?
    cleanup_verified_download
    return "$rc"
  fi
  if npm i -g "$@" "$VERIFIED_DOWNLOAD"; then rc=0; else rc=$?; fi
  cleanup_verified_download
  return "$rc"
}

repair_gws_glibc() {
  local prefix="$1" arch sha
  arch="$(uname -m)"
  case "$arch" in
    x86_64) sha="$GWS_MUSL_X86_64_SHA256" ;;
    aarch64|arm64) arch=aarch64; sha="$GWS_MUSL_AARCH64_SHA256" ;;
    *) return 1 ;;
  esac
  download_verified gws-musl "$GWS_MUSL_RELEASE/google-workspace-cli-$arch-unknown-linux-musl.tar.gz" "$sha" \
    && tar -xzf "$VERIFIED_DOWNLOAD" -C "$VERIFIED_DOWNLOAD_DIR" ./gws \
    && install -m 755 "$VERIFIED_DOWNLOAD_DIR/gws" "$prefix/lib/node_modules/@googleworkspace/cli/bin/gws"
}

install_gws() {
  local prefix="$1" output
  install_verified_npm_tarball gws "$GWS_TARBALL_URL" "$GWS_TARBALL_SHA256" --prefix "$prefix" || return $?
  if output="$("$prefix/bin/gws" --version 2>&1)"; then echo "$output"; return 0; fi
  echo "$output" >&2
  if [ "$IVA_OS" = Linux ] && [[ "$output" == *GLIBC_* ]]; then
    if repair_gws_glibc "$prefix"; then
      cleanup_verified_download
      if "$prefix/bin/gws" --version; then return 0; fi
    fi
    cleanup_verified_download
  fi
  warn "$(t 'Google CLI unavailable; Iva continues. Repair: bash install.sh --update-gws "$HOME/.local"' 'Google CLI недоступен; Ива продолжает работу. Починка: bash install.sh --update-gws "$HOME/.local"')"
  return 1
}

# Internal updater entry: exactly the same pins, download and checksum as installation.
# Runs before setup, repository discovery, units or service changes.
if [ "${1:-}" = --update-gws ]; then
  [ "$#" -eq 2 ] || exit 2
  install_gws "$2"
  exit "$?"
fi

INSTALL_DIR="${INSTALL_DIR:-$HOME/iva}"

# Compact progress for automatic work. Prompts, sudo and the setup wizard never
# run behind a spinner, so they remain fully readable and interactive.
INSTALL_LOG="${TMPDIR:-/tmp}/iva-install-$$.log"
# Proven writable before anything is done, because every step of the rollback redirects
# into it: a temporary directory nobody can write to would make those redirects fail before
# the commands even ran, and the undo would be skipped without a word. Fail here instead,
# while there is still nothing to undo.
: >"$INSTALL_LOG" || die "$(t "Cannot write the install log at $INSTALL_LOG. Set TMPDIR to a writable directory and run again." "Не могу писать лог установки в $INSTALL_LOG. Укажите TMPDIR с правом записи и запустите снова.")"
SPINNER_PID=""
# The stage a failure interrupted, named in the error handler (bootstrap.sh does the same):
# a late failure is otherwise buried under the npm output of the stages before it.
CURRENT_STEP="startup"
spinner_enabled() {
  [ -t 1 ] && [ "${IVA_NO_ANIM:-0}" != 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]
}
stop_spinner() {
  if [ -n "$SPINNER_PID" ]; then
    kill "$SPINNER_PID" 2>/dev/null || true
    wait "$SPINNER_PID" 2>/dev/null || true
    SPINNER_PID=""
    printf '\r\033[2K\033[?25h'
  fi
}
start_spinner() {
  local label="$1"
  if ! spinner_enabled; then
    echo "◇ $label"
    return
  fi
  printf '\033[?25l'
  (
    local frames=('◇' '◈' '◆' '◈') i=0
    while :; do
      printf '\r\033[2K%s %s' "${frames[$i]}" "$label"
      i=$(( (i + 1) % 4 ))
      sleep 0.09
    done
  ) &
  SPINNER_PID=$!
}
run_stage() {
  local label="$1" success="$2" rc=0
  shift 2
  CURRENT_STEP="$label"
  start_spinner "$label"
  # The exit code has to be read inside the else branch. Read after `fi` it is the status
  # of the if-statement itself, which is 0 when a failing condition has no else — so every
  # stage reported success, and a build killed by the OOM killer ended with a green banner.
  if "$@" >>"$INSTALL_LOG" 2>&1; then
    stop_spinner
    ok "$success"
    return 0
  else
    rc=$?
  fi
  stop_spinner
  # Every line of the report is optional; the exit code is not. With no terminal left to
  # print to, an unguarded write here would replace the code the stage really died with.
  warn "$(t "Failed: $label" "Не удалось: $label")" || true
  {
    tail -n 12 "$INSTALL_LOG"
    echo "$(t "Full log:" "Полный лог:") $INSTALL_LOG"
  } >&2 2>/dev/null || true
  return "$rc"
}

show_tree() {
  [ -t 1 ] || return 0   # only in a real terminal (not in logs/CI)
  printf '%b' "$(cat <<'IVA_TREE'
                \033[38;2;126;141;74mc\033[38;2;142;186;43mx\033[38;2;157;146;41ma\033[38;2;78;154;73m!\033[38;2;105;103;79mi\033[38;2;105;53;79m:\033[0m
           \033[38;2;61;177;90m;\033[38;2;84;91;111mc\033[38;2;46;77;117mi\033[38;2;25;73;134m!\033[38;2;50;158;114mi\033[38;2;109;178;62ma\033[38;2;31;143;143mc\033[38;2;116;161;70ma\033[38;2;185;151;29ma\033[38;2;135;164;52mc\033[38;2;172;114;30m*\033[38;2;177;51;35mo\033[38;2;194;55;32m. \033[38;2;178;195;26m!\033[38;2;121;179;30m!\033[0m
         \033[38;2;144;202;31m:\033[38;2;70;148;87mi\033[38;2;159;160;50ma\033[38;2;44;90;138mc\033[38;2;30;79;146mc\033[38;2;34;60;145mc\033[38;2;75;171;81ma\033[38;2;111;178;62mc\033[38;2;49;165;113ma\033[38;2;132;131;56m*\033[38;2;190;60;31mx\033[38;2;153;98;45m*\033[38;2;168;105;40m*\033[38;2;198;72;31mx\033[38;2;195;98;29m*\033[38;2;92;147;88mi\033[38;2;83;149;91mc\033[38;2;120;175;50ma\033[38;2;123;192;41mo\033[38;2;98;178;67mc\033[38;2;113;184;37m!\033[38;2;173;51;35m:\033[0m
         \033[38;2;68;160;103m:\033[38;2;39;145;139mc\033[38;2;46;120;130ma\033[38;2;25;99;153mc\033[38;2;21;138;157mc\033[38;2;48;120;121mo\033[38;2;140;192;34ma\033[38;2;67;162;96mo\033[38;2;107;175;68ma\033[38;2;81;152;93ma\033[38;2;172;140;29mx\033[38;2;167;108;48mo\033[38;2;177;71;45mi\033[38;2;194;106;33ma\033[38;2;183;145;31mx\033[38;2;126;194;47m*\033[38;2;44;150;120mo\033[38;2;31;85;148m;\033[38;2;83;165;83mo\033[38;2;43;169;124mo\033[38;2;80;161;76mc\033[38;2;102;119;80mc\033[38;2;205;111;26m;\033[0m
       \033[38;2;194;82;33m.\033[38;2;108;130;89m!\033[38;2;70;130;106mi\033[38;2;23;114;158mc\033[38;2;22;130;163mo\033[38;2;87;174;87mo\033[38;2;41;153;133mc\033[38;2;29;111;152mi\033[38;2;74;152;105ma\033[38;2;22;139;150mo\033[38;2;37;118;134mi\033[38;2;72;179;80ma\033[38;2;65;184;93ma\033[38;2;119;178;61m*\033[38;2;148;151;57ma\033[38;2;155;137;52m*\033[38;2;135;181;56m*\033[38;2;70;185;88ma\033[38;2;35;143;133mc\033[38;2;156;113;55mo\033[38;2;73;170;80m*\033[38;2;84;132;78mo\033[38;2;133;129;68mc\033[38;2;76;175;81mo\033[38;2;121;186;58mo\033[0m
      \033[38;2;145;105;59m!\033[38;2;155;131;52m*\033[38;2;116;174;50ma\033[38;2;93;179;67ma\033[38;2;130;167;43m*\033[38;2;100;175;65ma\033[38;2;40;119;131mc\033[38;2;29;81;141mi\033[38;2;36;149;135mc\033[38;2;45;162;133ma\033[38;2;41;167;137mc\033[38;2;54;152;119mc\033[38;2;54;140;107mc\033[38;2;44;118;132mc\033[38;2;55;151;128mc\033[38;2;104;157;74mo\033[38;2;112;174;55ma\033[38;2;125;183;48ma\033[38;2;60;186;109mo\033[38;2;37;167;126mo\033[38;2;157;167;38m*\033[38;2;69;125;116ma\033[38;2;115;153;80mc\033[38;2;30;121;146mi\033[38;2;92;183;73mo\033[38;2;147;169;52mc\033[0m
     \033[38;2;109;71;70m.\033[38;2;167;139;51m*\033[38;2;206;132;24m*\033[38;2;191;162;23m*\033[38;2;110;158;76mo\033[38;2;65;74;118mi\033[38;2;45;109;139mc\033[38;2;45;91;125mi\033[38;2;48;57;93m.\033[38;2;24;110;150mi\033[38;2;35;181;141mc\033[38;2;47;150;127mc\033[38;2;52;87;130mi\033[38;2;34;103;142mi\033[38;2;43;138;127ma\033[38;2;90;165;86mo\033[38;2;102;157;90mo\033[38;2;28;126;153mc\033[38;2;52;161;110mo\033[38;2;31;132;136mi\033[38;2;53;171;106mi\033[38;2;84;182;71ma\033[38;2;165;168;28mx\033[38;2;146;175;50ma\033[38;2;57;176;98mc\033[38;2;36;141;137mo\033[38;2;43;122;119mo\033[38;2;33;52;137mi\033[38;2;34;62;122m:\033[38;2;105;93;84mi\033[38;2;149;79;55m;\033[0m
    \033[38;2;185;52;32m:\033[38;2;176;72;40m*\033[38;2;139;163;48mo\033[38;2;146;166;57ma\033[38;2;172;135;35mx\033[38;2;129;129;69mc\033[38;2;31;83;156mi\033[38;2;38;83;136mo\033[38;2;35;46;138m;\033[38;2;29;85;147m!\033[38;2;32;69;156mi\033[38;2;37;124;131mo\033[38;2;43;101;123mc\033[38;2;29;83;138m:\033[38;2;46;23;116m.\033[38;2;43;21;104m:\033[38;2;47;77;108m!\033[38;2;87;125;81mi\033[38;2;63;153;107ma\033[38;2;55;121;121mo\033[38;2;25;109;161mc\033[38;2;36;142;122mc\033[38;2;81;156;107ma\033[38;2;125;178;57ma\033[38;2;122;129;62ma\033[38;2;125;138;59ma\033[38;2;73;160;108ma\033[38;2;41;135;118mo\033[38;2;26;133;151mc\033[38;2;28;102;148mi\033[38;2;30;98;143mi\033[38;2;48;140;127ma\033[38;2;50;74;107m.\033[0m
   \033[38;2;173;114;31mo\033[38;2;182;104;29ma\033[38;2;183;93;29mx\033[38;2;122;149;61ma\033[38;2;70;149;105mc\033[38;2;154;116;39m*\033[38;2;149;103;36m*\033[38;2;103;127;88ma\033[38;2;107;103;89mi\033[38;2;82;147;84mo\033[38;2;67;164;98mo\033[38;2;66;153;99ma\033[38;2;87;178;87ma\033[38;2;136;132;64m*\033[38;2;142;144;50m*\033[38;2;63;164;97mi\033[38;2;133;176;45mc\033[38;2;128;158;64mc\033[38;2;61;112;110mi\033[38;2;63;138;123mo\033[38;2;61;152;117mo\033[38;2;44;118;132mo\033[38;2;106;127;64mo\033[38;2;86;96;112ma\033[38;2;59;162;100mc\033[38;2;27;93;147m!\033[38;2;35;137;137mo\033[38;2;59;161;102mo\033[38;2;85;160;85ma\033[38;2;44;142;121mc\033[38;2;73;154;83mc\033[38;2;54;167;112mo\033[38;2;121;175;66m*\033[38;2;57;130;114mi\033[38;2;32;159;140m:\033[0m
   \033[38;2;144;173;31m*\033[38;2;157;171;30m*\033[38;2;177;138;33m*\033[38;2;112;118;75ma\033[38;2;63;117;127mo\033[38;2;103;174;76mo\033[38;2;85;184;64mc\033[38;2;143;175;51ma\033[38;2;172;186;33m*\033[38;2;102;186;58ma\033[38;2;35;86;137m;\033[38;2;39;86;144mc\033[38;2;141;188;46ma\033[38;2;74;165;84mo\033[38;2;92;139;67mi\033[38;2;58;149;102mo\033[38;2;102;151;59mo\033[38;2;121;191;57ma\033[38;2;87;170;80ma\033[38;2;33;124;136mo\033[38;2;28;88;143ma\033[38;2;110;145;65mo\033[38;2;158;159;39ma\033[38;2;172;87;42m*\033[38;2;139;126;61mo\033[38;2;34;126;132mo\033[38;2;49;171;111mc\033[38;2;63;174;89mc\033[38;2;51;171;111mc\033[38;2;44;166;126mc\033[38;2;47;152;114mc\033[38;2;52;140;110mi\033[38;2;40;171;130mo\033[38;2;79;174;86ma\033[38;2;57;170;113mc\033[38;2;31;44;151m.\033[0m
  \033[38;2;159;51;42m;\033[38;2;191;64;32mx\033[38;2;170;142;44m*\033[38;2;70;170;95mo\033[38;2;124;163;69mo\033[38;2;35;148;138mc\033[38;2;60;176;99mo\033[38;2;43;149;111mc\033[38;2;157;153;50m*\033[38;2;127;158;50ma\033[38;2;33;79;143mi\033[38;2;24;102;156mi\033[38;2;32;51;153mc\033[38;2;27;64;147mi\033[38;2;28;90;146mi\033[38;2;35;43;146mc\033[38;2;33;43;151mi\033[38;2;87;98;93mi\033[38;2;85;143;100ma\033[38;2;27;117;149mi\033[38;2;28;149;149mo\033[38;2;33;105;143m!\033[38;2;44;137;122mc\033[38;2;41;149;128mo\033[38;2;40;153;123mo\033[38;2;139;76;72m*\033[38;2;109;158;74ma\033[38;2;24;95;153mc\033[38;2;26;96;164mi\033[38;2;35;143;139mo\033[38;2;33;99;135mc\033[38;2;28;74;158m!\033[38;2;28;74;148mi\033[38;2;30;138;144mc\033[38;2;28;141;136mi\033[38;2;31;57;142m!\033[38;2;34;46;137m:\033[0m
 \033[38;2;154;130;43m!\033[38;2;60;165;104mc\033[38;2;156;194;28m*\033[38;2;185;128;28mw\033[38;2;169;158;27mx\033[38;2;94;138;93ma\033[38;2;24;101;156mc\033[38;2;43;140;124mo\033[38;2;45;148;128mc\033[38;2;48;155;124ma\033[38;2;39;126;138mo\033[38;2;33;47;157mi\033[38;2;30;47;154m;\033[38;2;24;110;161mi\033[38;2;35;34;133mi\033[38;2;37;45;131m:\033[38;2;30;50;140mi\033[38;2;34;53;151mi\033[38;2;27;89;149mi\033[38;2;28;76;149mi\033[38;2;27;72;145mi\033[38;2;31;55;162mi\033[38;2;28;72;162mi\033[38;2;49;99;113mc\033[38;2;42;52;121m!\033[38;2;81;169;72ma\033[38;2;78;163;98ma\033[38;2;48;153;121mc\033[38;2;35;41;152mi\033[38;2;28;80;152mo\033[38;2;23;124;153mi\033[38;2;39;95;136mo\033[38;2;48;108;123mc\033[38;2;33;55;144m!\033[38;2;40;30;130m:\033[38;2;29;82;147m!\033[38;2;32;43;149m!\033[38;2;40;42;132m!\033[38;2;92;150;82m*\033[0m
 \033[38;2;184;130;33ma\033[38;2;39;131;131mo\033[38;2;90;189;82ma\033[38;2;35;146;138mo\033[38;2;84;172;83mi\033[38;2;80;163;102mo\033[38;2;61;154;115ma\033[38;2;109;180;62ma\033[38;2;44;123;118mc\033[38;2;34;45;145m!\033[38;2;35;40;144m!\033[38;2;40;33;138m;\033[38;2;28;74;138mo\033[38;2;159;148;52mx\033[38;2;113;158;70ma\033[38;2;62;47;119mc\033[38;2;143;71;60m!\033[38;2;66;135;118mi\033[38;2;163;168;41m:\033[38;2;45;117;132m;\033[38;2;54;124;104m;\033[38;2;35;36;139m!\033[38;2;89;73;96mo\033[38;2;131;111;65mo\033[38;2;46;59;139mi\033[38;2;143;142;59mx\033[38;2;81;187;69ma\033[38;2;29;138;138mo\033[38;2;38;100;137m!\033[38;2;65;167;85mo\033[38;2;54;152;106mo\033[38;2;41;92;137mi\033[38;2;35;54;127m:\033[38;2;37;26;112m:\033[38;2;34;37;140mi\033[38;2;32;59;159mi\033[38;2;27;71;155m!\033[38;2;26;90;151mi\033[38;2;32;133;140mo\033[0m
\033[38;2;147;126;69m;\033[38;2;70;143;115mc\033[38;2;28;155;143mc\033[38;2;78;165;91mo\033[38;2;159;169;39m*\033[38;2;110;179;59ma\033[38;2;71;151;103mo\033[38;2;55;175;123mo\033[38;2;66;170;100mo\033[38;2;73;177;82mo\033[38;2;51;80;108mi\033[38;2;27;97;155mi\033[38;2;30;61;140m!\033[38;2;30;90;149mi\033[38;2;157;107;55ma\033[38;2;162;122;29m;\033[38;2;39;43;132m!\033[38;2;36;35;122m:\033[38;2;24;108;162m.\033[38;2;32;32;122m.\033[38;2;47;105;124mi\033[38;2;53;137;118mi\033[38;2;35;74;149mi\033[38;2;35;44;149m.\033[38;2;30;130;135m:\033[38;2;36;122;125m;\033[38;2;91;150;89mo\033[38;2;172;103;40m*\033[38;2;163;150;42mi\033[38;2;189;117;44m!\033[38;2;138;146;60m!\033[38;2;45;98;127m;\033[38;2;42;53;131m!\033[38;2;54;103;111m!\033[38;2;50;134;113m!\033[38;2;31;71;141m;\033[38;2;99;102;101mc\033[38;2;44;78;129mi\033[38;2;27;108;158mc\033[38;2;25;88;150mc\033[38;2;178;115;34m!\033[0m
\033[38;2;31;58;153m.\033[38;2;21;106;145m!\033[38;2;29;121;150mc\033[38;2;117;154;84m*\033[38;2;86;159;91ma\033[38;2;35;88;130mi\033[38;2;27;108;153m:\033[38;2;40;148;125mo\033[38;2;79;106;105mo\033[38;2;141;150;57mo\033[38;2;73;114;115m!\033[38;2;34;105;151m!\033[38;2;23;114;160mi\033[38;2;69;168;78mc\033[38;2;30;66;150m; \033[38;2;28;92;150m;\033[38;2;42;40;118m:\033[38;2;36;48;137m.\033[38;2;40;42;139m:\033[38;2;35;38;145m.\033[38;2;105;110;84m!\033[38;2;60;116;117mo\033[38;2;29;97;157m:\033[38;2;90;161;65m;\033[38;2;50;70;130m;\033[38;2;56;151;115mc\033[38;2;168;159;49mi  \033[38;2;128;161;54m!\033[38;2;75;143;95ma\033[38;2;115;89;70m;\033[38;2;113;193;63m;\033[38;2;120;157;69mo\033[38;2;60;123;131mo\033[38;2;27;86;154mo\033[38;2;26;90;139m!\033[38;2;27;85;156mi\033[38;2;38;34;130m;\033[38;2;165;135;32mo\033[0m
\033[38;2;145;86;60m:\033[38;2;42;87;137m;\033[38;2;27;117;141mc\033[38;2;40;162;129ma\033[38;2;39;148;131mo\033[38;2;73;144;84mi\033[38;2;28;67;158m:\033[38;2;28;94;167mc\033[38;2;29;85;155mo\033[38;2;29;114;148m;  \033[38;2;95;144;69m;  \033[38;2;141;123;62mc\033[38;2;117;154;61m!\033[38;2;152;148;55m*\033[38;2;97;103;89mc\033[38;2;82;180;72m;  \033[38;2;74;127;78m;\033[38;2;107;191;41m. \033[38;2;163;175;31mi\033[38;2;25;85;156m.   \033[38;2;39;111;133mi\033[38;2;58;97;92m;\033[38;2;38;36;135m!\033[38;2;30;68;155mi\033[38;2;30;53;131m!\033[38;2;42;26;120m:\033[38;2;30;77;154m!\033[38;2;36;31;106m:\033[38;2;47;75;107mc\033[38;2;36;49;142m;\033[0m
\033[38;2;147;89;62ma\033[38;2;66;105;121mc\033[38;2;143;160;57m*\033[38;2;36;107;147mi\033[38;2;122;114;77mo\033[38;2;146;121;75mi\033[38;2;27;95;174m.\033[38;2;26;95;151mi\033[38;2;91;85;86m!\033[38;2;166;179;31m.  \033[38;2;128;88;74m;     \033[38;2;115;180;35m.\033[38;2;201;156;18m: \033[38;2;187;188;23m.        \033[38;2;34;40;142m:\033[38;2;26;85;145m!\033[38;2;105;133;82mo\033[38;2;155;149;40m*\033[38;2;61;148;103mc\033[38;2;33;74;130mi\033[38;2;30;59;154mc\033[38;2;34;33;116m:\033[38;2;45;158;126mi\033[38;2;37;117;145mc\033[38;2;194;121;31m:\033[0m
 \033[38;2;182;144;36ma\033[38;2;95;181;57m*\033[38;2;84;180;66mo\033[38;2;171;182;26mo  \033[38;2;29;129;142m:\033[38;2;49;124;118m;   \033[38;2;165;64;49mc\033[38;2;189;78;35mo\033[38;2;26;65;150m.   \033[38;2;44;107;132m.\033[38;2;71;127;113mc\033[38;2;71;65;116m:          \033[38;2;54;123;121m;\033[38;2;68;141;115m;\033[38;2;186;53;32m.\033[38;2;140;58;71mi\033[38;2;157;55;50m!\033[38;2;155;127;65mo\033[38;2;63;126;112mc\033[38;2;46;159;127mo\033[38;2;85;189;64mo\033[38;2;175;156;30mo\033[0m
 \033[38;2;201;148;21ma\033[38;2;76;156;84m;\033[38;2;77;179;79ma\033[38;2;123;142;59mi  \033[38;2;44;90;124m:\033[38;2;108;148;68mc\033[38;2;128;188;45m:        \033[38;2;57;115;118m:\033[38;2;111;155;90mo\033[38;2;135;141;56m;\033[38;2;66;160;89m:\033[38;2;65;147;83m:       \033[38;2;90;145;74m:\033[38;2;122;72;88ma\033[38;2;31;85;148m: \033[38;2;145;91;74m.\033[38;2;51;97;127mi \033[38;2;106;138;74mi\033[38;2;125;119;62mo \033[38;2;207;68;32m.\033[0m
 \033[38;2;205;154;20m: \033[38;2;108;140;74ma    \033[38;2;112;156;73m!\033[38;2;131;179;51m;         \033[38;2;77;164;74m;\033[38;2;85;124;96mi\033[38;2;122;167;74mc\033[38;2;69;106;105m:         \033[38;2;87;184;58m.  \033[38;2;37;134;134m!\033[38;2;38;41;122m.\033[0m
   \033[38;2;125;107;64mc                \033[38;2;61;141;102m:\033[38;2;112;155;57mi\033[38;2;59;77;117mi\033[38;2;33;35;129m.           \033[38;2;132;161;66m!\033[38;2;64;73;108m.\033[0m
                  \033[38;2;95;136;46m.\033[38;2;144;120;72m!\033[38;2;74;154;89mc\033[38;2;156;121;39ma\033[38;2;148;125;59ma\033[38;2;100;142;99m;\033[0m
             \033[38;2;81;139;69m;\033[38;2;60;129;109mi\033[38;2;101;115;96mc  \033[38;2;92;162;60m.\033[38;2;163;141;61mo\033[38;2;119;121;90mo\033[38;2;30;59;146mi\033[38;2;29;68;155mo\033[38;2;28;79;151mi\033[38;2;44;23;114m.\033[38;2;132;124;77m!\033[38;2;33;85;148m.\033[0m
           \033[38;2;177;126;31mi\033[38;2;98;144;90ma\033[38;2;122;114;82mc\033[38;2;68;162;101mo\033[38;2;135;189;29m;\033[38;2;202;141;23m;\033[38;2;154;131;35m;\033[38;2;152;175;42mc\033[38;2;169;108;33mo\033[38;2;164;78;49mx\033[38;2;122;74;88mc\033[38;2;56;127;117mi\033[38;2;165;128;44mo\033[38;2;54;101;114mc\033[38;2;39;31;119m:\033[38;2;105;101;92mc\033[38;2;30;61;157m!\033[38;2;130;45;68mc\033[38;2;149;70;57mc\033[38;2;95;121;87mc\033[38;2;73;145;95mo\033[38;2;159;151;51mx\033[38;2;194;126;39mx\033[38;2;176;127;38ma\033[38;2;174;136;31m:\033[0m
      \033[38;2;82;178;68m.\033[38;2;99;141;69m;\033[38;2;68;90;118mc\033[38;2;138;126;73mo\033[38;2;97;100;81m:\033[38;2;56;31;110m.\033[38;2;21;124;154m:\033[38;2;204;112;34m;    \033[38;2;147;181;28m.\033[38;2;165;110;48m;\033[38;2;71;162;79m;\033[38;2;54;151;110m:\033[38;2;64;104;121m!\033[38;2;94;104;90m: \033[38;2;42;173;128m: \033[38;2;69;136;84m!\033[38;2;32;49;134mi\033[38;2;31;73;152m;\033[38;2;73;110;99mc\033[38;2;120;77;81mo\033[38;2;91;53;99m!\033[38;2;37;63;159m:\033[38;2;27;78;148m!\033[38;2;27;123;152m!\033[38;2;88;174;65mi\033[0m
                           \033[38;2;25;81;150m.\033[38;2;38;37;139m.     \033[38;2;36;37;144m. \033[38;2;116;166;54m!\033[38;2;65;78;109m:\033[38;2;107;97;90mc\033[0m
IVA_TREE
)"
  echo
}

# What this run replaces and has to be able to put back: the copy of .env and the build it
# overwrites. The checkout itself is never moved by this script - an installation that
# already exists is handed to the one updater (hand_installation_to_repair below).
# Declared before the traps, because the exit handler reads them on every path out.
INSTALL_UPDATE_ACTIVE=false
INSTALL_COMPLETE=false
INSTALL_ENV_BACKUP=""
INSTALL_OUTPUT_BACKUP=""
INSTALL_LOCK=""
INSTALL_DATA=""
SETUP_PID=""
# Set once the installation is known to hold the user's own state again — after a clean
# rollback, or after a finished install. Only then are the copies this run made duplicates
# that may be dropped.
INSTALL_TREE_RESTORED=false

# Two installers in one tree undo each other: the second replaces the build the first is
# still writing, and both restore over each other's work. A directory is the lock,
# because creating one is atomic everywhere. A lock whose owner is gone is taken over -
# a run killed by a power cut must not leave the installation unusable.
acquire_install_lock() {
  local lock owner=""
  # Путь замка обязан быть одним для всех, кто бежит над этим деревом: передача
  # обновлятору получает его явно, потому что старый чекаут может не уметь ответить,
  # где его data, а после ремонта ответил бы уже иначе.
  INSTALL_DATA="${1:-}"
  [ -n "$INSTALL_DATA" ] || INSTALL_DATA="$(
    cd "$PROJECT_DIR"
    node --input-type=module -e '
import { loadEnvFile } from "node:process";
import { join } from "node:path";
import { resolveDataDir } from "./packages/data-dir/index.ts";
const root = process.argv[1];
delete process.env.ASSISTANT_DATA_DIR;
try { loadEnvFile(join(root, ".env")); }
catch (cause) { if (cause?.code !== "ENOENT") throw cause; }
process.stdout.write(resolveDataDir(root, process.env.ASSISTANT_DATA_DIR));
' "$PROJECT_DIR" 2>/dev/null
  )" || INSTALL_DATA=""
  # Старый или оборванный чекаут может не иметь этого модуля - именно его сюда и
  # привели чинить. Замок тогда стоит на каталоге по умолчанию, а не валит ремонт.
  [ -n "$INSTALL_DATA" ] || INSTALL_DATA="$PROJECT_DIR/data"
  lock="$INSTALL_DATA/install.lock"
  mkdir -p "$INSTALL_DATA" 2>/dev/null || true
  if ! mkdir "$lock" 2>/dev/null; then
    # Not a rival installer at all — the directory could not be created here. The lock is a
    # guard rail, not a requirement, so say so and get on with the install.
    if [ ! -d "$lock" ]; then
      warn "$(t "Couldn't create the lock at $lock — continuing without it" "Не смог создать лок $lock — продолжаю без него")"
      return 0
    fi
    if [ -f "$lock/pid" ]; then
      owner="$(cat "$lock/pid" 2>/dev/null || true)"
      if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
        die "$(t "Another installer is already running here (pid $owner, lock: $lock). Wait for it to finish. To stop an interrupted install, run: kill -TERM $owner; then run the installer again." "Здесь уже работает другой установщик (pid $owner, лок: $lock). Дождитесь его. Чтобы остановить оборванную установку, выполните: kill -TERM $owner; затем запустите установщик снова.")"
      fi
    # No owner written yet: the installer that made this directory is a moment away from
    # writing its pid into it, and taking the lock now would run two of us. Only a lock
    # that has been sitting there for a minute is treated as abandoned.
    elif [ -z "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      die "$(t "Another installer is starting here (lock: $lock). Run this again in a moment." "Здесь запускается другой установщик (лок: $lock). Повторите через несколько секунд.")"
    fi
    warn "$(t "Taking over the lock of an installer that is no longer running: $lock" "Забираю лок установщика, которого больше нет: $lock")"
  fi
  INSTALL_LOCK="$lock"
  printf '%s\n' "$$" >"$lock/pid" 2>/dev/null || true
}

# Copies .env with the permissions it must have from the first byte: the part file is
# created under umask 077, so even the empty file that appears first is already 600. The
# chmod stays for a part left behind by a run of an older version, which could be 644.
# `cp -p` would have carried the source mode over, and a .env somebody left world-readable
# would be copied that way and stay so until the chmod — a window a shared box does not
# need. The copy appears at its final name only once it is whole, so a rollback can never
# restore half a file over a whole one.
copy_env_private() {
  local part="$1.part"
  (umask 077; : >"$part") 2>/dev/null || return 1
  chmod 600 "$part" 2>/dev/null || { rm -f -- "$part"; return 1; }
  cat "$PROJECT_DIR/.env" >"$part" 2>/dev/null || { rm -f -- "$part"; return 1; }
  mv -- "$part" "$1"
}

# Saves what this run is about to overwrite: the copy of .env, and from here on the backup
# of the .output the build replaces. Nothing else is this script's to save - the code of an
# installation that already exists it does not touch at all.
save_env_copy() {
  local stamp backups
  # Armed before the first artifact: a failure while preparing must reach the same rollback
  # as any later one, or what it just wrote is orphaned and the cleanup reports changes it
  # never took.
  INSTALL_UPDATE_ACTIVE=true
  stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"

  # The copies live next to the installation, not in /tmp: `iva update` keeps its own
  # copy of .env in data/update-backups/ for the same reason — a world-readable directory
  # is no place for the file that holds every key.
  backups="$INSTALL_DATA/update-backups"
  if ! (mkdir -p "$backups" 2>/dev/null && chmod 700 "$backups" 2>/dev/null); then
    backups=""
  fi
  [ -f "$PROJECT_DIR/.env" ] || return 0
  local candidate
  if [ -n "$backups" ]; then
    candidate="$backups/.env-$stamp"
  else
    candidate="$(mktemp "${TMPDIR:-/tmp}/iva-env.XXXXXX")"
  fi
  # Named only once the copy is whole: a backup nobody could finish must not be one the
  # rollback trusts. And an install that cannot preserve .env has no business going on to
  # replace the build. The empty file mktemp already made goes with it, or a run that
  # never copied anything would leave a stub behind in /tmp.
  copy_env_private "$candidate" || {
    rm -f -- "$candidate"
    die "$(t "Cannot copy $PROJECT_DIR/.env — check its permissions and free space, then run again." "Не могу скопировать $PROJECT_DIR/.env — проверьте права и свободное место, потом запустите снова.")"
  }
  INSTALL_ENV_BACKUP="$candidate"
}

rollback_install_update() {
  [ "$INSTALL_UPDATE_ACTIVE" = true ] || return 0
  INSTALL_UPDATE_ACTIVE=false
  set +e
  local restored=true
  if [ -n "$INSTALL_ENV_BACKUP" ] && [ -f "$INSTALL_ENV_BACKUP" ]; then
    if cat "$INSTALL_ENV_BACKUP" >"$PROJECT_DIR/.env"; then
      chmod 600 "$PROJECT_DIR/.env"
    else
      restored=false
    fi
  fi
  # Cleared only once the build is really back in place: a backup still on disk is the only
  # copy of the previous build, and the cleanup is about to remove whatever this still names.
  if [ -n "$INSTALL_OUTPUT_BACKUP" ] && [ -e "$INSTALL_OUTPUT_BACKUP" ]; then
    rm -rf -- "$PROJECT_DIR/.output"
    if mv "$INSTALL_OUTPUT_BACKUP" "$PROJECT_DIR/.output"; then
      INSTALL_OUTPUT_BACKUP=""
    else
      restored=false
    fi
  fi
  INSTALL_TREE_RESTORED="$restored"
  set -e
}

# Removes what this run created, on success and on failure alike. Called last, so a
# rollback has already read the copies back into the installation. They are dropped only
# once it holds the user's state again; if the rollback could not finish, they stay and are
# named, because a recoverable mess beats lost work.
cleanup_install_artifacts() {
  set +e
  cleanup_verified_download
  if [ "$INSTALL_TREE_RESTORED" = true ]; then
    [ -z "$INSTALL_ENV_BACKUP" ] || rm -f -- "$INSTALL_ENV_BACKUP"
    INSTALL_ENV_BACKUP=""
    [ -z "$INSTALL_OUTPUT_BACKUP" ] || rm -rf -- "$INSTALL_OUTPUT_BACKUP"
    INSTALL_OUTPUT_BACKUP=""
  else
    # Nothing this run saved is removed while the installation is not back to what it was:
    # each of these may be the only copy left, so they are kept and named instead.
    [ -z "$INSTALL_ENV_BACKUP" ] || warn "$(t "Your .env is copied at $INSTALL_ENV_BACKUP" "Копия вашего .env: $INSTALL_ENV_BACKUP")"
    [ -z "$INSTALL_OUTPUT_BACKUP" ] || warn "$(t "Your previous build is kept at $INSTALL_OUTPUT_BACKUP" "Прежняя сборка сохранена в $INSTALL_OUTPUT_BACKUP")"
  fi
  [ -z "$INSTALL_LOCK" ] || rm -rf -- "$INSTALL_LOCK"
  INSTALL_LOCK=""
  set -e
}

finish_install_update() {
  [ "$INSTALL_UPDATE_ACTIVE" = true ] || return 0
  INSTALL_UPDATE_ACTIVE=false
  INSTALL_TREE_RESTORED=true
  cleanup_install_artifacts
}

# repair.sh of the channel this installer came from. An installation that is stuck holds a
# repair.sh of the release it is stuck on, and that is the one file here that must not be
# old - so it comes from the same REPO_URL and BRANCH as the installer itself.
repair_script_url() {
  local repo="${REPO_URL%.git}" path=""
  case "$repo" in
    https://github.com/*) path="${repo#https://github.com/}" ;;
    git@github.com:*) path="${repo#git@github.com:}" ;;
    ssh://git@github.com/*) path="${repo#ssh://git@github.com/}" ;;
    *) return 1 ;;
  esac
  printf 'https://raw.githubusercontent.com/%s/%s/repair.sh' "$path" "$BRANCH"
}

# One updater: over an installation that already exists this script updates nothing itself.
# It hands the tree to repair.sh, which is where `iva update`, the bridge and the repair
# command all go, and exits with what came back. The installer keeps no second copy of that
# route - and no second answer to whether a tree may be updated at all.
# IVA_BETA=1 над существующей установкой: выбор - в зеркало и .git до передачи обновлятору.
record_beta_choice() {
  [ "${IVA_BETA:-}" = 1 ] || return 0
  local repo
  for repo in "$INSTALL_DIR/repo" "$INSTALL_DIR/.git"; do
    [ -e "$repo" ] || continue
    git --git-dir="$repo" config --local iva.updateBranch beta
    git --git-dir="$repo" config --local iva.beta true
  done
}

hand_installation_to_repair() {
  local url script rc=0
  url="$(repair_script_url)" || die "$(t "REPO_URL is not a GitHub repository of the project, so there is no repair.sh to update $INSTALL_DIR with: run 'iva update' yourself." "REPO_URL не репозиторий проекта на GitHub, взять repair.sh для обновления $INSTALL_DIR неоткуда: запустите 'iva update' сами.")"
  cleanup_verified_download
  VERIFIED_DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/iva-repair-XXXXXX")" \
    || die "$(t "Cannot create a temporary directory in ${TMPDIR:-/tmp}" "Не могу создать временный каталог в ${TMPDIR:-/tmp}")"
  script="$VERIFIED_DOWNLOAD_DIR/repair.sh"
  VERIFIED_DOWNLOAD="$script"
  curl -fsSL "$url" -o "$script" \
    || die "$(t "Couldn't download $url — check the network and run again." "Не удалось скачать $url — проверьте сеть и запустите снова.")"
  step "$(t "Iva is already installed in $INSTALL_DIR — handing it to the updater" "Iva уже установлена в $INSTALL_DIR — передаю обновлятору")"
  if IVA_INSTALL_DIR="$INSTALL_DIR" AGENT_LANGUAGE="$IVA_LANG" bash "$script"; then rc=0; else rc=$?; fi
  if [ "$rc" -eq 0 ]; then rm -f -- "$INSTALL_DIR/.iva-installing"; fi
  # Отменять нечего: дерева этот ход не касался, всю работу сделал обновлятор, и его код
  # возврата - ответ всей команды.
  INSTALL_COMPLETE=true
  exit "$rc"
}

# Loud error handler: no more silent exits from set -e.
# Pulled into a function so it can be temporarily removed/restored around foreign code
# (nvm normally does `return <non-zero>` internally — without removing the trap that's a false alarm).
# Restoring and cleaning up is NOT done here: `cmd || die` handles the failure itself and
# exits, so the ERR trap never sees it. The EXIT trap below is the one path every failure
# takes, so that is where rollback and temp-file removal live.
on_err() {
  local rc=$?
  stop_spinner
  # Reporting must not become the failure. With no terminal left to print to every line
  # below fails, and under errexit the first one would end the run with its own status
  # instead of the one that actually broke. `set +e` is not the fix here: it would outlive
  # the handler and leave the rest of the script running unchecked.
  {
    echo
    echo "${c_red}✗ $(t "Install aborted (code $rc). Failing command: ${BASH_COMMAND}" "Установка прервалась (код $rc). Упала команда: ${BASH_COMMAND}")${c_reset}"
    echo "${c_yellow}  $(t "Full log:" "Полный лог:") $INSTALL_LOG${c_reset}"
  } >&2 2>/dev/null || true
}
# The single exit path: `die`, errexit, Ctrl-C, a dropped SSH session and SIGTERM all end
# up here, so no run leaves its copy of .env or of the previous build behind.
# The rollback is decided by INSTALL_COMPLETE and not by the exit code: the code is right
# for every route this script traps, but bash enters this handler with $? = 0 for the fatal
# signals nothing traps, and a run that died on one of those is exactly the one that must
# put the checkout back.
finalize_install() {
  local rc=$?
  # The undo runs commands that fail as a matter of course — putting the previous build
  # back onto a read-only or full disk is the usual one — and the ERR trap does not care
  # that `set +e` is on. Left armed it prints a second "Install aborted" over the real
  # cause, which is how the reason for a failure gets lost.
  trap - ERR
  # Nothing in here may end the handler early: this is the only path that puts the
  # checkout back, and it runs while something has already gone wrong.
  set +e
  # A log that stopped being writable mid-run must not take the rollback down with it: the
  # redirects below would fail before their commands ever ran.
  if [ -n "$SETUP_PID" ]; then
    kill -TERM "$SETUP_PID" 2>/dev/null
    wait "$SETUP_PID" 2>/dev/null
    SETUP_PID=""
  fi
  : >>"$INSTALL_LOG" 2>/dev/null || INSTALL_LOG=/dev/null
  stop_spinner
  if [ "$INSTALL_COMPLETE" != true ]; then
    # Silent when nothing was started yet — `--help` and a refused flag exit this way.
    if [ "$rc" -ne 0 ] || [ "$INSTALL_UPDATE_ACTIVE" = true ]; then
      echo "${c_red}✗ $(t "Install stopped during: $CURRENT_STEP" "Установка остановилась на шаге: $CURRENT_STEP")${c_reset}" >&2
    fi
    rollback_install_update
  fi
  cleanup_install_artifacts
}
trap on_err ERR
trap finalize_install EXIT
trap 'stop_spinner; exit 130' INT
trap 'stop_spinner; exit 143' TERM
trap 'stop_spinner; exit 129' HUP

# ── Interactivity mode (modeled on NousResearch/hermes-agent) ──────────────
# Do NOT `exec < /dev/tty`: with `curl | bash`, bash reads the script ITSELF from the stdin pipe,
# and reassigning FD0 would break reading the rest of it. Instead, feed input pointwise
# to each interactive consumer from /dev/tty, and probe for a terminal by trying to open it.
RUN_SETUP=true
NON_INTERACTIVE=false
ENV_FILE=""
if [ -t 0 ]; then IS_INTERACTIVE=true; else IS_INTERACTIVE=false; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-setup)      RUN_SETUP=false ;;
    --non-interactive) NON_INTERACTIVE=true; RUN_SETUP=false ;;
    --env-file)
      [ -n "${2:-}" ] && [ -f "$2" ] && [ -r "$2" ] || die '--env-file requires a readable file'
      NON_INTERACTIVE=true
      ENV_FILE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift ;;
    -h|--help)
      sed -n '2,22p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) warn "$(t "unknown flag: $1 (ignoring)" "неизвестный флаг: $1 (игнорирую)")" ;;
  esac
  shift
done

# Does the terminal actually open? (in a Docker build the /dev/tty node exists, but open gives ENXIO).
have_tty() { (: < /dev/tty) 2>/dev/null; }

# Один разбор ответа на все вопросы мастера: пробелы по краям и хвостовая пунктуация
# пункта меню («2.», «2)», «да.») не меняют ответ. Разбор один на все вопросы, чтобы
# «да» и «2.» понимались одинаково везде.
answer_token() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:].)]*$//'
}

# y/n question with a default; input source: stdin-tty → /dev/tty → default.
prompt_yes_no() {
  local question="$1" default="${2:-no}" suffix answer=""
  case "$default" in [yY]*|1|true) suffix="[Y/n]" ;; *) suffix="[y/N]" ;; esac
  if   [ "$NON_INTERACTIVE" = true ]; then answer=""
  elif [ "$IS_INTERACTIVE" = true ]; then read -r -p "$question $suffix " answer || answer=""
  elif have_tty; then printf '%s %s ' "$question" "$suffix" > /dev/tty; IFS= read -r answer < /dev/tty || answer=""
  else answer=""; fi
  answer="$(answer_token "$answer")"
  if [ -z "$answer" ]; then
    case "$default" in [yY]*|1|true) return 0 ;; *) return 1 ;; esac
  fi
  # Явные строки, не диапазоны: на чистой Debian/Ubuntu локаль POSIX, и `[дД]` в case
  # сравнивает байты — кириллица не совпадает (проверено под LC_ALL=C).
  case "$answer" in
    y|Y|yes|Yes|yEs|yeS|YEs|YeS|yES|YES|д|Д|да|Да|дА|ДА) return 0 ;;
    *) return 1 ;;
  esac
}

# Language is the VERY FIRST question, before any system work. Bilingual prompt, default English.
# We store the choice in AGENT_LANGUAGE and export it → setup.mjs and init-vault.mjs pick it up,
# so the language is asked exactly once.
pick_language() {
  local ans="" default_lang="en" existing_env=""
  if [ -n "${ENV_FILE:-}" ]; then existing_env="$ENV_FILE"
  elif [ -f "$INSTALL_DIR/.env" ]; then existing_env="$INSTALL_DIR/.env"
  elif [ -f "./.env" ]; then existing_env="./.env"
  fi
  if [ -n "$existing_env" ]; then
    local saved_lang
    saved_lang="$(grep -E '^AGENT_LANGUAGE=' "$existing_env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' || true)"
    case "$saved_lang" in en|ru) default_lang="$saved_lang" ;; esac
  fi
  if [ "$NON_INTERACTIVE" != true ]; then
    printf '\n  %b🌐 Language / Язык%b\n' "${c_bold}${c_blue}" "$c_reset"
    if [ "$default_lang" = ru ]; then
      printf '    [1] English\n    [2] Русский  %b(current/default)%b\n' "$c_green" "$c_reset"
    else
      printf '    [1] English  %b(current/default)%b\n    [2] Русский\n' "$c_green" "$c_reset"
    fi
    if   [ "$IS_INTERACTIVE" = true ]; then read -r -p "  > " ans || ans=""
    elif have_tty; then printf '  > ' > /dev/tty; IFS= read -r ans < /dev/tty || ans=""
    else ans=""; fi
  fi
  case "$(answer_token "$ans")" in
    2|ru|RU|рус*|Рус*|РУС*|ру|Ру|РУ) IVA_LANG=ru ;;
    1|en|EN) IVA_LANG=en ;;
    *) IVA_LANG="$default_lang" ;;
  esac
  export AGENT_LANGUAGE="$IVA_LANG"
}

echo
show_tree
pick_language   # ← first question: language (default English), before any install
echo "  ${c_green}Iva${c_reset} — $(t "your personal long-term-memory agent that just works" "личный агент с долговременной памятью, который просто работает")"
echo "  ─────────────────────────────────────────────"

# Where the code is, decided here because the checks below need to know whether this is
# a first install or a re-run over one that already exists (section 4 uses it too).
SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [ -n "$SOURCE" ] && [ -f "$SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
fi
# Layout owns the route. Disabled units do not change the identity of an installation.
iva_checkout() {
  [ -d "$1/.git" ] && [ -f "$1/package.json" ] && grep -q '"eve"' "$1/package.json"
}
versioned_installation() {
  [ -d "$1/versions" ] && { [ -e "$1/current" ] || [ -L "$1/current" ]; }
}
RESUME_FIRST_INSTALL=false
if iva_checkout "$INSTALL_DIR" \
  && { grep -qx 'autostart=false' "$INSTALL_DIR/.iva-installed" 2>/dev/null \
    || { [ -f "$INSTALL_DIR/.iva-installing" ] && [ ! -f "$INSTALL_DIR/.iva-installed" ]; }; }; then
  RESUME_FIRST_INSTALL=true
fi
INSTALL_EXISTS=false
if versioned_installation "$INSTALL_DIR" || { iva_checkout "$INSTALL_DIR" && [ "$RESUME_FIRST_INSTALL" = false ]; }; then
  INSTALL_EXISTS=true
fi
# A foreign or incomplete layout must be left intact, including its hidden files.
if { [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; } \
  && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ] \
  && ! iva_checkout "$INSTALL_DIR" && ! versioned_installation "$INSTALL_DIR"; then
  printf -v occupied_path '%q' "$INSTALL_DIR"
  die "$(t "INSTALL_DIR is occupied by an unrecognized tree. Inspect it: ls -la $occupied_path" "INSTALL_DIR занят неизвестным деревом. Осмотрите его: ls -la $occupied_path")"
fi

if [ -n "$ENV_FILE" ] && [ "$INSTALL_EXISTS" = true ]; then
  die "$(t '--env-file is for a first install only; use iva config for this installation.' '--env-file доступен только при первой установке; для этой установки выполните iva config.')"
fi

# A pending reboot after a kernel upgrade is a dead end for a first install: needrestart
# draws its ncurses dialog inside every apt run below — including the ones agent-browser
# makes on its own, where the environment above cannot reach — and the install stops there
# forever. Stop now, while the fix is still one command. bootstrap.sh offers this reboot at
# its end. Over an existing installation this is a warning instead: unattended-upgrades
# (which bootstrap.sh switches on) leaves the same flag behind for any security update, and
# a re-run that installs no packages at all must not be refused for days on end.
# needrestart only draws its dialog for a new kernel, so that is the case worth naming
# apart. The file lists one package per line; anything else in it means nothing here.
reboot_needs_kernel() { grep -q '^linux-' "$1" 2>/dev/null; }
# The path is a variable so the two answers can be tested without a real pending reboot.
REBOOT_FLAG="${IVA_REBOOT_FLAG:-/var/run/reboot-required}"
if [ -e "$REBOOT_FLAG" ]; then
  reboot_kernel=false
  if reboot_needs_kernel "$REBOOT_FLAG.pkgs"; then reboot_kernel=true; fi
  if [ "$INSTALL_EXISTS" != true ]; then
    die "$(t "The system was updated but the server has not been rebooted, and package installs will hang. Run: sudo reboot — then reconnect and run this installer again." "Система обновилась, но сервер не перезагружен — установка пакетов зависнет. Выполните: sudo reboot — потом переподключитесь и запустите установщик снова.")"
  elif [ "$reboot_kernel" = true ]; then
    warn "$(t "The kernel was updated and the server has not been rebooted. If this run installs packages, it can hang — reboot first (sudo reboot) if it does." "Ядро обновилось, а сервер не перезагружен. Если этот запуск будет ставить пакеты, он может зависнуть — тогда сначала перезагрузитесь (sudo reboot).")"
  else
    warn "$(t "A reboot is pending after a system update — installing packages may hang until you run: sudo reboot" "После обновления системы ждёт перезагрузка — установка пакетов может зависнуть, пока не выполните: sudo reboot")"
  fi
fi

# root runs directly; otherwise via sudo (cache the password once).
run_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; elif have_tty; then sudo "$@"; else sudo -n "$@"; fi; }
HEADLESS_SUDO=false
if [ "$(id -u)" -ne 0 ] && [ "$IVA_OS" != Darwin ] && ! have_tty && ! sudo -n true 2>/dev/null; then
  HEADLESS_SUDO=true
  warn "$(t 'sudo needs a terminal; run bootstrap.sh as root to prepare system packages, then retry installation.' 'sudo требует TTY; выполните bootstrap.sh от root для установки системных пакетов, затем повторите установку.')"
fi

# apt through plain run_root would lose DEBIAN_FRONTEND/NEEDRESTART_MODE the moment sudo
# resets the environment, so pass them through `env` — which runs as root and hands them
# straight to apt-get. Use this for every apt-get call, never run_root apt-get.
# The three options are bootstrap.sh's: unattended-upgrades holding the dpkg lock is a
# wait, not a failure, and a changed config file is a question nobody can answer behind
# the spinner.
apt_get() {
  run_root env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get \
    -o DPkg::Lock::Timeout=300 \
    -o Dpkg::Options::=--force-confdef \
    -o Dpkg::Options::=--force-confold \
    "$@"
}

# ── Swap for weak VPSes ($4 DigitalOcean droplet = 512MB RAM) ──────────────
# On low RAM without swap, npm install and especially `eve build` (rolldown+nitro+node)
# fail with OOM — the kernel kills the process (Killed, code 137). If RAM < ~1.5GB and
# there's no swap — set up a 2GB swapfile BEFORE the heavy steps. Idempotent: don't touch
# active swap, just enable an existing /swapfile, and don't duplicate it in fstab.
ensure_swap() {
  local ram_mb swap_mb free_mb total
  ram_mb=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
  swap_mb=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
  [ "${ram_mb:-0}" -ge 1500 ] && return 0          # enough memory
  [ "${swap_mb:-0}" -ge 1024 ] && return 0          # swap already present
  step "$(t "Low RAM (${ram_mb}MB), no swap — adding a 2GB swapfile so the build won't get OOM-killed…" "Мало RAM (${ram_mb}МБ), свопа нет — добавляю swapfile 2GB, чтобы сборку не убил OOM…")"
  if [ ! -f /swapfile ]; then
    free_mb=$(df -Pm / 2>/dev/null | awk 'NR==2{print $4}')
    if [ "${free_mb:-0}" -lt 2600 ]; then
      warn "$(t "Not enough free disk for a 2GB swapfile (${free_mb}MB free) — skipping. The build may OOM; free up space or use a bigger droplet." "Мало места под swapfile 2GB (свободно ${free_mb}МБ) — пропускаю. Сборка может упасть по OOM; освободите место или возьмите дроплет побольше.")"
      return 0
    fi
    run_root sh -c 'fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none' \
      || { warn "$(t "couldn't allocate /swapfile — skipping swap" "не смог создать /swapfile — пропускаю своп")"; return 0; }
    run_root chmod 600 /swapfile
    run_root mkswap /swapfile >/dev/null 2>&1 || { warn "mkswap failed — skipping swap"; return 0; }
  fi
  run_root swapon /swapfile 2>/dev/null || { warn "swapon failed — skipping swap"; return 0; }
  grep -qE '^[[:space:]]*/swapfile[[:space:]]' /etc/fstab 2>/dev/null \
    || echo '/swapfile none swap sw 0 0' | run_root tee -a /etc/fstab >/dev/null
  total=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo "?")
  ok "$(t "Swap on (${total}MB total) — build will have headroom" "Своп включён (всего ${total}МБ) — сборке хватит памяти")"
}
if [ "$IVA_OS" != Darwin ]; then ensure_swap; fi

# ─────────────────────────────────────────────────────────────────────────
# 1. System dependencies. Detect-then-install.
#    ffmpeg is optional (nova-3 usually accepts video directly); pandoc/poppler are for
#    extracting text from incoming docx/pdf files.
# ─────────────────────────────────────────────────────────────────────────
command -v curl >/dev/null || die "$(t "curl is required (install: apt/brew install curl)" "нужен curl (установи: apt/brew install curl)")"

PM="none"
if [ "$IVA_OS" = Darwin ]; then
  command -v brew >/dev/null 2>&1 || die "$(t 'Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" then run this installer again.' 'Установите Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" и запустите установщик снова.')"
  launchctl print "gui/$(id -u)" >/dev/null 2>&1 || die "macOS: войдите в систему на экране этого Mac — службы Ивы живут в вашей сессии"
  PM="brew"
elif command -v apt-get >/dev/null 2>&1; then PM="apt"
elif command -v dnf     >/dev/null 2>&1; then PM="dnf"
elif command -v brew    >/dev/null 2>&1; then PM="brew"
fi

# GitHub CLI is useful only for setting up the optional vault backup. Keep its repository
# private to this attempt: a failed third-party source must never add, replace or delete
# shared apt configuration.
OPTIONAL_GH_APT_CLEANUP_DEBT=""
install_optional_gh_apt() {
  local tmp_root="${TMPDIR:-/tmp}" apt_tmp="" keyring="" source="" lists="" rc=0
  local cleanup_rc=0
  local -a apt_options=()
  tmp_root="${tmp_root%/}"
  apt_tmp="$(mktemp -d "$tmp_root/iva-gh-apt-XXXXXX")" || return
  keyring="$apt_tmp/githubcli-archive-keyring.gpg"
  source="$apt_tmp/github-cli.list"
  lists="$apt_tmp/lists"

  mkdir -p "$lists" || rc=$?
  if [ "$rc" -eq 0 ]; then chmod 0755 "$apt_tmp" "$lists" || rc=$?; fi
  if [ "$rc" -eq 0 ]; then
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg >"$keyring" || rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    printf '%s\n' "deb [arch=$(dpkg --print-architecture) signed-by=$keyring] https://cli.github.com/packages stable main" \
      >"$source" || rc=$?
  fi
  if [ "$rc" -eq 0 ]; then chmod 0644 "$keyring" "$source" || rc=$?; fi

  apt_options=(
    -o "Dir::Etc::sourcelist=$source"
    -o "Dir::Etc::sourceparts=-"
    -o "Dir::State::lists=$lists"
    -o APT::Get::List-Cleanup=0
  )
  if [ "$rc" -eq 0 ]; then apt_get "${apt_options[@]}" update -qq || rc=$?; fi
  if [ "$rc" -eq 0 ]; then apt_get "${apt_options[@]}" install -y -qq gh || rc=$?; fi

  # apt may leave root-owned list files. Retry one transient cleanup failure. Keep the
  # install outcome separate from cleanup debt so a ready gh is never reported as missing.
  if ! run_root rm -rf -- "$apt_tmp"; then
    run_root rm -rf -- "$apt_tmp" || cleanup_rc=$?
  fi
  if [ "$cleanup_rc" -ne 0 ]; then OPTIONAL_GH_APT_CLEANUP_DEBT="$apt_tmp"; fi
  return "$rc"
}

install_optional_gh() {
  case "$PM" in
    apt) install_optional_gh_apt ;;
    dnf) run_root dnf install -y -q gh ;;
    brew) brew install gh </dev/null ;;
    *) return 1 ;;
  esac
}

# A dpkg left half-way through (a reboot during unattended-upgrade) makes every apt run
# fail, including the ones agent-browser starts on its own for Chromium's libraries —
# where the failure is only a warning, so the install would keep going for minutes and
# die on a later step with the real cause scrolled away. Diagnose only: repairing another
# tool's package database is the administrator's call, not the installer's.
# A whole package database makes `dpkg --audit` say nothing at all. Blank lines are not an
# answer either way, so only real characters count as a report.
dpkg_state_is_broken() { [ -n "$(printf '%s' "$1" | tr -d '[:space:]')" ]; }
if [ "$PM" = "apt" ] && command -v dpkg >/dev/null 2>&1; then
  CURRENT_STEP="$(t "package system check" "проверка пакетной системы")"
  dpkg_audit="$(dpkg --audit 2>/dev/null || true)"
  if dpkg_state_is_broken "$dpkg_audit"; then
    echo "$dpkg_audit" >&2
    die "$(t "The package system is half-way through an interrupted install, so no package can be installed now. Repair it first: sudo dpkg --configure -a — then run this installer again." "Пакетная система осталась в незавершённом состоянии после прерванной установки — поставить пакеты сейчас нельзя. Сначала почините: sudo dpkg --configure -a — потом запустите установщик снова.")"
  fi
fi

need_pkgs=()
command -v git    >/dev/null 2>&1 || need_pkgs+=("git")
command -v python3>/dev/null 2>&1 || need_pkgs+=("python3")
command -v ffmpeg >/dev/null 2>&1 || need_pkgs+=("ffmpeg")
command -v pandoc >/dev/null 2>&1 || need_pkgs+=("pandoc")
if ! command -v pdftotext >/dev/null 2>&1; then
  # The package name depends on the manager: brew → poppler, apt/dnf → poppler-utils.
  case "$PM" in brew) need_pkgs+=("poppler") ;; *) need_pkgs+=("poppler-utils") ;; esac
fi

if [ "${#need_pkgs[@]}" -gt 0 ]; then
  if [ "$PM" = "none" ]; then
    warn "$(t "no package manager found — install manually: ${need_pkgs[*]}" "не найден пакетный менеджер — установи вручную: ${need_pkgs[*]}")"
    command -v git >/dev/null 2>&1 || die "$(t "git is required to install" "git обязателен для установки")"
  else
    step "$(t "Need system packages: ${need_pkgs[*]} (via $PM)" "Нужны системные пакеты: ${need_pkgs[*]} (через $PM)")"
    # Cache the sudo password once up front (if not root and sudo is needed).
    if [ "$(id -u)" -ne 0 ] && [ "$PM" != "brew" ]; then
      if have_tty; then sudo -v; else sudo -n -v; fi || warn "$(t "sudo unavailable — system packages may not install" "sudo недоступен — системные пакеты могут не установиться")"
    fi
    case "$PM" in
      apt)
        apt_get update -qq || warn "$(t "apt-get update failed" "apt-get update не прошёл")"
        for p in "${need_pkgs[@]}"; do
          apt_get install -y -qq "$p" || warn "$(t "couldn't install $p" "не удалось поставить $p")"
        done
        ;;
      dnf)
        run_root dnf install -y -q "${need_pkgs[@]}" || warn "$(t "some packages didn't install (${need_pkgs[*]})" "часть пакетов не установилась (${need_pkgs[*]})")"
        ;;
      brew)
        for p in "${need_pkgs[@]}"; do brew install "$p" </dev/null || warn "$(t "couldn't install $p" "не удалось поставить $p")"; done
        ;;
    esac
  fi
fi
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || die "$(t "git still not installed" "git так и не установлен")"
if command -v gh >/dev/null 2>&1; then
  ok "$(t "gh ready" "gh готов")"
else
  step "$(t "Installing optional GitHub CLI…" "Устанавливаю необязательный GitHub CLI…")"
  if [ "$HEADLESS_SUDO" != true ]; then install_optional_gh >>"$INSTALL_LOG" 2>&1 || true; fi
  if command -v gh >/dev/null 2>&1; then
    ok "$(t "gh ready" "gh готов")"
    if [ -n "$OPTIONAL_GH_APT_CLEANUP_DEBT" ]; then
      warn "$(t "GitHub CLI is ready, but private apt cleanup failed; retained directory: $OPTIONAL_GH_APT_CLEANUP_DEBT" "GitHub CLI готов, но приватный apt-каталог не удалился; сохранённый каталог: $OPTIONAL_GH_APT_CLEANUP_DEBT")"
    fi
  else
    if [ -n "$OPTIONAL_GH_APT_CLEANUP_DEBT" ]; then
      warn "$(t "GitHub CLI could not be installed, and private apt cleanup failed; retained directory: $OPTIONAL_GH_APT_CLEANUP_DEBT" "GitHub CLI не установился, и приватный apt-каталог не удалился; сохранённый каталог: $OPTIONAL_GH_APT_CLEANUP_DEBT")"
    else
      warn "$(t "GitHub CLI is optional and could not be installed; continuing without it" "GitHub CLI необязателен и не установился; продолжаю без него")"
    fi
  fi
fi
command -v ffmpeg >/dev/null 2>&1 && ok "$(t "ffmpeg ready" "ffmpeg готов")" || warn "$(t "no ffmpeg (nova-3 usually accepts video directly)" "ffmpeg нет (nova-3 обычно принимает видео напрямую)")"

# ─────────────────────────────────────────────────────────────────────────
# 2. uv (Python manager for the vault's autograph scripts)
# ─────────────────────────────────────────────────────────────────────────
if command -v uv >/dev/null 2>&1 || [ -x "$HOME/.local/bin/uv" ]; then
  ok "$(t "uv already installed" "uv уже установлен")"
else
  step "$(t "Installing uv…" "Устанавливаю uv…")"
  download_verified uv "$UV_INSTALLER_URL" "$UV_INSTALLER_SHA256" \
    || die "$(t "uv download or SHA-256 verification failed" "Загрузка uv или проверка SHA-256 не прошла")"
  sh "$VERIFIED_DOWNLOAD"
  cleanup_verified_download
fi
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null 2>&1 && ok "uv $(uv --version 2>/dev/null | awk '{print $2}')" || warn "$(t "uv not on PATH — open a new shell" "uv не на PATH — откройте новый шелл")"

# ─────────────────────────────────────────────────────────────────────────
# 3. Node 24+ (via nvm, no root)
# ─────────────────────────────────────────────────────────────────────────
need_node=1
if command -v node >/dev/null; then
  major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$major" -ge "$NODE_MAJOR_MIN" ]; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  step "$(t "Installing Node $NODE_MAJOR_MIN+ via nvm…" "Устанавливаю Node $NODE_MAJOR_MIN+ через nvm…")"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    download_verified nvm "$NVM_INSTALLER_URL" "$NVM_INSTALLER_SHA256" \
      || die "$(t "nvm download or SHA-256 verification failed" "Загрузка nvm или проверка SHA-256 не прошла")"
    bash "$VERIFIED_DOWNLOAD"
    cleanup_verified_download
  fi
  # IMPORTANT: nvm normally does `return <non-zero>` internally (especially with an npm `prefix`
  # in ~/.npmrc — common with ~/.npm-global). So that this does NOT crash the install or
  # print a false "error", remove the ERR trap and errexit for the duration of nvm. We don't
  # call `nvm use` at all — we take node straight from the version directory.
  trap - ERR
  set +e
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MAJOR_MIN"
  NODE_BIN_DIR="$(nvm which "$NODE_MAJOR_MIN" 2>/dev/null | xargs -r dirname 2>/dev/null)"
  set -e
  trap on_err ERR
  if [ -z "${NODE_BIN_DIR:-}" ]; then
    NODE_BIN_DIR="$(ls -d "$NVM_DIR"/versions/node/v"$NODE_MAJOR_MIN"*/bin 2>/dev/null | sort -V | tail -1)"
  fi
  if [ -n "${NODE_BIN_DIR:-}" ]; then export PATH="$NODE_BIN_DIR:$PATH"; fi
fi
command -v node >/dev/null 2>&1 || die "$(t "Node $NODE_MAJOR_MIN+ failed to install. Install it manually (nvm install $NODE_MAJOR_MIN) and re-run." "Node $NODE_MAJOR_MIN+ не установился. Поставьте вручную (nvm install $NODE_MAJOR_MIN) и перезапустите.")"
ok "Node $(node -v)"

# Новая установка и ремонт ставят новейший выпуск (метку vX.Y.Z на ветке, ADR-0017), если
# он не старше первого выпуска с бета-обновлениями, иначе вершину ветки; IVA_BETA=1 или
# iva.beta=true — вершину. Ветка остаётся той же: за ней следит обновлятор. Та же функция
# стоит в install.sh и repair.sh: оба запускаются через curl | bash и самодостаточны.
checkout_release() {
  local first="0.4.9" tag target="${3:-HEAD}"
  if [ "${IVA_BETA:-}" = 1 ]; then git -C "$1" config --local iva.beta true; fi
  # Бета - ветка beta или прежний флаг (ADR-0018): вершина. Иначе новейший выпуск.
  if [ "$(git -C "$1" config --local --get iva.beta || true)" != true ] \
    && [ "$(git -C "$1" config --local --get iva.updateBranch || true)" != beta ]; then
    tag="$(git -C "$1" tag --list 'v*' --merged "$target" --sort=-v:refname \
      | grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' | head -n 1 || true)"
    if [ -n "$tag" ] && [ "$(printf '%s\n%s\n' "$first" "${tag#v}" | sort -V | head -n 1)" = "$first" ]; then target="$tag"; fi
  fi
  # $2 - коммит, стоявший до ремонта: новее цели (её потомок) - он и остаётся.
  if [ -n "${2:-}" ] && git -C "$1" merge-base --is-ancestor "$target" "$2" 2>/dev/null; then target="$2"; fi
  git -C "$1" reset -q --hard "$target"
}

# ─────────────────────────────────────────────────────────────────────────
# 4. Project code (current directory / an installation that exists / clone). SCRIPT_DIR is
#    resolved at the top.
# ─────────────────────────────────────────────────────────────────────────
CURRENT_STEP="$(t "reading the installation" "чтение установки")"
if ! versioned_installation "$INSTALL_DIR" && iva_checkout "$SCRIPT_DIR"; then
  PROJECT_DIR="$SCRIPT_DIR"
  UPDATE_CHANNEL="$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true)"
  UPDATE_CHANNEL="${UPDATE_CHANNEL:-main}"
  step "$(t "Using current directory: $PROJECT_DIR" "Использую текущий каталог: $PROJECT_DIR")"
  acquire_install_lock
  # No git work here, and the build is destructive all the same: this is the command the
  # installer itself tells people to re-run, so it owes them the same undo as any other.
  CURRENT_STEP="$(t "saving your files" "сохранение ваших файлов")"
  save_env_copy
elif [ "$INSTALL_EXISTS" = true ]; then
  # Iva уже установлена: обновлять её установщик не имеет права - обновлятор один.
  # Куда идти с этим деревом, решает repair.sh того же канала: маркер `.iva-dev` -
  # отказ, версионная раскладка - её собственный обновлятор, чекаут - назад на релиз и
  # потом обновление. Своей копии этого решения у установщика нет.
  CURRENT_STEP="$(t "handing the installation to the updater" "передача установки обновлятору")"
  # Чекаут ниже двигает git: второй установщик над тем же деревом получал бы сырой
  # «index.lock: File exists» вместо отказа по имени. Версионную раскладку сторожит замок
  # самого обновлятора.
  if [ -d "$INSTALL_DIR/.git" ]; then PROJECT_DIR="$INSTALL_DIR"; acquire_install_lock "$INSTALL_DIR/data"; fi
  record_beta_choice
  hand_installation_to_repair
elif [ "$RESUME_FIRST_INSTALL" = true ]; then
  PROJECT_DIR="$INSTALL_DIR"
  step "$(t "Continuing first installation: $PROJECT_DIR" "Продолжаю первую установку: $PROJECT_DIR")"
  acquire_install_lock
  save_env_copy
else
  run_stage "$(t "Cloning Iva" "Клонирую Iva")" "$(t "Iva downloaded" "Iva загружена")" \
    git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  checkout_release "$INSTALL_DIR"
  PROJECT_DIR="$INSTALL_DIR"
  acquire_install_lock
fi
cd "$PROJECT_DIR"
if [ "$INSTALL_EXISTS" != true ]; then
  (umask 077; : >"$PROJECT_DIR/.iva-installing")
fi

# ─────────────────────────────────────────────────────────────────────────
# 5. npm dependencies. Detect-then-skip: a re-run after a late failure must not
#    delete and reinstall a node_modules that already matches the lockfile.
# ─────────────────────────────────────────────────────────────────────────
# npm records what it installed in node_modules/.package-lock.json, so the answer comes
# from npm's own bookkeeping, not from a marker of ours: every entry it lists must be in
# package-lock.json with the same version, resolved URL and integrity, and every entry required on this
# platform must be there. Optional and os/cpu-specific packages are absent by design.
npm_deps_match_lock() {
  [ -d node_modules ] || return 1
  [ -f package-lock.json ] || return 1
  [ -f node_modules/.package-lock.json ] || return 1
  node -e 'const fs=require("fs");const j=p=>JSON.parse(fs.readFileSync(p,"utf8"));const lock=j("package-lock.json"),have=j("node_modules/.package-lock.json");const a=lock.packages||{},b=have.packages||{};if(!Object.keys(b).length)process.exit(1);for(const k of Object.keys(b)){if(!k)continue;if(!a[k]||["version","resolved","integrity"].some(f=>a[k][f]!==b[k][f]))process.exit(1)}for(const k of Object.keys(a)){if(!k)continue;const e=a[k];if(e.optional||e.devOptional||e.os||e.cpu)continue;if(!b[k])process.exit(1)}' \
    >/dev/null 2>&1
}
CURRENT_STEP="$(t "dependencies" "зависимости")"
INSTALL_DEPS_REUSED=false
if npm_deps_match_lock; then
  INSTALL_DEPS_REUSED=true
  ok "$(t "Dependencies already match package-lock.json" "Зависимости уже соответствуют package-lock.json")"
fi
if [ "$INSTALL_DEPS_REUSED" != true ]; then
  if [ -f package-lock.json ]; then
    run_stage "$(t "Installing dependencies" "Ставлю зависимости")" "$(t "Dependencies installed" "Зависимости установлены")" npm ci
  else
    run_stage "$(t "Installing dependencies" "Ставлю зависимости")" "$(t "Dependencies installed" "Зависимости установлены")" npm install
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# 5b. agent-browser (web automation: forms, logins, screenshots, scraping)
# ─────────────────────────────────────────────────────────────────────────
# The binary installs into npm-global; the path is needed here and in the service PATH (below).
NPM_GLOBAL_BIN="$(npm prefix -g 2>/dev/null)/bin"
export PATH="$HOME/.local/bin:$NPM_GLOBAL_BIN:$PATH"
CURRENT_STEP="agent-browser"
# The launch check first, not after the install: it is the same proof the install path
# ends with, and passing it means the binary and Chromium are both there. Downloading
# Chromium again is the longest stage of the whole script, so it has to be earned.
if command -v agent-browser >/dev/null 2>&1 && agent-browser open about:blank >/dev/null 2>&1; then
  agent-browser close --all >/dev/null 2>&1 || true
  ok "$(t "agent-browser already installed" "agent-browser уже установлен")"
else
  echo "  ${c_yellow}$(t "Chromium and its system libraries may take 1–3 minutes." "Chromium и системные библиотеки могут устанавливаться 1–3 минуты.")${c_reset}"
  # Refresh the sudo cache ahead of time (a visible prompt here, not a hidden one mid-install).
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    if have_tty; then sudo -v; else sudo -n -v; fi 2>/dev/null || true
  fi
  agent_browser_rc=0
  if run_stage "$(t "Installing agent-browser" "Ставлю agent-browser")" "$(t "agent-browser installed" "agent-browser установлен")" \
    install_verified_npm_tarball agent-browser "$AGENT_BROWSER_TARBALL_URL" "$AGENT_BROWSER_TARBALL_SHA256"; then
    browser_install=(agent-browser install)
    if [ "$HEADLESS_SUDO" != true ]; then browser_install+=(--with-deps); fi
    run_stage "$(t "Downloading Chromium" "Скачиваю Chromium")" "$(t "Chromium ready" "Chromium готов")" "${browser_install[@]}" \
      || warn "$(t "Finish later: agent-browser install --with-deps" "Завершите позже: agent-browser install --with-deps")"
    # Chrome won't start on Ubuntu 23.10+/24.04: the kernel forbids unprivileged user
    # namespaces (AppArmor) → "No usable sandbox". On Linux, enable --no-sandbox by
    # default for all agent-browser calls (idempotent, without clobbering an existing config).
    if [ "$(uname -s)" = "Linux" ]; then
      node -e 'const fs=require("fs"),os=require("os"),p=require("path");const d=p.join(os.homedir(),".agent-browser"),f=p.join(d,"config.json");fs.mkdirSync(d,{recursive:true});let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}const w="--no-sandbox";const cur=typeof c.args=="string"?c.args:Array.isArray(c.args)?c.args.join(","):"";if(!cur.split(/[,\n]/).map(s=>s.trim()).filter(Boolean).includes(w)){c.args=cur?cur+","+w:w;fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")}' \
        2>/dev/null || warn "$(t "couldn't configure ~/.agent-browser/config.json — add \"args\": \"--no-sandbox\" manually" "не настроил ~/.agent-browser/config.json — добавь \"args\": \"--no-sandbox\" вручную")"
    fi
    # A real launch check: doctor ignores config args and falsely complains about the sandbox.
    if agent-browser open about:blank >/dev/null 2>&1; then
      agent-browser close --all >/dev/null 2>&1 || true
      ok "$(t "agent-browser ready" "agent-browser готов")"
    else
      warn "$(t "agent-browser installed but Chrome didn't start — check later: agent-browser open about:blank" "agent-browser поставлен, но Chrome не запустился — проверьте позже: agent-browser open about:blank")"
    fi
  else
    agent_browser_rc=$?
    if [ "$agent_browser_rc" -eq "$CHECKSUM_MISMATCH_RC" ]; then
      die "$(t "agent-browser SHA-256 verification failed" "Проверка SHA-256 agent-browser не прошла")"
    fi
    warn "$(t "couldn't install agent-browser — browser tasks unavailable, everything else works" "не удалось поставить agent-browser — браузерные задачи недоступны, остальное работает")"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# 5c. Google Workspace CLI (`gws`): Gmail / Calendar / Drive / Sheets / Docs
# ─────────────────────────────────────────────────────────────────────────
# Installed once and left alone: an installed `gws` is kept current by `iva update`,
# so re-running the installer after a failure has no reason to pay for it again. Non-fatal — Google-service tasks are
# optional. Binary lands in ~/.local/bin (first on the service PATH). Auth is per-user and
# interactive — the bot walks the user through it in chat (agent skill
# `google-workspace`); nothing to configure here.
CURRENT_STEP="gws"
if command -v gws >/dev/null 2>&1 && gws --version >/dev/null 2>&1; then
  ok "$(t "gws already installed" "gws уже установлен")"
else
  gws_rc=0
  if run_stage "$(t "Installing Google Workspace CLI" "Ставлю Google Workspace CLI")" "$(t "gws installed" "gws установлен")" \
    install_gws "$HOME/.local" \
    && command -v gws >/dev/null 2>&1; then
    ok "$(t "gws ready — connect Google later: message the bot \"connect Google\"" "gws готов — Google подключишь позже: напиши боту «подключи Google»")"
  else
    gws_rc=$?
    if [ "$gws_rc" -eq "$CHECKSUM_MISMATCH_RC" ]; then
      die "$(t "gws SHA-256 verification failed" "Проверка SHA-256 gws не прошла")"
    fi
    warn "$(t "couldn't install gws — Google-service tasks unavailable, everything else works (retry: run install.sh again)" "не удалось поставить gws — задачи с Google-сервисами недоступны, остальное работает (повторить: снова запустить install.sh)")"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# 6. Interactive setup (provider + model + Telegram + Deepgram + TZ + vault)
#    Reads /dev/tty → works with `curl | bash` too. Without a terminal — defer it.
# ─────────────────────────────────────────────────────────────────────────
CURRENT_STEP="$(t "setup wizard" "мастер настройки")"
SETUP_DONE=false
# An asynchronous wait lets bash handle HUP/TERM while setup is waiting for input.
# The exit handler stops setup before releasing the installer lock.
run_setup() {
  IVA_CONFIG_STAGING=0 node scripts/setup.mjs "$@" <&0 &
  SETUP_PID=$!
  local rc=0
  wait "$SETUP_PID" || rc=$?
  SETUP_PID=""
  return "$rc"
}
if [ -n "$ENV_FILE" ]; then
  IVA_CONFIG_INPUT="$ENV_FILE" IVA_CONFIG_OUTPUT="$PROJECT_DIR/.env" run_setup --non-interactive </dev/null
  SETUP_DONE=true
elif [ "$RUN_SETUP" = false ]; then
  warn "$(t "Setup skipped (flag). Run it later: cd $PROJECT_DIR && npm run setup" "Настройка пропущена (флаг). Запустите потом: cd $PROJECT_DIR && npm run setup")"
elif have_tty; then
  step "$(t "Setup…" "Настройка…")"
  if [ "$RESUME_FIRST_INSTALL" = true ]; then
    run_setup --first-install < /dev/tty
  else
    run_setup < /dev/tty
  fi
  SETUP_DONE=true
else
  warn "$(t "No terminal (/dev/tty) — skipping the wizard. Run it later: cd $PROJECT_DIR && npm run setup" "Нет терминала (/dev/tty) — пропускаю мастер. Запустите потом: cd $PROJECT_DIR && npm run setup")"
fi

# ─────────────────────────────────────────────────────────────────────────
# 7. Build. Detect-then-skip: the stamp inside .output says which source state this
#    exact output was built from, by this installer.
# ─────────────────────────────────────────────────────────────────────────
# The stamp lives inside .output on purpose. `npm run build` (scripts/build.ts) replaces
# the whole directory with one it built itself — custom layer included — so its output
# never carries this stamp, and the installer rebuilds instead of adopting an output it
# did not produce. Inputs: the commit, every tracked edit on top of it, the untracked files
# with their contents, and .env, which the build reads.
BUILD_STAMP=".output/.iva-install-build"
# Prints nothing and fails when git cannot describe the tree — no repository, no git, or a
# checkout it refuses to read (dubious ownership under sudo). Without git the source state
# is unknowable, and an unknowable state must never skip a build: the answer would be the
# hash of .env alone, and changed code would keep the stale output.
install_build_fingerprint() {
  local head answer
  head="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$head" ] || return 1
  # Every input must be read in full or there is no answer: a dangling symlink among the
  # untracked files ends the hashing stream, and an answer missing the files after it would
  # be stable while the code under it changed. Nothing printed, so the caller sees the
  # failure as an empty fingerprint and builds.
  answer="$(
    {
      printf '%s\n' "$head"
      git -C "$PROJECT_DIR" status --porcelain=v1 --untracked-files=all
      git -C "$PROJECT_DIR" diff HEAD --binary
      # status names the untracked files, this hashes what is in them: a source file the
      # user added by hand is part of the build like any other.
      # The exits are explicit because errexit does not end a subshell of a pipeline on a
      # failing pipeline inside it, and a half-read input is exactly what must not answer.
      git -C "$PROJECT_DIR" ls-files --others --exclude-standard \
        | git -C "$PROJECT_DIR" hash-object --stdin-paths 2>/dev/null || exit 1
      if [ -f "$PROJECT_DIR/.env" ]; then
        git hash-object -- "$PROJECT_DIR/.env" 2>/dev/null || exit 1
      else
        echo "no-env"
      fi
    } | git hash-object --stdin
  )" || return 1
  printf '%s\n' "$answer"
}
CURRENT_STEP="$(t "build" "сборка")"
BUILD_FINGERPRINT="$(install_build_fingerprint || true)"
if [ -n "$BUILD_FINGERPRINT" ] && [ -f "$BUILD_STAMP" ] && [ "$(cat "$BUILD_STAMP")" = "$BUILD_FINGERPRINT" ]; then
  ok "$(t "Build is current — reusing .output" "Сборка актуальна — использую готовый .output")"
else
  if [ "$INSTALL_UPDATE_ACTIVE" = true ] && [ -e .output ]; then
    INSTALL_OUTPUT_BACKUP="$PROJECT_DIR/.output.iva-install-backup-$$"
    mv .output "$INSTALL_OUTPUT_BACKUP"
  fi
  run_stage "$(t "Building Iva" "Собираю Iva")" "$(t "Build ready → .output" "Сборка готова → .output")" npm exec -- eve build
  if [ -n "$BUILD_FINGERPRINT" ] && [ -d .output ]; then
    printf '%s\n' "$BUILD_FINGERPRINT" >"$BUILD_STAMP"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# 8. Live vault: a SEPARATE private git repo (memory + backup + Obsidian)
#    Created from vault-template/ (a skeleton in the code repo); personal data never enters the code repo.
# ─────────────────────────────────────────────────────────────────────────
CURRENT_STEP="$(t "vault" "vault")"
VAULT_DIR_REL="$(grep -E '^ASSISTANT_VAULT_DIR=' .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"' || true)"
VAULT_DIR_REL="${VAULT_DIR_REL:-vault}"
case "$VAULT_DIR_REL" in
  /*) VAULT_PATH="$VAULT_DIR_REL" ;;
  *)  VAULT_PATH="$PROJECT_DIR/$VAULT_DIR_REL" ;;
esac
step "$(t "Preparing the live vault from the template…" "Готовлю live-vault из шаблона…")"
ASSISTANT_VAULT_DIR="$VAULT_DIR_REL" node scripts/init-vault.mjs || warn "$(t "init-vault didn't run — check the vault manually" "init-vault не отработал — проверьте vault вручную")"

# ─────────────────────────────────────────────────────────────────────────
# 8.5. The `iva` command in ~/.local/bin (update/config/doctor/uninstall/...).
#     A wrapper with hardcoded node+project paths — works from any shell.
# ─────────────────────────────────────────────────────────────────────────
CURRENT_STEP="$(t "the iva command" "команда iva")"
step "$(t "Installing the iva command in ~/.local/bin…" "Ставлю команду iva в ~/.local/bin…")"
mkdir -p "$HOME/.local/bin"
# Path resolution only, so the same shim keeps working once the install moves to
# ~/iva/versions/<version> behind the `current` symlink - and keeps working even if
# that symlink is lost, which is what makes `iva update` able to repair it.
node --input-type=module -e '
import { refreshOwnedShim } from "./scripts/lib/version-layout.ts";
import { layoutFor } from "./scripts/lib/version-store.ts";
const [home, target] = process.argv.slice(1);
refreshOwnedShim(target, home, process.execPath, layoutFor(home).data);
' "$PROJECT_DIR" "$HOME/.local/bin/iva"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ok "$(t "The iva command is ready — try: iva help" "Команда iva готова — попробуй: iva help")" ;;
  *) warn "$(t "Add ~/.local/bin to PATH to call iva directly (or: \$HOME/.local/bin/iva help)" "Добавь ~/.local/bin в PATH, чтобы звать iva напрямую (или: \$HOME/.local/bin/iva help)")" ;;
esac

# ─────────────────────────────────────────────────────────────────────────
# 9. systemd: the main service + brain/update-check timers (Linux). Requires a
#    configured .env. Memory rollups (daily/weekly/monthly/yearly) no longer have
#    systemd units of their own — they run as in-process eve schedules
#    (agent/schedules/memory-*.ts), migrated automatically on the server's first
#    start by scripts/lib/schedule-migration.ts.
# ─────────────────────────────────────────────────────────────────────────
AUTOSTART_READY=false
if [ "$IVA_OS" = Darwin ]; then
  if [ ! -f .env ]; then
    warn "$(t 'No .env — run npm run setup before enabling autostart.' 'Нет .env — запустите npm run setup перед настройкой автозапуска.')"
  elif prompt_yes_no "$(t 'Set up autostart (launchd)?' 'Завести автозапуск (launchd)?')" yes; then
    CURRENT_STEP="launchd"
    node "$PROJECT_DIR/bin/iva.mjs" _install-units || die "$(t 'Could not write Iva units' 'Не удалось записать задания Ивы')"
    node "$PROJECT_DIR/bin/iva.mjs" _activate-units || die "$(t 'Could not activate Iva units; run iva logs' 'Не удалось включить задания Ивы; выполните iva logs')"
    ok "$(t 'Bot enabled and online' 'Бот включён и на связи')"
    ok "iva status"
    ok "iva logs -f"
    AUTOSTART_READY=true
  fi
elif ! command -v systemctl >/dev/null 2>&1; then
  : # not Linux/systemd — skip silently
elif [ ! -f .env ]; then
  warn "$(t "No .env — not setting up autostart. Run: cd $PROJECT_DIR && npm run setup, then: bash install.sh (seconds — it reuses everything already done)." "Нет .env — автозапуск не настраиваю. Выполните: cd $PROJECT_DIR && npm run setup, потом: bash install.sh (секунды — всё готовое переиспользуется).")"
elif prompt_yes_no "$(t "Set up autostart via systemd (service + watchdog timers)?" "Завести автозапуск через systemd (сервис + сторожевые таймеры)?")" yes; then
  CURRENT_STEP="$(t "systemd units" "systemd-юниты")"
  # Lingering first: without it the user's systemd bus only exists while a login session
  # does, and `systemctl --user enable --now` below is exactly the call that fails with
  # "Failed to connect to bus" on a box nobody is logged into.
  loginctl enable-linger "${USER:-$(id -un)}" >/dev/null 2>&1 \
    || warn "$(t "couldn't enable linger (the service won't start before login)" "не удалось включить linger (сервис не стартует до логина)")"
  # Delegate writing the units to the iva CLI — the single source of truth is scripts/cli/systemd.ts.
  step "$(t "Installing systemd units (via the iva CLI)…" "Ставлю systemd-юниты (через iva CLI)…")"
  node "$PROJECT_DIR/bin/iva.mjs" _install-units || die "$(t "couldn't write the systemd units" "не удалось записать systemd-юниты")"
  node "$PROJECT_DIR/bin/iva.mjs" _activate-units \
    || die "$(t "couldn't enable and start the systemd units; follow the journal hint above" "не удалось включить и запустить systemd-юниты; проверьте подсказку journal выше")"
  ok "$(t "Bot enabled and online" "Бот включён и на связи")"
  ok "$(t "Background timers enabled and active: systemctl --user list-timers" "Фоновые таймеры включены и активны: systemctl --user list-timers")"
  ok "$(t "Service started: systemctl --user status iva" "Сервис запущен: systemctl --user status iva")"

  AUTOSTART_READY=true
fi

if [ "$AUTOSTART_READY" = true ]; then
  # Instant confirmation in Telegram (direct Bot API — doesn't depend on the server).
  _bot="$(grep -E '^TELEGRAM_BOT_TOKEN=' .env | head -n1 | cut -d= -f2- | tr -d '"' || true)"
  _chat="$(grep -E '^TELEGRAM_DIGEST_CHAT_ID=' .env | head -n1 | cut -d= -f2- | tr -d '"' || true)"
  if [ -z "$_chat" ]; then
    _chat="$(grep -E '^TELEGRAM_ALLOWED_USER_IDS=' .env | head -n1 | cut -d= -f2- | tr -d '"' | cut -d, -f1 || true)"
  fi
  if [ -n "$_bot" ] && [ -n "$_chat" ]; then
    printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$_bot" | curl -s --config - \
      --data-urlencode "chat_id=$_chat" \
      --data-urlencode "text=$(t "✅ Iva is installed and online. Send me a message — I'll reply." "✅ Iva установлена и на связи. Напишите мне сообщение — отвечу.")" >/dev/null 2>&1 \
      && ok "$(t "Sent you a confirmation in Telegram — open the chat with the bot" "Отправил вам подтверждение в Telegram — откройте чат с ботом")" \
      || warn "$(t "couldn't send the confirmation (the bot still works — just message it)" "не смог отправить подтверждение (бот всё равно работает — просто напишите ему)")"
  fi
fi

# Non-fatal: an installation unpacked from an archive has no git config to write into, and
# that is not a reason to fail an install that otherwise finished.
git -C "$PROJECT_DIR" config --local iva.updateBranch "$UPDATE_CHANNEL" 2>/dev/null \
  || warn "$(t "couldn't record the update branch (not a git checkout) — 'iva update' will use the default" "не записал ветку обновлений (не git-checkout) — 'iva update' возьмёт ветку по умолчанию")"

(umask 077; printf 'autostart=%s\n' "$AUTOSTART_READY" >"$PROJECT_DIR/.iva-installed")
rm -f -- "$PROJECT_DIR/.iva-installing"
finish_install_update
INSTALL_COMPLETE=true

# ─────────────────────────────────────────────────────────────────────────
# 10. Final
# ─────────────────────────────────────────────────────────────────────────
echo
echo "${c_green}${c_bold}┌──────────────────────────────────────────┐${c_reset}"
echo "${c_green}${c_bold}│            $(t "✓ Installation complete   " "✓ Установка завершена      ")│${c_reset}"
echo "${c_green}${c_bold}└──────────────────────────────────────────┘${c_reset}"
echo
if [ "$SETUP_DONE" != true ]; then
  # The installer, not `npm run build && iva restart`: a restart writes the units but
  # never enables them and never turns lingering on, so that path ends with a bot that
  # dies at logout. Re-running is cheap now — every finished stage is skipped.
  echo "  ${c_yellow}${c_bold}$(t "Configure the keys first:" "Сначала настройте ключи:")${c_reset}  cd $PROJECT_DIR && npm run setup"
  echo "  $(t "Then finish the install (seconds — it reuses everything already done):" "Затем завершите установку (секунды — всё готовое переиспользуется):") cd $PROJECT_DIR && bash install.sh"
  echo
fi
echo "  ${c_bold}$(t "Commands (${c_green}iva${c_reset}${c_bold} — from anywhere):" "Команды (${c_green}iva${c_reset}${c_bold} — из любого места):")${c_reset}"
echo "    iva update        $(t "update (git pull + build + restart)" "обновить (git pull + сборка + рестарт)")"
echo "    iva config        $(t "configure (model/Telegram/Deepgram/TZ/vault)" "настройка (модель/Telegram/Deepgram/TZ/vault)")"
echo "    iva doctor        $(t "diagnose and auto-fix the install" "диагностика и авто-починка установки")"
echo "    iva status        $(t "services and timers status" "статус сервисов и таймеров")"
echo "    iva help          $(t "all commands" "все команды")"
echo
echo "  ${c_yellow}${c_bold}$(t "Vault backup in git" "Vault-бэкап в git")${c_reset} $(t "(one-time — a private remote for your memory):" "(один раз — приватный remote для памяти):")"
echo "    gh auth login"
echo "    gh repo create <user>/iva-vault --private --source=\"$VAULT_PATH\" --remote=origin --push"
echo
if [ "$AUTOSTART_READY" = true ]; then
  echo "  ${c_green}${c_bold}$(t "✅ The bot is ready" "✅ Бот готов")${c_reset} — $(t "just message it in Telegram." "просто напишите ему в Telegram.")"
  if [ "$IVA_OS" = Darwin ]; then
    echo "    iva status"
    echo "    iva logs -f"
  else
    echo "    $(t "Bot status:" "Статус бота:")  systemctl --user status iva-telegram-poll"
    echo "    $(t "Bot logs:" "Логи бота:")    journalctl --user -u iva-telegram-poll -f"
  fi
fi
if [ "$IVA_OS" = Darwin ]; then
  echo "$(t 'Iva runs while this Mac is on, awake and you are logged in. If it is off at night, that night’s memory care is skipped. For round-the-clock operation use a server or a Mac that stays awake (Settings → Battery / Energy Saver).' 'Ива работает, пока этот Mac включён, не спит и вы вошли в систему. Если Mac выключен ночью, ночной уход за памятью в эту ночь пропускается. Для работы круглосуточно — сервер или Mac, который не засыпает (Настройки → Аккумулятор / Энергосбережение)')"
fi
echo
