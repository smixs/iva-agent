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

# Нижняя граница новейшего выпуска (update-compat.json) и ступенька: последний выпуск,
# чей обновлятор принимает любую установку ниже границы. Установку ниже границы ремонт
# ведёт двумя обновлениями - на ступеньку, затем на новейший. На первое Update branch
# закреплён на ступеньке; ветка владельца на это время записана в файл и возвращается, чем
# бы ремонт ни кончился (specs/UpdateFloor.tla: Repaired, BranchKept).
FLOOR="0.5.0"
STEP="0.5.11"
STEP_BRANCH="release/$STEP"
RETURN_FILE="$INSTALL_DIR/.iva-repair-branch"
# Дерево ступеньки со своими зависимостями: из него идёт первое обновление чекаута.
STEP_TREE="$INSTALL_DIR/.iva-repair-step"
no_origin() { fail "can't check origin, repair cancelled: nothing changed" "не могу проверить origin, ремонт отменён: ничего не изменено"; }

# $1 - package.json того, что стоит. Нечитаемая версия - не ниже границы: ступеньки нет.
below_floor() {
  node -e '
    const own = String(require(process.argv[1]).version ?? "");
    const core = own.replace(/-[0-9A-Za-z.-]+$/u, "");
    const [a, b] = [core, process.argv[2]].map((v) => v.split(".").map(Number));
    if (a.length !== 3 || a.some(Number.isNaN)) process.exit(1);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) process.exit(a[i] < b[i] ? 0 : 1);
    process.exit(core === own ? 1 : 0);
  ' "$1" "$FLOOR" 2>/dev/null
}

# Возвращает ветку владельца везде, где ещё стоит ступенька, и убирает всё, что ремонт
# ставил для неё. Зовётся и первым делом при каждом запуске: прошлый ремонт могли убить
# между обновлениями.
restore_branch() {
  rm -rf "$STEP_TREE"
  [ -f "$RETURN_FILE" ] || return 0
  local own dir
  own="$(cat "$RETURN_FILE")"
  for dir in "$INSTALL_DIR/repo" "$INSTALL_DIR/.git"; do
    [ -d "$dir" ] || continue
    [ "$(git --git-dir="$dir" config --local --get iva.updateBranch || true)" = "$STEP_BRANCH" ] || continue
    if [ -n "$own" ]; then git --git-dir="$dir" config --local iva.updateBranch "$own"
    else git --git-dir="$dir" config --local --unset-all iva.updateBranch; fi
  done
  [ ! -d "$INSTALL_DIR/repo" ] || git --git-dir="$INSTALL_DIR/repo" update-ref -d "refs/heads/$STEP_BRANCH" 2>/dev/null || true
  rm -f "$RETURN_FILE"
}

# Ступенька - метка v$STEP на origin: она есть и не меняется. Обновлятор следует ветке и
# берёт её с origin, поэтому ветка ступеньки ставится из метки в само зеркало, а origin
# зеркала на время первого обновления ведёт в него же - только в окружении этого запуска
# (step_up), на диске адрес прежний. Сеть - до первой записи: метку тянет fetch_step.
fetch_step() {
  git --git-dir="$INSTALL_DIR/repo" fetch --quiet origin "+refs/tags/v$STEP:refs/tags/v$STEP" || no_origin
}
# $1 - ветка владельца: пишется первой, всё прочее после неё возвращает restore_branch.
pin_step() {
  local repo="$INSTALL_DIR/repo"
  printf '%s' "$1" > "$RETURN_FILE"
  git --git-dir="$repo" update-ref "refs/heads/$STEP_BRANCH" "refs/tags/v$STEP^{commit}"
  git --git-dir="$repo" config --local iva.updateBranch "$STEP_BRANCH"
}

# Первое обновление: команда "$@" ставит ступеньку. Не поставила - ветка владельца уже
# возвращена, установка стоит на своём выпуске.
step_up() {
  say "This Iva is older than $FLOOR: updating to $STEP first, then to the newest release." \
    "Эта Iva старше $FLOOR: обновляю сначала до $STEP, затем до новейшего выпуска."
  trap restore_branch EXIT
  local ok=1 n="${GIT_CONFIG_COUNT:-0}" repo="$INSTALL_DIR/repo"
  env GIT_CONFIG_COUNT="$((n + 1))" "GIT_CONFIG_KEY_$n=url.$repo.insteadOf" \
    "GIT_CONFIG_VALUE_$n=$(git --git-dir="$repo" config --get remote.origin.url)" "$@" || ok=0
  restore_branch
  trap - EXIT
  [ "$ok" = 1 ] && [ -f "$INSTALL_DIR/current/bin/iva.mjs" ] \
    && ! below_floor "$INSTALL_DIR/current/package.json" || fail \
    "the update to $STEP did not finish; Iva runs as it did. Run this command again." \
    "обновление до $STEP не завершилось; Iva работает как работала. Запустите эту команду ещё раз."
}

