#!/usr/bin/env bash
#
# Prepare a fresh VPS for Iva (a personal long-term-memory agent) with one command,
# as root, on Ubuntu 22.04/24.04 or Debian 12:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/bootstrap.sh)
#
# What it does, in this order: sets the timezone, updates the system, installs the
# packages install.sh expects (git, python3, ffmpeg, pandoc, poppler), creates a
# sudo user with systemd lingering enabled, turns on a firewall that allows SSH only,
# starts fail2ban, enables unattended security upgrades, and hardens sshd LAST — with
# a reload, so the session you are typing in is never dropped. It ends with the two
# commands that finish the install — and, when the upgrade brought a new kernel, with
# a reboot, because install.sh refuses to install packages while one is pending.
#
# It never asks for an SSH key: you log in as the new user with the password you set
# here, and hardening stops at PermitRootLogin no. Headless runs can still authorize a
# key with IVA_PUBKEY, and only then may IVA_DISABLE_PASSWORD_AUTH turn passwords off.
#
# Every step is detect-then-skip: running it twice changes nothing and exits 0.
# This script installs no agent code. Iva itself is installed by install.sh, from the
# new user's own shell — the shell tool runs as whoever installed it, never as root.
#
# Flags:
#   --non-interactive   never ask anything; read the answers from the environment
#   -h, --help          show this help and exit
#
# Environment (required in non-interactive mode):
#   IVA_USER                    login to create or reuse, e.g. iva
#   IVA_PASS                    password, required only when the user does not exist
#   IVA_PUBKEY                  optional SSH public key to authorize
#   IVA_TZ                      optional IANA timezone, e.g. Europe/Berlin
#   IVA_DISABLE_PASSWORD_AUTH   optional true/false; default true with a key, false without
#   IVA_REBOOT                  optional true/false; reboot when the upgrade brought a
#                               new kernel. Default false — never reboot silently.
#
# Log: /var/log/iva-bootstrap.log (mode 600).

set -Eeuo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
# gum is pinned and checksum-verified: it only paints the interface, so a bad
# download must never become a silent binary install. Mismatch → plain text mode.
GUM_VERSION="0.17.0"
GUM_SHA256_X86_64="69ee169bd6387331928864e94d47ed01ef649fbfe875baed1bbf27b5377a6fdb"
GUM_SHA256_ARM64="b0b9ed95cbf7c8b7073f17b9591811f5c001e33c7cfd066ca83ce8a07c576f9c"

RAW_BASE="https://raw.githubusercontent.com/smixs/iva-agent/main"
LOG_FILE="/var/log/iva-bootstrap.log"
SSHD_MAIN_CONFIG="/etc/ssh/sshd_config"
SSHD_DROPIN_DIR="/etc/ssh/sshd_config.d"
# 00- on purpose. sshd keeps the FIRST value it reads for a keyword, and cloud images
# ship 50-cloud-init.conf with `PasswordAuthentication yes`. A 99- file would lose.
SSHD_DROPIN="/etc/ssh/sshd_config.d/00-iva-hardening.conf"
FAIL2BAN_JAIL="/etc/fail2ban/jail.local"
AUTO_UPGRADES_CONF="/etc/apt/apt.conf.d/20auto-upgrades"
# apt leaves this behind when an upgraded package (kernel, glibc, dbus) needs a reboot.
REBOOT_REQUIRED_FLAG="/var/run/reboot-required"
MARKER="# managed by the iva VPS bootstrap"

# iva palette (see deploy/iva-tree.ans) — one source for both the gum flags and the raw ANSI fallbacks
C_PRIMARY=113   # leaf green
C_ACCENT=71     # moss
C_OK=84         # green
C_WARN=214      # amber
C_ERR=196       # red
C_MUTED=245     # grey

PACKAGES="sudo curl ca-certificates git python3 ffmpeg pandoc poppler-utils unattended-upgrades fail2ban ufw openssh-server"
# Playwright Chromium dependencies, with the t64 ABI names selected by apt on newer systems.
PACKAGES="$PACKAGES gh libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libwayland-client0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xvfb fonts-noto-color-emoji fonts-unifont libfontconfig1 libfreetype6 xfonts-cyrillic xfonts-scalable fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf"

# ── Mutable state ────────────────────────────────────────────────────────────
UI_MODE="plain"          # gum | plain | none
NON_INTERACTIVE=false
GUM_SUPPORTED=true
CURRENT_STEP="startup"
SPINNER_PID=""
STEP_NO=0
STEP_TOTAL=8

TARGET_USER=""
TARGET_PASS=""
CREATE_USER=false
PUBKEY=""
DISABLE_PASSWORD_AUTH=false
# Set true ONLY once the key is really in authorized_keys with the right perms.
# harden_ssh reads THIS, not "a key was handed in": a key that never landed must
# never let us turn passwords off, or the owner is locked out of their own VPS.
KEY_AUTHORIZED=false
TIMEZONE_CHOICE=""
SSH_PORT=22

c_blue=""; c_green=""; c_yellow=""; c_red=""; c_bold=""; c_reset=""

# ─────────────────────────────────────────────────────────────────────────────
# Output primitives (same shape as install.sh, so the two scripts read alike)
# ─────────────────────────────────────────────────────────────────────────────
setup_colors() {
  if [ -n "${NO_COLOR:-}" ] || [ "${TERM:-}" = dumb ] || [ ! -t 1 ]; then
    c_blue=""; c_green=""; c_yellow=""; c_red=""; c_bold=""; c_reset=""
  else
    c_blue=$'\033[38;5;'"${C_ACCENT}"'m'
    c_green=$'\033[38;5;'"${C_OK}"'m'
    c_yellow=$'\033[38;5;'"${C_WARN}"'m'
    c_red=$'\033[38;5;'"${C_ERR}"'m'
    c_bold=$'\033[1m'
    c_reset=$'\033[0m'
  fi
}
step() { echo "${c_blue}▸ $*${c_reset}"; }
ok()   { echo "${c_green}✓ $*${c_reset}"; }
warn() { echo "${c_yellow}! $*${c_reset}"; }
die()  { stop_spinner; echo "${c_red}✗ $*${c_reset}" >&2; exit 1; }

# 2>/dev/null comes FIRST on purpose: a failing redirect is reported on the fd 2 that
# is current when it fails, so silencing it afterwards would be too late.
log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" 2>/dev/null >>"$LOG_FILE" || true; }

init_log() {
  if ! : 2>/dev/null >"$LOG_FILE"; then
    LOG_FILE="${TMPDIR:-/tmp}/iva-bootstrap.log"
    : 2>/dev/null >"$LOG_FILE" || true
  fi
  chmod 600 "$LOG_FILE" 2>/dev/null || true
  log "bootstrap started: $(uname -srm), uid $(id -u), ui=$UI_MODE"
}

