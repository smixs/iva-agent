#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$repo_root"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Commit changes before preparing eve.' >&2; exit 1; }
version="0.51.1-iva.5"
publish=false
if [[ "${1:-}" == --publish ]]; then publish=true; shift; fi
[[ $# -le 1 ]] || { echo "Usage: scripts/eve-release.sh [--publish] [output-directory]" >&2; exit 64; }
output_dir="${1:-.eve-out/release}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
archive="$output_dir/eve-$version.tgz"
if [[ -f "$archive" ]]; then
  echo "Reusing $archive; this version will not be rebuilt."
else
  [[ "$publish" == false ]] || { echo "Prepare and commit the archive before --publish." >&2; exit 1; }
  bash scripts/build-eve.sh "$output_dir"
fi
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
tar -xzf "$archive" -C "$stage"
source_hash="$(node scripts/lib/eve-tree-hash.ts source eve)"
packed_hash="$(node scripts/lib/eve-tree-hash.ts packed "$stage/package")"
url="https://github.com/smixs/iva-agent/releases/download/eve-$version/eve-$version.tgz"
node --input-type=module - "$archive" "$stage/package" "$version" "$url" "$source_hash" "$packed_hash" "$publish" <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [archive, root, version, url, sourceHash, packedHash, publish] = process.argv.slice(2);
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const build = json(`${root}/BUILD.json`), eve = json(`${root}/package.json`);
assert.equal(build.sourceTreeHash, sourceHash, 'Existing archive is stale: choose a new version.');
assert.equal(build.packedTreeHash, packedHash, 'Archive contents differ from BUILD.json.');
assert.equal(build.packageVersion, version);
assert.equal(eve.version, version);
const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64');
const pkg = json('package.json'), lock = json('package-lock.json');
const entry = lock.packages['node_modules/eve'];
const reference = {version, sourceTreeHash: sourceHash, packedTreeHash: packedHash};
if (publish === 'true') {
  assert.equal(pkg.dependencies.eve, url);
  assert.equal(lock.packages[''].dependencies.eve, url);
  assert.deepEqual({version: entry.version, resolved: entry.resolved, integrity: entry.integrity}, {version, resolved: url, integrity});
  assert.deepEqual(json('eve.lock.json'), reference);
} else {
  pkg.dependencies.eve = url;
  lock.packages[''].dependencies.eve = url;
  entry.version = version; entry.resolved = url; entry.integrity = integrity;
  writeFileSync('eve.lock.json', JSON.stringify(reference, null, 2) + '\n');
  for (const file of ['package.json', 'package-lock.json'])
    writeFileSync(file, JSON.stringify(file === 'package.json' ? pkg : lock, null, 2) + '\n');
}
console.log(`Archive: ${archive}\nURL: ${url}\nIntegrity: ${integrity}`);
JS
if [[ "$publish" == true ]]; then
  commit="$(git rev-parse --verify HEAD)"
  for file in package.json package-lock.json eve.lock.json; do git cat-file -e "$commit:$file"; done
  tag="eve-$version"
  if git show-ref --verify --quiet "refs/tags/$tag"; then
    [[ "$(git rev-parse "$tag^{commit}")" == "$commit" ]] || { echo "Existing tag belongs to another commit." >&2; exit 1; }
  else
    git tag "$tag" "$commit"
  fi
  git push origin "refs/tags/$tag"
  if assets="$(gh release view "$tag" --repo smixs/iva-agent --json assets --jq '.assets[].name' 2>"$stage/release-error")"; then
    :
  elif grep -qiE 'release not found|HTTP 404' "$stage/release-error"; then
    gh release create "$tag" --repo smixs/iva-agent --verify-tag --latest=false --title "$tag" --notes "eve source archive for Iva."
    assets=""
  else
    cat "$stage/release-error" >&2; exit 1
  fi
  if [[ $'\n'"$assets"$'\n' == *$'\n'"eve-$version.tgz"$'\n'* ]]; then
    gh release download "$tag" --repo smixs/iva-agent --pattern "eve-$version.tgz" --output "$stage/existing.tgz"
    cmp -s "$archive" "$stage/existing.tgz" || { echo 'Опубликованный архив неизменяем: нужен новый N.' >&2; exit 1; }
  else
    gh release upload "$tag" "$archive" --repo smixs/iva-agent
  fi
  curl --fail --location --silent --show-error "$url" --output "$stage/download.tgz"
  cmp -s "$archive" "$stage/download.tgz" || { echo 'Published archive integrity differs.' >&2; exit 1; }
  mkdir "$stage/ci" "$stage/npm-cache"
  git archive "$commit" > "$stage/ci.tar"
  tar -xf "$stage/ci.tar" -C "$stage/ci"
  (cd "$stage/ci" && npm ci --cache "$stage/npm-cache" --no-audit --no-fund)
  echo 'Можно пушить beta: опубликованный архив проверен, чистый npm ci завершён.'
else
  echo "Commit package.json, package-lock.json and eve.lock.json, then run: bash scripts/eve-release.sh --publish $output_dir"
fi