# Что ступенька переводит не обновлением, а лениво - при старте своего Bridge (очередь и
# входящие, scripts/poller/main.ts выпуска) и первой записью чата (общий run-status.json).
# Новейший выпуск этих форм не читает, а ступенька живёт минуты, поэтому её же код
# переводит их здесь, до второго обновления. Повтор ничего не меняет.
step_converts() {
  local root="$INSTALL_DIR/current" raw=""
  [ ! -f "$INSTALL_DIR/.env" ] \
    || raw="$(grep -E '^ASSISTANT_DATA_DIR=' "$INSTALL_DIR/.env" | tail -n1 | cut -d= -f2- | tr -d '"' || true)"
  (cd "$root" && node --input-type=module -e '
    const [root, raw] = process.argv.slice(1);
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { dataDirSetting, resolveDataDir } = await import(`${root}/scripts/lib/data-dir.ts`);
    const data = resolveDataDir(root, dataDirSetting(raw));
    process.env.ASSISTANT_DATA_DIR = data;
    const queue = await import(`${root}/scripts/lib/telegram-queue.ts`);
    for (const name of ["telegram-queue.json", "telegram-inbox.json"])
      await queue.migrateQueueFile(join(data, name), { strict: true });
    let legacy = null;
    try { legacy = JSON.parse(readFileSync(join(data, "run-status.json"), "utf8")); } catch {}
    if (legacy === null || typeof legacy !== "object" || Array.isArray(legacy)) process.exit(0);
    const status = await import(`${root}/agent/lib/run-status.ts`);
    for (const key of Object.keys(legacy)) {
      const own = join(data, "run-status.d", `${Buffer.from(key, "utf8").toString("base64url")}.json`);
      if (!existsSync(own)) status.setChatStatusIf(key, {}, {}, { touch: false });
    }
  ' "$root" "$raw") || fail \
    "Iva $STEP is installed, but converting its data did not finish. Run this command again." \
    "Iva $STEP установлена, но перевод её данных не завершился. Запустите эту команду ещё раз."
}

# Обновление новейшим выпуском из `current`: со ступеньки - после её ленивых переводов.
update_current() {
  if [ "$(node -p 'require(process.argv[1]).version' "$INSTALL_DIR/current/package.json" 2>/dev/null)" = "$STEP" ]; then
    step_converts
  fi
  say "Updating Iva..." "Обновляю Iva..."
  exec node "$INSTALL_DIR/current/bin/iva.mjs" update
}

restore_branch

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
  # Update branch каталогов версий обновлятор читает в зеркале repo. Ветка отката
  # (release/<v>) - выбор владельца: её обновлятор новейший выпуск не берёт, и ступенька
  # увела бы установку с выпуска, на котором её закрепили.
  repo="$INSTALL_DIR/repo"
  if [ -d "$repo" ] && below_floor "$INSTALL_DIR/current/package.json"; then
    own="$(git --git-dir="$repo" config --local --get iva.updateBranch || true)"
    if [ "${own#release/}" = "$own" ]; then
      fetch_step
      pin_step "$own"
      step_up node "$INSTALL_DIR/current/bin/iva.mjs" update
    fi
  fi
  update_current
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
# Чекаут ниже границы идёт через ступеньку, и сам он до её конца не меняется: CLI ступеньки
# исполняется из своего дерева (STEP_TREE) со своими зависимостями, а установкой для него
# остаётся чекаут - её он и переводит в каталоги версий. Зеркало ставится так же, как его
# ставит обновлятор (ensureMirror). Ветка отката остаётся как есть.
if below_floor "$INSTALL_DIR/package.json" && [ "${branch#release/}" = "$branch" ]; then
  repo="$INSTALL_DIR/repo"
  if [ ! -d "$repo" ]; then
    rm -rf "$repo.repair"
    git clone --quiet --mirror "$INSTALL_DIR/.git" "$repo.repair"
    git --git-dir="$repo.repair" remote set-url origin "$origin_url"
    mv "$repo.repair" "$repo"
  fi
  fetch_step
  mkdir "$STEP_TREE"
  git --git-dir="$repo" archive "v$STEP" | tar -xf - -C "$STEP_TREE"
  (cd "$STEP_TREE" && npm ci --no-audit --no-fund) || { rm -rf "$STEP_TREE"; fail \
    "the dependencies of Iva $STEP did not install; Iva runs as it did. Run this command again." \
    "зависимости Iva $STEP не установились; Iva работает как работала. Запустите эту команду ещё раз."; }
  pin_step "$branch"
  step_up node --input-type=module \
    -e 'const [cli, root] = process.argv.slice(1); await (await import(cli)).main(root, ["update"]);' \
    "$STEP_TREE/scripts/cli/main.ts" "$INSTALL_DIR"
  update_current
fi

say "Getting Iva $branch..." "Получаю Iva ($branch)..."
installed="$(git -C "$INSTALL_DIR" rev-parse -q --verify HEAD || true)"
# Вся сеть - до сброса: головы всех веток origin, своя ветка, метки. Не ответил origin -
# ничего не сброшено. FETCH_HEAD, не `origin/<ветка>`: remote-tracking ref может не быть.
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