# ── Compact progress. Long work prints to the log only; the screen gets a spinner ──
spinner_enabled() {
  [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]
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

# run_stage LABEL SUCCESS COMMAND [ARG...] — runs the command with every byte of its
# output redirected into the log, behind a spinner. gum only draws; failures are
# handled here so the reporting is identical in both modes.
run_stage() {
  local label="$1" success="$2"
  shift 2
  CURRENT_STEP="$label"
  log "stage: $label"
  local rc=0
  if [ "$UI_MODE" = gum ] && spinner_enabled; then
    # gum spin owns the terminal, so the work redirects its own output inside the
    # child instead of us redirecting gum. $1 is the log path, passed as an argument.
    # shellcheck disable=SC2016  # the child must expand $1/$@, not this shell
    gum spin --spinner dot --spinner.foreground "$C_PRIMARY" --title "$label" -- \
      bash -c 'exec >>"$1" 2>&1; shift; "$@"' iva-bootstrap "$LOG_FILE" "$@" || rc=$?
  else
    start_spinner "$label"
    "$@" >>"$LOG_FILE" 2>&1 || rc=$?
    stop_spinner
  fi
  if [ "$rc" -eq 0 ]; then
    ok "$success"
    return 0
  fi
  warn "Failed: $label"
  tail -n 12 "$LOG_FILE" >&2 || true
  echo "Full log: $LOG_FILE" >&2
  return "$rc"
}

# run_sh LABEL SUCCESS 'shell code' — same, for anything that needs a pipe or &&.
run_sh() { run_stage "$1" "$2" bash -c "$3"; }

# ── Loud error handler: no silent exits from set -e ──────────────────────────
on_err() {
  local rc=$?
  stop_spinner
  echo >&2
  echo "${c_red}✗ Bootstrap stopped (exit $rc) during: ${CURRENT_STEP}${c_reset}" >&2
  echo "${c_red}  Failing command: ${BASH_COMMAND}${c_reset}" >&2
  if [ -f "$LOG_FILE" ]; then
    echo "${c_yellow}  Last log lines:${c_reset}" >&2
    tail -n 12 "$LOG_FILE" >&2 || true
    echo "${c_yellow}  Full log: $LOG_FILE${c_reset}" >&2
  fi
  echo "${c_yellow}  Your current SSH session is untouched: sshd hardening is the last step" >&2
  echo "${c_yellow}  and it never drops open sessions. Fix the cause and run this again.${c_reset}" >&2
}

usage() {
  cat <<'USAGE'
Prepare a fresh Ubuntu/Debian VPS for Iva. Run as root:

  bash <(curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/bootstrap.sh)

It sets the timezone, updates the system, installs Iva's system packages, creates a
sudo user with lingering enabled, enables a SSH-only firewall, fail2ban and unattended
security upgrades, and hardens sshd last (reload, never a restart). Re-running it is
safe: every step is detect-then-skip.

Interactively it asks three things: the login, its password, and the timezone. It does
not ask for an SSH key — you log in with that password, and hardening stops at
PermitRootLogin no. Headless runs can authorize a key with IVA_PUBKEY.

Flags:
  --non-interactive   never ask anything; read the answers from the environment
  -h, --help          show this help and exit

Environment (required in non-interactive mode):
  IVA_USER                    login to create or reuse, e.g. iva
  IVA_PASS                    password, required only when the user does not exist
  IVA_PUBKEY                  optional SSH public key to authorize
  IVA_TZ                      optional IANA timezone, e.g. Europe/Berlin
  IVA_DISABLE_PASSWORD_AUTH   optional true/false; default true with a key, false without
  IVA_REBOOT                  optional true/false; reboot when the upgrade brought a new
                              kernel. Default false — never reboot silently. Interactive
                              runs are asked instead.

Example:
  IVA_USER=iva IVA_PASS='...' IVA_PUBKEY="$(cat ~/.ssh/id_ed25519.pub)" \
    bash bootstrap.sh --non-interactive

Log: /var/log/iva-bootstrap.log
USAGE
}

# ─────────────────────────────────────────────────────────────────────────────
# 0. Preflight: arguments, root, distribution, architecture
# ─────────────────────────────────────────────────────────────────────────────
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --non-interactive) NON_INTERACTIVE=true ;;
      -h|--help) usage; exit 0 ;;
      *) warn "unknown flag: $1 (ignoring)" ;;
    esac
    shift
  done
}

os_release_field() {
  awk -F= -v key="$1" '$1 == key { gsub(/^"|"$/, "", $2); print $2; exit }' /etc/os-release 2>/dev/null || true
}

preflight() {
  CURRENT_STEP="preflight checks"
  parse_args "$@"

  if [ "$(id -u)" != 0 ]; then
    die "run this as root — it creates a user, installs packages and configures the firewall. Log in as root, then re-run."
  fi

  local id_field id_like_field
  id_field="$(os_release_field ID)"
  id_like_field="$(os_release_field ID_LIKE)"
  case "$id_field" in
    ubuntu|debian) : ;;
    *)
      case " $id_like_field " in
        *debian*) : ;;
        *) die "this bootstrap targets Ubuntu 22.04/24.04 and Debian 12 (found ID='${id_field:-unknown}'). Install the packages by hand, then run install.sh." ;;
      esac
      ;;
  esac

  case "$(uname -m)" in
    x86_64|aarch64) : ;;
    *)
      GUM_SUPPORTED=false
      warn "architecture $(uname -m) has no prebuilt gum — using the plain text interface"
      ;;
  esac

  if [ "$NON_INTERACTIVE" = true ]; then UI_MODE=none; else UI_MODE=plain; fi
}

have_systemd() { [ -d /run/systemd/system ]; }

# ─────────────────────────────────────────────────────────────────────────────
# 1. gum — the terminal UI toolkit. Optional by design: any failure downgrades
#    the interface to plain text and the bootstrap keeps going.
# ─────────────────────────────────────────────────────────────────────────────
install_gum() {
  CURRENT_STEP="installing the terminal UI toolkit"
  if [ "$UI_MODE" = none ]; then
    return 0
  fi
  # No termcap, no full-screen widgets: gum's text input panics outright on TERM=dumb
  # (and an empty TERM is no better). setup_colors and spinner_enabled already bail on
  # dumb — the gum mode was the one path that did not. Do not even download it.
  case "${TERM:-}" in
    ''|dumb) return 0 ;;
  esac
  if command -v gum >/dev/null 2>&1; then
    UI_MODE=gum
    return 0
  fi
  if [ "$GUM_SUPPORTED" != true ]; then
    return 0
  fi
  if ! command -v tar >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then
    warn "tar or sha256sum missing — using the plain text interface"
    return 0
  fi

  local asset expected
  case "$(uname -m)" in
    x86_64)  asset="gum_${GUM_VERSION}_Linux_x86_64.tar.gz"; expected="$GUM_SHA256_X86_64" ;;
    aarch64) asset="gum_${GUM_VERSION}_Linux_arm64.tar.gz";  expected="$GUM_SHA256_ARM64" ;;
    *) return 0 ;;
  esac

  local tmp
  if ! tmp="$(mktemp -d 2>/dev/null)"; then
    warn "couldn't create a temp directory — using the plain text interface"
    return 0
  fi

  local url="https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}/${asset}"
  start_spinner "Fetching the terminal UI toolkit"
  if ! curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 -o "$tmp/$asset" "$url" >>"$LOG_FILE" 2>&1; then
    stop_spinner
    rm -rf "$tmp"
    warn "couldn't download gum — using the plain text interface"
    return 0
  fi
  # Checksum first, unpack second: nothing unverified is ever extracted or installed.
  if ! printf '%s  %s\n' "$expected" "$tmp/$asset" | sha256sum -c --status - >>"$LOG_FILE" 2>&1; then
    stop_spinner
    rm -rf "$tmp"
    warn "gum checksum mismatch — refusing to install it, using the plain text interface"
    return 0
  fi
  if ! tar -xzf "$tmp/$asset" -C "$tmp" >>"$LOG_FILE" 2>&1; then
    stop_spinner
    rm -rf "$tmp"
    warn "couldn't unpack gum — using the plain text interface"
    return 0
  fi
  # The binary sits in a versioned subdirectory inside the archive; find it, don't guess.
  # `|| binary=""`: head closing the pipe early would otherwise make pipefail abort here.
  local binary
  binary="$(find "$tmp" -type f -name gum 2>/dev/null | head -n1)" || binary=""
  if [ -z "$binary" ] || ! install -m 755 "$binary" /usr/local/bin/gum >>"$LOG_FILE" 2>&1; then
    stop_spinner
    rm -rf "$tmp"
    warn "couldn't install gum — using the plain text interface"
    return 0
  fi
  rm -rf "$tmp"
  stop_spinner
  if command -v gum >/dev/null 2>&1; then
    UI_MODE=gum
    log "gum ${GUM_VERSION} installed in /usr/local/bin"
  else
    warn "gum is not on PATH — using the plain text interface"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. Banner. The art is stored in ASCII (# = full block, _ = lower half) so the
#    per-character walk is byte-safe in any locale; the block glyphs are emitted
#    at print time. Colour is a 24-bit gradient across the columns.
# ─────────────────────────────────────────────────────────────────────────────
show_banner() {
  if [ "$UI_MODE" != gum ] || [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then
    return 0
  fi
  local letter_i=("#######" "  ###  " "  ###  " "  ###  " "  ###  " "#######")
  local letter_v=("###   ###" "###   ###" "###   ###" " ### ### " "  #####  " "   ###   ")
  local letter_a=(" _#####_ " "###   ###" "###   ###" "#########" "###   ###" "###   ###")
  # Palette derived from the canonical tree art in deploy/iva-tree.ans (earthy greens,
  # mean RGB 103,121,82, amber only in the highlights): forest green #387630 → light
  # leaf #B2D66A, lifted in brightness so the letters stay readable on a dark terminal.
  local r0=56 g0=118 b0=48 r1=178 g1=214 b1=106
  local row line len i ch glyph r g b span

  printf '\n'
  for row in 0 1 2 3 4 5; do
    line="${letter_i[$row]}   ${letter_v[$row]}   ${letter_a[$row]}"
    len=${#line}
    span=$(( len > 1 ? len - 1 : 1 ))
    printf '  '
    for (( i = 0; i < len; i++ )); do
      ch="${line:i:1}"
      case "$ch" in
        '#') glyph='█' ;;
        '_') glyph='▄' ;;
        '~') glyph='▀' ;;
        *)   printf ' '; continue ;;
      esac
      r=$(( r0 + (r1 - r0) * i / span ))
      g=$(( g0 + (g1 - g0) * i / span ))
      b=$(( b0 + (b1 - b0) * i / span ))
      printf '\033[38;2;%d;%d;%dm%s' "$r" "$g" "$b" "$glyph"
    done
    printf '\033[0m\n'
    sleep 0.04
  done
  printf '\n'
  gum style --foreground "$C_ACCENT" --italic --margin "0 2" \
    "VPS bootstrap for iva — your personal long-term-memory agent" 2>/dev/null || true
  printf '\n'
}

