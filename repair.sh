#!/usr/bin/env bash
set -Eeuo pipefail

# One command for an Iva that cannot update itself any more. It repairs nothing on its
# own: it puts the installation back on the release and hands the work to the one
# updater, exactly as `iva update` would.
#   curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/repair.sh | bash

INSTALL_DIR="${IVA_INSTALL_DIR:-${HOME}/iva}"

lang="en"
case "${AGENT_LANGUAGE:-}" in ru) lang="ru" ;; esac
if [ -z "${AGENT_LANGUAGE:-}" ] && [ -f "$INSTALL_DIR/.env" ]; then
  case "$(grep -E '^AGENT_LANGUAGE=' "$INSTALL_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' || true)" in
    ru) lang="ru" ;;
  esac
fi

# Каждое сообщение - двумя языками сразу, как их пишет установщик: en-строка первая.
say() { if [ "$lang" = "ru" ]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
die() { printf 'Iva repair failed: %s\n' "$*" >&2; exit 1; }
# Отказ, который читает владелец: тем же двуязычием, что и всё остальное.
fail() {
  if [ "$lang" = "ru" ]; then printf 'Ремонт Iva не выполнен: %s\n' "$2" >&2; else printf 'Iva repair failed: %s\n' "$1" >&2; fi
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js is required"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ] || die "Node 24 or newer is required"

[ -d "$INSTALL_DIR" ] || die "Iva was not found at $INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
HOME_DIR="$(cd "$HOME" && pwd -P)"
[ "$INSTALL_DIR" != "/" ] || die "unsafe installation path"
[ "$INSTALL_DIR" != "$HOME_DIR" ] || die "unsafe installation path"

# Самая свежая версия на диске - ею ремонтируется установка, у которой `current` потерян
# (обрыв на переключении): сам обновлятор переключение и доводит.
newest_version_entry() {
  local newest="" candidate
  for candidate in "$INSTALL_DIR"/versions/*/bin/iva.mjs; do
    [ -f "$candidate" ] || continue
    if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then newest="$candidate"; fi
  done
  printf '%s' "$newest"
}

# Уже на версионной раскладке: обновлятор в ней и есть весь ремонт. Дерево, которое
# только начало конвертироваться (есть и versions/, и .git), идёт ниже по пути чекаута:
# обновление доводит конверсию само.
if [ -f "$INSTALL_DIR/current/bin/iva.mjs" ]; then
  say "Updating Iva..." "Обновляю Iva..."
  exec node "$INSTALL_DIR/current/bin/iva.mjs" update
fi
if [ -d "$INSTALL_DIR/versions" ] && [ ! -d "$INSTALL_DIR/.git" ]; then
  entry="$(newest_version_entry)"
  [ -n "$entry" ] || fail \
    "the versions in $INSTALL_DIR have no Iva to run - reinstall with install.sh" \
    "в $INSTALL_DIR нет версии, которую можно запустить - переустановите через install.sh"
  say "The last update stopped while switching versions; starting the update from the version on disk." \
    "Прошлое обновление оборвалось на переключении версий; запускаю обновление из версии на диске."
  exec node "$entry" update
fi

# Дерево разработчика ремонт не трогает совсем, и раньше любой работы с git: `git reset
# --hard` ниже снёс бы незакоммиченную работу, а обновление такому дереву всё равно
# отказывает (scripts/cli/version-update-command.ts). Судится маркер в любой форме -
# файл, каталог, ссылка, - тем же `-e`, чем его читает предикат маршрута
# (`isManagedInstall`), и только у чекаута: версионную раскладку обновляют всегда, что бы
# ни лежало в её корне.
if [ -e "$INSTALL_DIR/.iva-dev" ]; then
  fail "this is a development checkout (.iva-dev): update it with git, build it with \`npm run build\`" \
    "это чекаут разработчика (.iva-dev): обновляйся через git, собирай \`npm run build\`"
fi

[ -f "$INSTALL_DIR/package.json" ] || die "package.json is missing"
node -e 'const p=require(process.argv[1]); if(p.name!=="iva") process.exit(1)' \
  "$INSTALL_DIR/package.json" || die "this is not an Iva installation"
[ -d "$INSTALL_DIR/.git" ] || die "Iva was not found at $INSTALL_DIR"

top="$(git -C "$INSTALL_DIR" rev-parse --show-toplevel)"
[ "$(cd "$top" && pwd -P)" = "$INSTALL_DIR" ] || die "invalid Iva checkout"

# Новая установка и ремонт ставят новейший выпуск (метку vX.Y.Z на ветке, ADR-0017), без
# меток — вершину ветки; IVA_BETA=1 или iva.beta=true — вершину. Ветка остаётся той же: за ней следит обновлятор. Та же функция
# стоит в install.sh и repair.sh: оба запускаются через curl | bash и самодостаточны.
checkout_release() {
  local tag target="${3:-HEAD}"
  if [ "${IVA_BETA:-}" = 1 ]; then git -C "$1" config --local iva.beta true; fi
  # Бета - ветка beta или прежний флаг (ADR-0018): вершина. Иначе новейший выпуск.
  if [ "$(git -C "$1" config --local --get iva.beta || true)" != true ] \
    && [ "$(git -C "$1" config --local --get iva.updateBranch || true)" != beta ]; then
    tag="$(git -C "$1" tag --list 'v*' --merged "$target" --sort=-v:refname \
      | grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' | head -n 1 || true)"
    if [ -n "$tag" ]; then target="$tag"; fi
  fi
  # $2 - коммит, стоявший до ремонта: новее цели (её потомок) - он и остаётся.
  if [ -n "${2:-}" ] && git -C "$1" merge-base --is-ancestor "$target" "$2" 2>/dev/null; then target="$2"; fi
  git -C "$1" reset -q --hard "$target"
}

# Ремонт запускает код, который сам же и притянул: тянуть его можно только из репозитория
# проекта. Локальный bare-репозиторий - фикстура теста, всё прочее чужое.
is_official_remote() {
  case "$1" in
    https://github.com/smixs/iva-agent|https://github.com/smixs/iva-agent.git|git@github.com:smixs/iva-agent|git@github.com:smixs/iva-agent.git|ssh://git@github.com/smixs/iva-agent|ssh://git@github.com/smixs/iva-agent.git) return 0 ;;
    https://github.com/smixs/iva|https://github.com/smixs/iva.git|git@github.com:smixs/iva|git@github.com:smixs/iva.git|ssh://git@github.com/smixs/iva|ssh://git@github.com/smixs/iva.git) return 0 ;;
    *) return 1 ;;
  esac
}

origin_url="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
if ! is_official_remote "$origin_url"; then
  [ -d "$origin_url" ] \
    && [ "$(git --git-dir="$origin_url" rev-parse --is-bare-repository 2>/dev/null)" = "true" ] \
    || die "origin is not github.com/smixs/iva-agent"
fi

# Та же ветка, на которой сидит установка: `iva rollback` пишет её в git config, и
# ремонт не имеет права молча вернуть человека на main.
branch="$(git -C "$INSTALL_DIR" config --get iva.updateBranch || true)"
# IVA_BETA=1 и прежний флаг при main или без ветки (как у обновлятора) - ветка beta.
if [ "${IVA_BETA:-}" = 1 ] || { [ "$(git -C "$INSTALL_DIR" config --get iva.beta || true)" = true ] && [ "${branch:-main}" = main ]; }; then branch=beta; fi
[ -n "$branch" ] || branch="main"

say "Getting Iva $branch..." "Получаю Iva ($branch)..."
installed="$(git -C "$INSTALL_DIR" rev-parse -q --verify HEAD || true)"
# Вся сеть - до сброса: головы всех веток origin, своя ветка, метки. Не ответил origin -
# ничего не сброшено. FETCH_HEAD, не `origin/<ветка>`: remote-tracking ref может не быть.
no_origin() { fail "can't check origin, repair cancelled: nothing changed" "не могу проверить origin, ремонт отменён: ничего не изменено"; }
heads="$(git -C "$INSTALL_DIR" ls-remote --heads origin | cut -f1)" || no_origin
git -C "$INSTALL_DIR" fetch --quiet origin $heads || no_origin
git -C "$INSTALL_DIR" fetch --quiet origin "$branch" || no_origin
tip="$(git -C "$INSTALL_DIR" rev-parse FETCH_HEAD)"
git -C "$INSTALL_DIR" fetch --quiet --prune origin "+refs/tags/*:refs/tags/*" || no_origin
# Коммит до ремонта в счёт только на main и только из origin (любая его ветка): правку
# владельца ремонт затирает, а своя ветка (release/<v>) ставится как есть.
keep=""
if [ "$branch" = main ] && [ -n "$installed" ]; then
  for head in $heads; do git -C "$INSTALL_DIR" merge-base --is-ancestor "$installed" "$head" && { keep="$installed"; break; }; done
fi
# Ветка пишется до сброса: не записалась - ничего не сброшено.
git -C "$INSTALL_DIR" config --local iva.updateBranch "$branch"
checkout_release "$INSTALL_DIR" "$keep" "$tip"
say "Local changes to Iva's code were removed." "Локальные правки в коде удалены."
say "Your .env, data/, vault/ and attachments/ stay in place." "Ваши .env, data/, vault/ и attachments/ остались на месте."

exec node "$INSTALL_DIR/bin/iva.mjs" update
