#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
export GIT_CEILING_DIRECTORIES="$repo_root"
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE
eve_root="$repo_root/eve"
package_root="$eve_root/packages/eve"
package_json="$package_root/package.json"
build_json="$package_root/BUILD.json"
version="0.51.1-iva.5"
pnpm_version="11.25.0"
upstream_commit="eb5949a622801b35a2a6f78bb58d9eef27273cac"
if [[ -n "${EVE_PNPM_BIN:-}" ]]; then
  [[ "$("$EVE_PNPM_BIN" --version)" == "$pnpm_version" ]] || { echo "Expected pnpm $pnpm_version in EVE_PNPM_BIN." >&2; exit 1; }
  pnpm_run=("$EVE_PNPM_BIN")
else
  pnpm_run=(npx -y "pnpm@$pnpm_version")
fi
[[ $# -eq 1 ]] || { echo "Usage: scripts/build-eve.sh <output-directory>" >&2; exit 64; }
mkdir -p "$1"
output_dir="$(cd "$1" && pwd -P)"
package_backup="$(mktemp)"
stage_root="$(mktemp -d)"
cp "$package_json" "$package_backup"
cleanup() {
  cp "$package_backup" "$package_json"
  rm -f "$package_backup" "$build_json" "$package_root/LICENSE" "$package_root/NOTICE"
  rm -rf "$package_root/docs"
  for root in "$eve_root" "$package_root" "$eve_root/packages/eve-catalog"; do
    rm -rf "$root/dist" "$root/.generated" "$root/.turbo"
    if [[ "${EVE_KEEP_NODE_MODULES:-0}" != 1 ]]; then rm -rf "$root/node_modules"; fi
  done
  rm -rf "$stage_root"
}
trap cleanup EXIT
source_hash="$(node "$repo_root/scripts/lib/eve-tree-hash.ts" source "$eve_root")"
write_build_json() {
  node -e 'const fs=require("fs"); const [file,upstreamCommit,packageVersion,pnpmVersion,sourceTreeHash,packedTreeHash]=process.argv.slice(1); fs.writeFileSync(file, JSON.stringify({upstreamCommit,packageVersion,pnpmVersion,nodeVersion:process.version,sourceTreeHash,packedTreeHash}, null, 2)+"\n")' "$build_json" "$upstream_commit" "$version" "$pnpm_version" "$source_hash" "$1"
}
cd "$eve_root"
"${pnpm_run[@]}" install --frozen-lockfile
"${pnpm_run[@]}" --filter eve run build
node "$eve_root/scripts/copy-package-license.mjs" "$package_root"
node -e 'const fs=require("fs"); const [file,version]=process.argv.slice(1); const pkg=JSON.parse(fs.readFileSync(file)); pkg.version=version; if (!pkg.files.includes("BUILD.json")) pkg.files.push("BUILD.json"); fs.writeFileSync(file, JSON.stringify(pkg, null, 2)+"\n")' "$package_json" "$version"
write_build_json pending
"${pnpm_run[@]}" --filter eve pack --config.ignore-scripts=true --pack-destination "$output_dir"
archive="$output_dir/eve-$version.tgz"
mkdir "$stage_root/first"
tar -xzf "$archive" -C "$stage_root/first"
packed_hash="$(node "$repo_root/scripts/lib/eve-tree-hash.ts" packed "$stage_root/first/package")"
write_build_json "$packed_hash"
"${pnpm_run[@]}" --filter eve pack --config.ignore-scripts=true --pack-destination "$output_dir"
mkdir "$stage_root/final"
tar -xzf "$archive" -C "$stage_root/final"
actual_hash="$(node "$repo_root/scripts/lib/eve-tree-hash.ts" packed "$stage_root/final/package")"
[[ "$actual_hash" == "$packed_hash" ]] || { echo 'Archive contents differ from BUILD.json.' >&2; exit 1; }
printf '%s\n' "$archive"