section() {
  STEP_NO=$(( STEP_NO + 1 ))
  local title="[$STEP_NO/$STEP_TOTAL] $1"
  CURRENT_STEP="$1"
  log "=== $title ==="
  if [ "$UI_MODE" = gum ] && [ -t 1 ]; then
    gum style --border rounded --border-foreground "$C_ACCENT" --padding "0 2" --margin "1 0" "$title" 2>/dev/null \
      || { echo; echo "${c_bold}${c_blue}── $title ──${c_reset}"; }
  else
    echo
    echo "${c_bold}${c_blue}── $title ──${c_reset}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. UI abstraction: gum | plain | none. Every question goes through these four.
# ─────────────────────────────────────────────────────────────────────────────
read_tty() {
  local __name="$1" __answer=""
  if (: </dev/tty) 2>/dev/null; then
    IFS= read -r __answer </dev/tty || __answer=""
  else
    IFS= read -r __answer || __answer=""
  fi
  printf -v "$__name" '%s' "$__answer"
}

read_tty_secret() {
  local __name="$1" __answer=""
  if (: </dev/tty) 2>/dev/null; then
    IFS= read -rs __answer </dev/tty || __answer=""
  else
    IFS= read -rs __answer || __answer=""
  fi
  printf -v "$__name" '%s' "$__answer"
}

ui_ask() {
  if [ "$UI_MODE" = gum ]; then
    gum style --foreground "$C_ACCENT" --bold "$*" 2>/dev/null || echo "${c_bold}${c_blue}$*${c_reset}"
  else
    echo
    echo "${c_bold}${c_blue}$*${c_reset}"
  fi
}

ui_note() {
  if [ "$UI_MODE" = gum ]; then
    gum style --foreground "$C_MUTED" --italic "$*" 2>/dev/null || echo "  $*"
  else
    echo "  $*"
  fi
}

# ui_gum_failed RC — true when gum itself broke, false when the user aborted.
# 130 is Esc or Ctrl-C: the user's own choice, honour it. Any other non-zero status
# means the widget died on us (gum 0.17 panics outright on some terminals), so drop to
# plain prompts for the rest of the run and let the caller re-ask the same question.
# Never accept the empty string a crashed widget returns — that is how a wrong username
# or an unenterable password slips through unnoticed.
# Capture the status with `|| rc=$?`, never `if ! v="$(gum …)"` — `!` rewrites $? to 0.
ui_gum_failed() {
  local rc="$1"
  if [ "$rc" -eq 130 ]; then
    return 1
  fi
  if [ "$UI_MODE" = gum ]; then
    warn "the fancy interface failed — switching to plain prompts"
    UI_MODE=plain
  fi
  return 0
}

# ui_input VAR "prompt" "placeholder"
ui_input() {
  local __name="$1" __prompt="$2" __placeholder="${3:-}" __value="" __rc=0
  case "$UI_MODE" in
    none)
      __value=""
      ;;
    gum)
      ui_ask "$__prompt"
      __value="$(gum input --prompt '> ' --prompt.foreground "$C_PRIMARY" \
        --cursor.foreground "$C_PRIMARY" --placeholder "$__placeholder")" || __rc=$?
      if [ "$__rc" -ne 0 ]; then
        __value=""
        if ui_gum_failed "$__rc"; then
          # Now in plain mode: ask the very same question again instead of
          # silently handing the caller an empty answer.
          ui_input "$__name" "$__prompt" "$__placeholder"
          return 0
        fi
      fi
      ;;
    *)
      ui_ask "$__prompt"
      if [ -n "$__placeholder" ]; then
        printf '> (for example: %s) ' "$__placeholder"
      else
        printf '> '
      fi
      read_tty __value
      ;;
  esac
  printf -v "$__name" '%s' "$__value"
}

# ui_password VAR "prompt" — asks twice, requires at least 8 characters
ui_password() {
  local __name="$1" __prompt="$2" first="" second="" attempts=0 __rc=0
  if [ "$UI_MODE" = none ]; then
    printf -v "$__name" '%s' ""
    return 0
  fi
  while :; do
    attempts=$(( attempts + 1 ))
    if [ "$attempts" -gt 5 ]; then
      die "too many failed password attempts"
    fi
    ui_ask "$__prompt"
    if [ "$UI_MODE" = gum ]; then
      __rc=0
      first="$(gum input --password --prompt '> ' --prompt.foreground "$C_PRIMARY" \
        --cursor.foreground "$C_PRIMARY" --placeholder 'at least 8 characters')" || __rc=$?
      if [ "$__rc" -ne 0 ]; then
        first=""
        if ui_gum_failed "$__rc"; then
          # A broken widget is not a failed attempt: restart the budget and ask
          # again in plain mode, rather than looping on "too short" until we die.
          attempts=0
          continue
        fi
      fi
    else
      printf '> '
      read_tty_secret first
      echo
    fi
    if [ "${#first}" -lt 8 ]; then
      warn "too short — use at least 8 characters"
      continue
    fi
    ui_ask "Repeat the password"
    if [ "$UI_MODE" = gum ]; then
      __rc=0
      second="$(gum input --password --prompt '> ' --prompt.foreground "$C_PRIMARY" \
        --cursor.foreground "$C_PRIMARY" --placeholder 'the same one again')" || __rc=$?
      if [ "$__rc" -ne 0 ]; then
        second=""
        if ui_gum_failed "$__rc"; then
          attempts=0
          continue
        fi
      fi
    else
      printf '> '
      read_tty_secret second
      echo
    fi
    if [ "$first" != "$second" ]; then
      warn "the two entries differ — try again"
      continue
    fi
    break
  done
  printf -v "$__name" '%s' "$first"
  first=""
  second=""
}

# ui_confirm "question" default  → exit 0 for yes, 1 for no
ui_confirm() {
  local question="$1" default="${2:-no}" answer="" gum_default=false suffix="[y/N]"
  case "$default" in
    [yY]*|1|true) gum_default=true; suffix="[Y/n]" ;;
    *)            gum_default=false; suffix="[y/N]" ;;
  esac
  case "$UI_MODE" in
    none)
      if [ "$gum_default" = true ]; then return 0; else return 1; fi
      ;;
    gum)
      # Deliberately no crash detection here: `gum confirm` answers "No" with status 1,
      # which is indistinguishable from a crash, and guessing wrong would flip a real
      # "No" into a re-ask. It does not need one — the first widget of the flow is
      # always an input (the username), so a gum that is broken on this terminal has
      # already degraded the whole run to plain prompts before any confirm runs.
      if gum confirm --default="$gum_default" --affirmative "Yes" --negative "No" \
          --selected.background "$C_PRIMARY" "$question"; then
        return 0
      fi
      return 1
      ;;
    *)
      printf '%s %s ' "$question" "$suffix"
      read_tty answer
      answer="$(printf '%s' "$answer" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
      if [ -z "$answer" ]; then
        if [ "$gum_default" = true ]; then return 0; else return 1; fi
      fi
      case "$answer" in
        y|yes) return 0 ;;
        *)     return 1 ;;
      esac
      ;;
  esac
}

# ui_filter VAR "placeholder" < list-on-stdin
# Redirection, never a pipe: a pipe would run this in a subshell and lose the answer.
ui_filter() {
  local __name="$1" __placeholder="${2:-}" __value="" __line="" __count=0 __choice="" __item=""
  local __list="" __rc=0
  local __items=()
  if [ "$UI_MODE" = none ]; then
    printf -v "$__name" '%s' ""
    return 0
  fi
  # Buffer the list BEFORE gum sees it. gum consumes stdin, so if it dies mid-read the
  # plain fallback would have an empty or truncated list left to offer.
  while IFS= read -r __line; do
    if [ -n "$__line" ]; then
      __items+=("$__line")
      __list+="$__line"$'\n'
    fi
  done
  __count="${#__items[@]}"
  if [ "$__count" -eq 0 ]; then
    printf -v "$__name" '%s' ""
    return 0
  fi
  if [ "$UI_MODE" = gum ]; then
    __value="$(gum filter --height 12 --placeholder "$__placeholder" --prompt '> ' \
      --prompt.foreground "$C_PRIMARY" --indicator.foreground "$C_PRIMARY" \
      <<<"${__list%$'\n'}")" || __rc=$?
    if [ "$__rc" -eq 0 ]; then
      printf -v "$__name" '%s' "$__value"
      return 0
    fi
    __value=""
    if ! ui_gum_failed "$__rc"; then
      # The user aborted on purpose — hand back nothing, as before.
      printf -v "$__name" '%s' ""
      return 0
    fi
    # Degraded to plain: fall through and offer the buffered list instead.
  fi
  if [ "$__count" -gt 30 ]; then
    # A numbered menu over hundreds of entries is unusable — ask for the exact value.
    ui_note "$__count options — type the exact value (for example: $__placeholder)"
    printf '> '
    read_tty __value
    __value="$(printf '%s' "$__value" | tr -d '[:space:]')"
    local found=""
    for __item in "${__items[@]}"; do
      if [ "$__item" = "$__value" ]; then
        found=yes
        break
      fi
    done
    if [ -z "$found" ]; then
      warn "'$__value' is not in the list — skipping"
      __value=""
    fi
  else
    local index=1
    for __item in "${__items[@]}"; do
      printf '  %2d) %s\n' "$index" "$__item"
      index=$(( index + 1 ))
    done
    printf '> pick a number: '
    read_tty __choice
    case "$__choice" in
      ''|*[!0-9]*) __value="" ;;
      *)
        if [ "$__choice" -ge 1 ] && [ "$__choice" -le "$__count" ]; then
          __value="${__items[$(( __choice - 1 ))]}"
        else
          __value=""
        fi
        ;;
    esac
  fi
  printf -v "$__name" '%s' "$__value"
}

# ─────────────────────────────────────────────────────────────────────────────
# 4. Every question up front, before anything on the system changes.
# ─────────────────────────────────────────────────────────────────────────────
lowercase() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

valid_username() {
  grep -qE '^[a-z][a-z0-9_-]{0,31}$' <<<"$1"
}

sanitize_pubkey() {
  # Windows clipboards carry CRLF and people paste whole files, so: first line only,
  # no carriage returns, no surrounding blanks. Pure parameter expansion — a pipeline
  # here would put a SIGPIPE race between the script and `set -o pipefail`.
  local key="${1%%$'\n'*}"
  key="${key//$'\r'/}"
  key="${key#"${key%%[![:space:]]*}"}"
  key="${key%"${key##*[![:space:]]}"}"
  printf '%s' "$key"
}

valid_pubkey() {
  local key="$1"
  if [ -z "$key" ]; then
    return 1
  fi
  if command -v ssh-keygen >/dev/null 2>&1; then
    ssh-keygen -l -f /dev/stdin <<<"$key" >/dev/null 2>&1
    return $?
  fi
  grep -qE '^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp[0-9]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/]+=*( .*)?$' <<<"$key"
}

current_timezone() {
  local tz=""
  if command -v timedatectl >/dev/null 2>&1; then
    tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  fi
  if [ -z "$tz" ] && [ -r /etc/timezone ]; then
    tz="$(head -n1 /etc/timezone 2>/dev/null || true)"
  fi
  if [ -z "$tz" ] && [ -L /etc/localtime ]; then
    tz="$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || true)"
  fi
  printf '%s' "${tz:-UTC}"
}

valid_timezone() {
  [ -n "$1" ] && [ -f "/usr/share/zoneinfo/$1" ]
}

gather_input() {
  CURRENT_STEP="collecting answers"
  ask_username
  ask_password
  ask_pubkey
  ask_timezone
}

ask_username() {
  local candidate="" uid=""
  while :; do
    if [ "$UI_MODE" = none ]; then
      candidate="${IVA_USER:-}"
      if [ -z "$candidate" ]; then
        die "IVA_USER is required without a terminal. Example:
  IVA_USER=iva IVA_PASS='choose-a-strong-one' IVA_PUBKEY=\"\$(cat ~/.ssh/id_ed25519.pub)\" \\
    bash bootstrap.sh --non-interactive"
      fi
    else
      ui_note "Iva runs as this user, never as root — its shell tool inherits these permissions."
      ui_input candidate "Login for the everyday sudo user" "iva"
      candidate="$(printf '%s' "$candidate" | tr -d '[:space:]')"
      if [ -z "$candidate" ]; then
        candidate="iva"
      fi
    fi

    if ! valid_username "$candidate"; then
      if [ "$UI_MODE" = none ]; then
        die "IVA_USER='$candidate' is not a valid login: start with a lowercase letter, then lowercase letters, digits, '_' or '-', 32 characters max."
      fi
      warn "'$candidate' is not a valid login: start with a lowercase letter, then lowercase letters, digits, '_' or '-', 32 characters max"
      continue
    fi

    if id -u "$candidate" >/dev/null 2>&1; then
      uid="$(id -u "$candidate")"
      if [ "$uid" -lt 1000 ]; then
        if [ "$UI_MODE" = none ]; then
          die "'$candidate' is a system account (uid $uid) — pick another name"
        fi
        warn "'$candidate' is a system account (uid $uid) — pick another name"
        continue
      fi
      if [ "$UI_MODE" = none ] || ui_confirm "User $candidate exists. Use it?" yes; then
        TARGET_USER="$candidate"
        CREATE_USER=false
        return 0
      fi
      continue
    fi

    TARGET_USER="$candidate"
    CREATE_USER=true
    return 0
  done
}

ask_password() {
  if [ "$CREATE_USER" != true ]; then
    return 0
  fi
  if [ "$UI_MODE" = none ]; then
    TARGET_PASS="${IVA_PASS:-}"
    if [ -z "$TARGET_PASS" ]; then
      die "IVA_PASS is required: user '$TARGET_USER' does not exist yet and has to be created with a password."
    fi
    return 0
  fi
  ui_password TARGET_PASS "Password for $TARGET_USER (you will need it to log in)"
}

# Keys are a headless-only feature. The interactive flow deliberately asks nothing here:
# pasting a public key is a step too far for the people this bootstrap is written for, so
# they log in with the password they just set and hardening stops at PermitRootLogin no.
ask_pubkey() {
  local candidate=""

  if [ "$UI_MODE" != none ]; then
    PUBKEY=""
    DISABLE_PASSWORD_AUTH=false
    return 0
  fi

  candidate="$(sanitize_pubkey "${IVA_PUBKEY:-}")"
  if [ -n "$candidate" ]; then
    if valid_pubkey "$candidate"; then
      PUBKEY="$candidate"
    else
      warn "IVA_PUBKEY does not look like an SSH public key — continuing without it"
    fi
  fi
  case "$(lowercase "${IVA_DISABLE_PASSWORD_AUTH:-}")" in
    true|yes|1)  DISABLE_PASSWORD_AUTH=true ;;
    false|no|0)  DISABLE_PASSWORD_AUTH=false ;;
    *)           if [ -n "$PUBKEY" ]; then DISABLE_PASSWORD_AUTH=true; else DISABLE_PASSWORD_AUTH=false; fi ;;
  esac
  # Without a key, disabling password logins locks everyone out. Never do it.
  if [ -z "$PUBKEY" ]; then
    DISABLE_PASSWORD_AUTH=false
  fi
}

ask_timezone() {
  local current list_file=""
  current="$(current_timezone)"

  if [ "$UI_MODE" = none ]; then
    TIMEZONE_CHOICE="${IVA_TZ:-}"
    if [ -n "$TIMEZONE_CHOICE" ] && ! valid_timezone "$TIMEZONE_CHOICE"; then
      warn "IVA_TZ='$TIMEZONE_CHOICE' is not a known IANA timezone — keeping $current"
      TIMEZONE_CHOICE=""
    fi
    return 0
  fi

  if ! ui_confirm "Set the server timezone? (current: $current)" no; then
    return 0
  fi
  if ! command -v timedatectl >/dev/null 2>&1; then
    ui_input TIMEZONE_CHOICE "IANA timezone" "Europe/Berlin"
  else
    if ! list_file="$(mktemp 2>/dev/null)"; then
      ui_input TIMEZONE_CHOICE "IANA timezone" "Europe/Berlin"
    else
      timedatectl list-timezones >"$list_file" 2>/dev/null || true
      ui_filter TIMEZONE_CHOICE "Europe/Berlin" <"$list_file"
      rm -f "$list_file"
    fi
  fi
  TIMEZONE_CHOICE="$(printf '%s' "$TIMEZONE_CHOICE" | tr -d '[:space:]')"
  if [ -n "$TIMEZONE_CHOICE" ] && ! valid_timezone "$TIMEZONE_CHOICE"; then
    warn "'$TIMEZONE_CHOICE' is not a known IANA timezone — keeping $current"
    TIMEZONE_CHOICE=""
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 5. Timezone
# ─────────────────────────────────────────────────────────────────────────────
set_timezone() {
  section "Time zone"
  local current
  current="$(current_timezone)"
  if [ -z "$TIMEZONE_CHOICE" ]; then
    ok "Left unchanged ($current)"
    return 0
  fi
  if [ "$current" = "$TIMEZONE_CHOICE" ]; then
    ok "Already $TIMEZONE_CHOICE"
    return 0
  fi
  if have_systemd && command -v timedatectl >/dev/null 2>&1; then
    if timedatectl set-timezone "$TIMEZONE_CHOICE" >>"$LOG_FILE" 2>&1; then
      ok "Timezone set to $TIMEZONE_CHOICE"
      return 0
    fi
    warn "timedatectl failed — falling back to /etc/localtime"
  fi
  if ln -sf "/usr/share/zoneinfo/$TIMEZONE_CHOICE" /etc/localtime 2>>"$LOG_FILE"; then
    printf '%s\n' "$TIMEZONE_CHOICE" >/etc/timezone 2>>"$LOG_FILE" || true
    ok "Timezone set to $TIMEZONE_CHOICE"
  else
    warn "couldn't set the timezone — keeping $current"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 6. System update. Lock timeout + confdef/confold so a held dpkg lock or a
#    changed config file can never turn this into an interactive prompt.
# ─────────────────────────────────────────────────────────────────────────────
apt_get() {
  apt-get -y -qq \
    -o DPkg::Lock::Timeout=300 \
    -o Dpkg::Options::=--force-confdef \
    -o Dpkg::Options::=--force-confold \
    "$@"
}

apt_upgrade() {
  section "System update"
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  export -f apt_get
  run_sh "Refreshing the package index" "Package index refreshed" 'apt_get update' \
    || warn "apt-get update reported problems — continuing anyway"
  run_sh "Upgrading installed packages (the slow one)" "System up to date" 'apt_get full-upgrade' \
    || warn "some packages did not upgrade — see $LOG_FILE"
}

# ─────────────────────────────────────────────────────────────────────────────
# 7. System packages, including headless browser libraries and GitHub CLI.
# ─────────────────────────────────────────────────────────────────────────────
package_installed() {
  local status
  status="$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)"
  case "$status" in
    *"install ok installed"*) return 0 ;;
  esac
  return 1
}

install_packages() {
  section "Packages"
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  export -f apt_get
  local missing=() pkg
  for pkg in $PACKAGES; do
    if apt-cache show "${pkg}t64" >/dev/null 2>&1; then pkg="${pkg}t64"; fi
    if ! package_installed "$pkg"; then
      missing+=("$pkg")
    fi
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    ok "All system packages already present"
  else
    export IVA_APT_PKGS="${missing[*]}"
    # shellcheck disable=SC2016  # $IVA_APT_PKGS must expand in the child, not here
    if run_sh "Installing: ${missing[*]}" "System packages installed" \
        'apt_get install $IVA_APT_PKGS'; then
      :
    else
      warn "some packages did not install — install.sh will report what is still missing"
    fi
    unset IVA_APT_PKGS
  fi
}

# Run one command as $TARGET_USER, never as root. Both callers below write inside
# somebody else's home — ~/.local/bin and ~/.ssh — and an existing account is allowed
# here (see pick_user), so either path can already be a symlink the user put there.
# Root following one would create or overwrite whatever it points at and hand the
# result over: a way to have root make the user the owner of, say, /etc. Under the
# user's own uid the same command can only touch what the user could touch anyway, so
# there is no ownership to repair afterwards and no group to look up. stdin is passed
# through, which is how content root holds reaches a file without a root redirect.
as_target_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$TARGET_USER" -- "$@"
  else
    # No runuser (it ships with util-linux, so this is the unusual box): su takes the
    # command as positional parameters, which keeps a path with spaces or quotes in it
    # out of the parsing done by the shell su starts.
    #
    # The `--` is load-bearing, not decoration. su's own getopt has no leading `+`, so
    # it permutes: without the marker it reaches into the payload and eats anything
    # option-shaped there. `mkdir -p` would arrive as a plain `mkdir` (su swallows -p
    # as --preserve-environment) and `tee -a` or `grep -qxF` would abort su itself on
    # an invalid option — leaving a box with no authorized key and, with
    # IVA_DISABLE_PASSWORD_AUTH, an owner locked out of their own server.
    su -s /bin/sh -c 'exec "$0" "$@"' -- "$TARGET_USER" "$@"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 8. The everyday user: sudo group + lingering + ~/.local/bin.
#    Lingering is not optional: without it the user's systemd instance never
#    starts at boot and installing Iva fails with "Failed to connect to bus".
# ─────────────────────────────────────────────────────────────────────────────
create_user() {
  section "User account"
  if [ "$CREATE_USER" = true ]; then
    CURRENT_STEP="creating the user $TARGET_USER"
    if ! useradd -m -s /bin/bash "$TARGET_USER" >>"$LOG_FILE" 2>&1; then
      die "couldn't create the user $TARGET_USER — see $LOG_FILE"
    fi
    # The password goes in on stdin: never in argv, never in ps, never in the log.
    if ! printf '%s:%s\n' "$TARGET_USER" "$TARGET_PASS" | chpasswd; then
      die "couldn't set the password for $TARGET_USER"
    fi
    TARGET_PASS=""
    unset TARGET_PASS
    ok "User $TARGET_USER created"
  else
    ok "Using the existing user $TARGET_USER"
  fi

  local groups
  groups="$(id -nG "$TARGET_USER" 2>/dev/null || true)"
  if [[ " $groups " == *" sudo "* ]]; then
    ok "$TARGET_USER is already in the sudo group"
  elif usermod -aG sudo "$TARGET_USER" >>"$LOG_FILE" 2>&1; then
    ok "$TARGET_USER added to the sudo group"
  else
    warn "couldn't add $TARGET_USER to the sudo group — do it by hand: usermod -aG sudo $TARGET_USER"
  fi

  ensure_local_bin
  enable_linger
}

# The directory has to exist BEFORE the user's first login. install.sh puts the `iva`
# command in ~/.local/bin, but the stock ~/.profile only adds that directory to PATH
# when it is already there as the shell starts — created later, it stays off PATH for
# the whole session, and `iva help` answers "command not found" right after an install
# that reported success. Created here, the first login already has it.
#
# Created AS THE USER (as_target_user above), never as root. A missing home is a warn,
# not something to invent: a home directory that passwd promises but nobody created is
# not this script's to write, and writing one at root's umask hands back a home the
# user cannot use.
ensure_local_bin() {
  CURRENT_STEP="preparing ~/.local/bin for $TARGET_USER"
  local home created=false
  # `|| true` inside the substitution, or pipefail hands the failed lookup to the ERR
  # trap and the whole bootstrap dies here — with the check right below unreached.
  home="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || true)"
  if [ -z "$home" ] || [ ! -d "$home" ]; then
    warn "no home directory for $TARGET_USER — skipping ~/.local/bin; after installing Iva, run 'exec bash -l' to put the iva command on PATH"
    return 0
  fi
  if as_target_user mkdir -p "$home/.local/bin" >>"$LOG_FILE" 2>&1; then
    created=true
  fi
  if [ "$created" = true ]; then
    ok "~/.local/bin ready — the iva command is on PATH from the first login"
  else
    warn "couldn't create $home/.local/bin as $TARGET_USER — after installing Iva, run 'exec bash -l' to put the iva command on PATH"
  fi
}

enable_linger() {
  CURRENT_STEP="enabling lingering for $TARGET_USER"
  if have_systemd && command -v loginctl >/dev/null 2>&1; then
    if loginctl enable-linger "$TARGET_USER" >>"$LOG_FILE" 2>&1; then
      ok "Lingering enabled — Iva's services keep running after logout"
      return 0
    fi
    warn "loginctl failed — writing the linger marker directly"
  fi
  if mkdir -p /var/lib/systemd/linger 2>>"$LOG_FILE" && touch "/var/lib/systemd/linger/$TARGET_USER" 2>>"$LOG_FILE"; then
    ok "Linger marker written for $TARGET_USER"
  else
    warn "couldn't enable lingering — run 'loginctl enable-linger $TARGET_USER' before installing Iva"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Authorized key — headless only (IVA_PUBKEY), so it gets no section of its own and
# stays silent when there is no key. When there is one, it reports under User account.
# ─────────────────────────────────────────────────────────────────────────────
install_pubkey() {
  if [ -z "$PUBKEY" ]; then
    return 0
  fi
  CURRENT_STEP="authorizing the SSH key"
  # Everything here runs as the user, for the reason spelled out at as_target_user:
  # this function is reached for an EXISTING account too, whose ~/.ssh may already be
  # a symlink pointing anywhere. The key itself travels down stdin into the user's own
  # `tee`; a root redirect would write through that symlink instead.
  local home ssh_dir keys
  # `|| true` inside the substitution: without it pipefail hands a failed lookup to the
  # ERR trap and kills the bootstrap, with the check right below unreached.
  home="$(getent passwd "$TARGET_USER" 2>/dev/null | cut -d: -f6 || true)"
  if [ -z "$home" ] || [ ! -d "$home" ]; then
    warn "no home directory for $TARGET_USER — the key was not authorized; log in with the password and add it by hand"
    return 0
  fi
  ssh_dir="$home/.ssh"
  keys="$ssh_dir/authorized_keys"

  if ! as_target_user mkdir -p "$ssh_dir" >>"$LOG_FILE" 2>&1; then
    warn "couldn't create $ssh_dir as $TARGET_USER — the key was not authorized; log in with the password and add it by hand"
    return 0
  fi
  # mkdir leaves the directory at whatever the user's umask allows — 0755 by default,
  # 0775 where umask is 002 — and sshd under StrictModes refuses an authorized_keys
  # whose directory is writable by group or other, which is what 0775 is. Tightened
  # before the key is written, so the file is never created inside a directory anybody
  # else could still have swapped it out of.
  as_target_user chmod 700 "$ssh_dir" >>"$LOG_FILE" 2>&1 \
    || warn "couldn't set 700 on $ssh_dir — sshd may refuse the key until it is fixed"
  # Create the file and lock it to 0600 BEFORE anything reads from or appends to it.
  # This closes two holes at once. First, the umask window: `tee -a` would otherwise
  # create authorized_keys at 0664 (0666 & ~umask) and only a later chmod would tighten
  # it, so a fixed file created here means the append never widens it. Second, the
  # "already authorized" path below returns early — if the file were left at whatever a
  # previous run or a careless admin set, sshd StrictModes would reject a 0666 file and
  # passwords would already be off. A file we cannot create or lock down is not a safely
  # authorized key: warn and leave KEY_AUTHORIZED false so passwords stay on.
  if ! as_target_user touch "$keys" >>"$LOG_FILE" 2>&1; then
    warn "couldn't create $keys as $TARGET_USER — the key was not authorized; log in with the password and add it by hand"
    return 0
  fi
  if ! as_target_user chmod 600 "$keys" >>"$LOG_FILE" 2>&1; then
    warn "couldn't set 600 on $keys — the key was not authorized; log in with the password and add it by hand"
    return 0
  fi
  if as_target_user grep -qxF "$PUBKEY" "$keys" >/dev/null 2>&1; then
    KEY_AUTHORIZED=true
    ok "Key already authorized for $TARGET_USER"
    return 0
  fi
  if printf '%s\n' "$PUBKEY" | as_target_user tee -a "$keys" >>"$LOG_FILE" 2>&1; then
    as_target_user chmod 600 "$keys" >>"$LOG_FILE" 2>&1 \
      || warn "couldn't set 600 on $keys — sshd may refuse the key until it is fixed"
    KEY_AUTHORIZED=true
    ok "Key authorized for $TARGET_USER"
  else
    warn "couldn't write $keys as $TARGET_USER — the key was not authorized; log in with the password and add it by hand"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 10. Firewall. SSH is the only inbound port — Iva listens on nothing public.
# ─────────────────────────────────────────────────────────────────────────────
sshd_binary() {
  if command -v sshd >/dev/null 2>&1; then
    command -v sshd
  elif [ -x /usr/sbin/sshd ]; then
    printf '%s' /usr/sbin/sshd
  else
    return 1
  fi
}

detect_ssh_port() {
  local binary port=""
  if binary="$(sshd_binary)"; then
    port="$("$binary" -T 2>/dev/null | awk '/^port /{print $2; exit}')" || port=""
  fi
  case "$port" in
    ''|*[!0-9]*) port=22 ;;
  esac
  printf '%s' "$port"
}

setup_ufw() {
  section "Firewall"
  SSH_PORT="$(detect_ssh_port)"
  if ! command -v ufw >/dev/null 2>&1; then
    warn "ufw is not installed — skipping the firewall"
    return 0
  fi
  CURRENT_STEP="configuring the firewall"
  # Rules first, enable second: never lock the current session out mid-configuration.
  ufw default deny incoming >>"$LOG_FILE" 2>&1 || warn "couldn't set the default deny-incoming policy"
  ufw default allow outgoing >>"$LOG_FILE" 2>&1 || warn "couldn't set the default allow-outgoing policy"
  if ! ufw allow "${SSH_PORT}/tcp" comment 'SSH' >>"$LOG_FILE" 2>&1; then
    warn "couldn't add the SSH rule — not enabling the firewall"
    return 0
  fi
  local ufw_status
  ufw_status="$(ufw status 2>/dev/null || true)"
  if grep -q '^Status: active' <<<"$ufw_status"; then
    ok "Firewall already active — SSH on port $SSH_PORT allowed"
  elif have_systemd; then
    if ufw --force enable >>"$LOG_FILE" 2>&1; then
      ok "Firewall on — SSH (port $SSH_PORT) is the only way in"
    else
      warn "couldn't enable ufw — the rules are written, turn it on later with 'ufw enable'"
    fi
  else
    warn "no systemd (container?) — ufw rules are written but not enabled"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 11. fail2ban
# ─────────────────────────────────────────────────────────────────────────────
setup_fail2ban() {
  section "Intrusion protection"
  if ! command -v fail2ban-server >/dev/null 2>&1; then
    warn "fail2ban is not installed — skipping"
    return 0
  fi
  CURRENT_STEP="configuring fail2ban"
  if [ -f "$FAIL2BAN_JAIL" ] && ! grep -qF "$MARKER" "$FAIL2BAN_JAIL" 2>/dev/null; then
    warn "$FAIL2BAN_JAIL exists and was not written by this script — leaving it alone"
  else
    cat >"$FAIL2BAN_JAIL" <<EOF
$MARKER
[sshd]
enabled  = true
# Ubuntu 24.04 minimal has no /var/log/auth.log, so the file backend never starts
# and the jail stays silently dead. Read the journal instead.
backend  = systemd
port     = $SSH_PORT
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
    chmod 644 "$FAIL2BAN_JAIL"
    ok "Jail written: 5 failed logins in 10 minutes → 1 hour ban"
  fi

  if ! have_systemd || ! command -v systemctl >/dev/null 2>&1; then
    warn "no systemd — the fail2ban config is written but the service is not started"
    return 0
  fi
  if systemctl is-active --quiet fail2ban 2>/dev/null; then
    if systemctl restart fail2ban >>"$LOG_FILE" 2>&1; then
      ok "fail2ban restarted with the new jail"
    else
      warn "couldn't restart fail2ban — check 'systemctl status fail2ban'"
    fi
  elif systemctl enable --now fail2ban >>"$LOG_FILE" 2>&1; then
    ok "fail2ban enabled and running"
  else
    warn "couldn't start fail2ban — check 'systemctl status fail2ban'"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 12. Unattended security upgrades
#     Worth knowing where it leads: this timer patches the box every day, and apt
#     leaves $REBOOT_REQUIRED_FLAG behind for glibc, openssl and dbus just as much as
#     for a kernel. So a server prepared here raises the flag again within days of
#     being installed, without anyone touching it — on a live machine it is a normal
#     state, not evidence of a broken one. What reads it: reboot_if_needed below, and
#     install.sh's preflight (see it for how it reacts).
# ─────────────────────────────────────────────────────────────────────────────
setup_unattended_upgrades() {
  section "Automatic security updates"
  CURRENT_STEP="enabling unattended upgrades"
  cat >"$AUTO_UPGRADES_CONF" <<EOF
$MARKER
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  chmod 644 "$AUTO_UPGRADES_CONF"
  ok "Package lists and security upgrades run daily"
  if ! have_systemd || ! command -v systemctl >/dev/null 2>&1; then
    warn "no systemd — the timers will start on the next boot with systemd present"
    return 0
  fi
  if systemctl enable --now unattended-upgrades >>"$LOG_FILE" 2>&1; then
    ok "unattended-upgrades service active"
  else
    warn "couldn't start unattended-upgrades — check 'systemctl status unattended-upgrades'"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 13. sshd hardening — always LAST, and always a reload (SIGHUP), so the session
#     you are typing in survives even if something is wrong.
# ─────────────────────────────────────────────────────────────────────────────
harden_ssh() {
  section "SSH hardening"
  # DISABLE_PASSWORD_AUTH was decided back at ask_pubkey from "a key was provided". But
  # a provided key that never reached authorized_keys — no home, an unwritable ~/.ssh,
  # perms we could not set — would lock the owner out the instant we turn passwords off.
  # Bind the switch to the key being REALLY authorized, not to the intent. No authorized
  # key ⇒ passwords stay on, whatever was asked for. Decided first, before any early
  # return below, so the invariant holds on every path out of hardening.
  if [ "$DISABLE_PASSWORD_AUTH" = true ] && [ "$KEY_AUTHORIZED" != true ]; then
    warn "the SSH key was not authorized — leaving password logins ON so you are not locked out; log in with the password, add the key by hand, then turn passwords off"
    DISABLE_PASSWORD_AUTH=false
  fi
  if [ ! -f "$SSHD_MAIN_CONFIG" ]; then
    warn "no $SSHD_MAIN_CONFIG — skipping hardening"
    return 0
  fi
  CURRENT_STEP="hardening sshd"
  # Without an Include, a drop-in file is dead weight and we would report a lie.
  if ! grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d' "$SSHD_MAIN_CONFIG"; then
    die "$SSHD_MAIN_CONFIG has no Include for $SSHD_DROPIN_DIR — refusing to harden blindly.
  Everything before this step is done: user $TARGET_USER, firewall, fail2ban, updates.
  Either add 'Include /etc/ssh/sshd_config.d/*.conf' to $SSHD_MAIN_CONFIG and re-run,
  or set PermitRootLogin no in $SSHD_MAIN_CONFIG yourself, then continue with install.sh."
  fi

  local binary
  if ! binary="$(sshd_binary)"; then
    warn "no sshd binary found — skipping hardening"
    return 0
  fi

  mkdir -p "$SSHD_DROPIN_DIR"
  chmod 755 "$SSHD_DROPIN_DIR"
  local backup=""
  if [ -f "$SSHD_DROPIN" ]; then
    backup="$(mktemp)"
    cp -p "$SSHD_DROPIN" "$backup"
  fi

  {
    printf '%s\n' "$MARKER"
    printf '# The 00- prefix is deliberate: sshd keeps the FIRST value it reads for a\n'
    printf '# keyword, and cloud images ship 50-cloud-init.conf with PasswordAuthentication\n'
    printf '# yes. A higher-numbered file would be read second and lose.\n'
    printf 'PermitRootLogin no\n'
    if [ "$DISABLE_PASSWORD_AUTH" = true ]; then
      printf 'PasswordAuthentication no\n'
      printf 'KbdInteractiveAuthentication no\n'
    fi
  } >"$SSHD_DROPIN"
  chmod 644 "$SSHD_DROPIN"

  # sshd -t refuses to validate without the privilege separation directory, and on
  # socket-activated images (DigitalOcean's Ubuntu 24.04) it does not exist until
  # sshd.service has started at least once. Non-fatal on purpose: dying here would
  # leave the drop-in above unvalidated and un-rolled-back. Let sshd -t be the gate.
  if [ ! -d /run/sshd ]; then
    install -d -m 0755 /run/sshd >>"$LOG_FILE" 2>&1 || true
  fi

  if ! "$binary" -t >>"$LOG_FILE" 2>&1; then
    rm -f "$SSHD_DROPIN"
    if [ -n "$backup" ]; then
      cp -p "$backup" "$SSHD_DROPIN"
      rm -f "$backup"
    fi
    die "sshd rejected the hardened config — rolled back, nothing changed. See $LOG_FILE"
  fi
  if [ -n "$backup" ]; then
    rm -f "$backup"
  fi

  if have_systemd && command -v systemctl >/dev/null 2>&1; then
    # The unit is called ssh on Ubuntu, sshd on Debian/RHEL; on 24.04 it is socket
    # activated. reload = SIGHUP, which never drops established sessions.
    if systemctl reload ssh >>"$LOG_FILE" 2>&1 \
      || systemctl reload sshd >>"$LOG_FILE" 2>&1 \
      || systemctl try-reload-or-restart ssh >>"$LOG_FILE" 2>&1; then
      ok "sshd config reloaded — open sessions kept running"
    else
      warn "couldn't reload sshd — the config is valid; apply it later with 'systemctl reload ssh'"
    fi
  else
    warn "no systemd — the config is validated but not applied yet"
  fi

  # Verify the EFFECTIVE value, not the file we just wrote. `sshd -T` prints every
  # keyword lowercased, with the value that actually wins across all included files.
  local effective
  effective="$("$binary" -T 2>/dev/null || true)"
  if grep -qi '^permitrootlogin no' <<<"$effective"; then
    ok "Root login over SSH is off"
  else
    warn "PermitRootLogin is still on somewhere — check: sshd -T | grep -i permitrootlogin"
  fi
  if [ "$DISABLE_PASSWORD_AUTH" = true ]; then
    if grep -qi '^passwordauthentication no' <<<"$effective"; then
      ok "Password logins are off — key only"
    else
      warn "PasswordAuthentication is still on somewhere — check: sshd -T | grep -i passwordauthentication"
    fi
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 14. The card that tells you what to type next
# ─────────────────────────────────────────────────────────────────────────────
public_ip() {
  local ip=""
  ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ -z "$ip" ] || ! grep -qE '^[0-9a-fA-F:.]+$' <<<"$ip"; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [ -z "$ip" ]; then
    ip="<server-ip>"
  fi
  printf '%s' "$ip"
}

plain_card() {
  local width=0 line pad
  for line in "$@"; do
    if [ "${#line}" -gt "$width" ]; then
      width="${#line}"
    fi
  done
  echo
  printf '  +'
  printf '%*s' "$(( width + 4 ))" '' | tr ' ' '-'
  printf '+\n'
  printf '  |%*s|\n' "$(( width + 4 ))" ''
  for line in "$@"; do
    pad=$(( width - ${#line} ))
    printf '  |  %s%*s  |\n' "$line" "$pad" ''
  done
  printf '  |%*s|\n' "$(( width + 4 ))" ''
  printf '  +'
  printf '%*s' "$(( width + 4 ))" '' | tr ' ' '-'
  printf '+\n'
  echo
}

final_card() {
  CURRENT_STEP="printing the summary"
  local ip pending=false
  ip="$(public_ip)"
  if reboot_pending; then
    pending=true
  fi
  local card=("VPS ready for iva" "")
  if [ "$pending" = true ]; then
    # Card lines stay ASCII: plain_card pads by ${#line}, which counts bytes in a
    # non-UTF-8 locale, and one em dash is enough to leave the box visibly ragged.
    card+=(
      "A system update requires a reboot before installing Iva."
      "Reboot when ready: sudo reboot"
      "After reboot, continue from your LOCAL machine:"
    )
  else
    card+=("Next steps, from your LOCAL machine:")
  fi
  card+=(
    ""
    "  ssh $TARGET_USER@$ip"
    "  curl -fsSL $RAW_BASE/install.sh | bash"
    ""
  )
  if [ "$pending" = true ]; then
    card+=(
      "install.sh stops before installing packages until that reboot:"
      "a pending kernel upgrade makes every package install hang."
    )
  else
    card+=("Keep this root session open until you verify login in a NEW terminal.")
  fi
  if [ "$UI_MODE" = gum ] && [ -t 1 ]; then
    if gum style --border double --border-foreground "$C_PRIMARY" --padding "1 3" --margin "1 2" \
        "${card[@]}" 2>/dev/null; then
      :
    else
      plain_card "${card[@]}"
    fi
  else
    plain_card "${card[@]}"
  fi
  echo "  Log: $LOG_FILE"
  echo
  log "bootstrap finished for user $TARGET_USER"
}

# ─────────────────────────────────────────────────────────────────────────────
# 15. Reboot after a kernel upgrade. Not a section of its own: it runs after the
#     card and only when apt left the flag behind. This is the cure, not a
#     workaround — while a reboot is pending, needrestart opens an ncurses dialog
#     inside every apt run, install.sh paints it behind a spinner where nobody can
#     answer it, and the install hangs forever. install.sh refuses to start until
#     the flag is gone, so the reboot has to happen here.
# ─────────────────────────────────────────────────────────────────────────────
reboot_pending() {
  [ -e "$REBOOT_REQUIRED_FLAG" ] && have_systemd
}

reboot_if_needed() {
  reboot_pending || return 0
  CURRENT_STEP="rebooting after the kernel upgrade"
  local do_reboot=false
  if [ "$UI_MODE" != none ]; then
    if ui_confirm "Reboot now? (recommended)" yes; then
      do_reboot=true
    fi
  else
    # Headless default is false: rebooting in the middle of someone else's
    # automation is exactly the kind of surprise that has to be asked for.
    case "$(lowercase "${IVA_REBOOT:-}")" in
      true|yes|1) do_reboot=true ;;
    esac
  fi
  if [ "$do_reboot" != true ]; then
    warn "Not rebooting. install.sh will refuse to install packages until the kernel upgrade is applied — run 'sudo reboot' when you are ready, then continue with the two commands above."
    return 0
  fi
  log "rebooting after the kernel upgrade"
  step "Rebooting now — reconnect in about 30 seconds"
  # Let the card and the line above reach the terminal before the kernel takes it away.
  sleep 2
  reboot || warn "couldn't reboot — do it by hand: sudo reboot"
}

# ─────────────────────────────────────────────────────────────────────────────
# main
# ─────────────────────────────────────────────────────────────────────────────
main() {
  setup_colors
  trap on_err ERR
  trap 'stop_spinner' EXIT
  trap 'stop_spinner; exit 130' INT
  trap 'stop_spinner; exit 143' TERM

  preflight "$@"
  init_log
  install_gum
  show_banner
  gather_input

  set_timezone
  apt_upgrade
  install_packages
  create_user
  install_pubkey
  setup_ufw
  setup_fail2ban
  setup_unattended_upgrades
  harden_ssh
  final_card
  reboot_if_needed
}

# ─────────────────────────────────────────────────────────────────────────────
# Dispatcher. Nothing runs above this point, so a truncated download can only
# define functions — never half-configure a server. Keep this LAST in the file.
#   - real stdin (bash <(curl …))      → ask on stdin
#   - piped stdin but a terminal exists (curl … | bash) → ask on /dev/tty
#   - no terminal at all               → non-interactive, answers from the environment
# ─────────────────────────────────────────────────────────────────────────────
if [ -t 0 ]; then main "$@"
elif (: </dev/tty) 2>/dev/null; then main "$@" </dev/tty
else NON_INTERACTIVE=true main "$@"; fi
