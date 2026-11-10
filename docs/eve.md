# Building and publishing eve

Iva carries eve sources in `eve/`, imported from [vercel/eve](https://github.com/vercel/eve)
at commit `eb5949a622801b35a2a6f78bb58d9eef27273cac` (eve 0.51.1).
The copy contains the eve package, its catalog dependency and build inputs. It
carries no upstream tests, no package documentation and none of the code Iva never
loads (ADR-0027); the table below lists the entry points and commands that went.
The eve documentation lives at https://eve.dev/docs. Iva's changes are ordinary
commits in this directory, held by tests on the boundary with Iva. Taking a newer
upstream commit is a separate decision (ADR-0023).

| Removed                                                                                                                                                                                                      | What it was                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `eve/react`, `eve/vue`, `eve/svelte`                                                                                                                                                                         | client hooks for web front ends                                                         |
| `eve/next`, `eve/nuxt`, `eve/sveltekit`                                                                                                                                                                      | host-framework adapters                                                                 |
| `eve/self-modification`, `eve/self-modification/agent`, `eve/self-modification/sandbox`                                                                                                                      | the built-in self-modification extension                                                |
| `eve/channels/slack`, `eve/channels/teams`, `eve/channels/discord`, `eve/channels/linear`, `eve/channels/twilio`, `eve/channels/chat-sdk`, `eve/channels/photon`, `eve/channels/linq`, `eve/channels/github` | channels other than Telegram, the eve channel and MCP                                   |
| `eve/setup`, `eve/setup/scaffold`                                                                                                                                                                            | the setup flows of the removed commands                                                 |
| `eve acp`                                                                                                                                                                                                    | the ACP server over stdio                                                               |
| `eve init`, `eve set`, `eve integration`, `eve add`, `eve registry`, `eve link`, `eve deploy`                                                                                                                | project creation, model settings, integrations, eve catalog items and Vercel deployment |

The copy keeps `eve build`, `eve start`, `eve dev` with its terminal UI (and `/add`
inside it), `eve extension`, `eve invoke`, `eve logs`, `eve traces`, `eve info`,
`eve channels` and `eve eval`, and every other entry point. A plugin or a tool in
`data/custom` that imports a removed entry point does not build on this copy: an
`iva update` switches such a plugin off and names it to the owner, and
`iva plugin add`, `update` or `enable` refuses it (ADR-0027, "Цена").

Edit the source in `eve/packages/eve/src/`, run the Iva boundary tests that name
the changed behaviour, and commit the source. Maintainers use Node 24 or newer and
pnpm 11.25.0. Choose a fresh `0.51.1-iva.N` in `scripts/build-eve.sh` and
`scripts/eve-release.sh` for each new archive. Users install the ready package;
they only build the Iva agent.

From a clean checkout:

```sh
bash scripts/eve-release.sh
```

The script calls `scripts/build-eve.sh`, keeps the archive in the ignored
`.eve-out/release/` directory, calculates its SHA-512 SRI and writes its URL,
version and integrity into `package.json` and `package-lock.json`, and the version
and source/package hashes into the tracked `eve.lock.json` outside `eve/`. A second run
reuses the existing archive after checking its source and package hashes. An
existing archive with different source files requires a fresh version number.
For build comparison alone, use `bash scripts/build-eve.sh <empty-output-directory>`.

Commit the three dependency files locally, then publish with:

```sh
bash scripts/eve-release.sh --publish
```

The command verifies the clean committed tree and prepared archive, creates and
pushes only the `eve-0.51.1-iva.N` tag, creates its GitHub release and uploads the
archive, downloads the final URL and compares its SHA-512 SRI, then runs `npm ci`
in a temporary clean tree with an empty cache. It stops at the first failure.
Its final message allows the maintainer to push `beta`; that push remains a
separate action after the required acceptance checks. A different archive
location can be passed as the last argument in both modes.

Published `eve-*` tags and their archive assets are permanent and immutable:
keep their names and bytes. A correction gets a new N. Old Iva versions depend
on the old URLs. Archives stay outside git.

`node_modules/eve/BUILD.json` carries upstream commit, package/tool versions,
`sourceTreeHash` and `packedTreeHash`. `scripts/eve-copy.test.ts` checks the
source and installed contents against `eve.lock.json`, and checks the package's
BUILD metadata and dependency lock. Hashes include only the executable flag,
so file access permissions and umask do not change them. The build-only
`.vendor-stamp.json` is excluded from the packed hash; its script fingerprint
uses relative paths, so archive bytes are identical across build directories.

## Checking an eve change

The copy has no test suite of its own. A change to eve is checked from Iva's side:

- A behaviour change is held by an Iva boundary test that names the changed eve
  behaviour (`scripts/eve-*.test.ts`, ADR-0023), then by the gate of its task
  level.
- A change meant to leave Iva's behaviour alone (a removal, a build edit) is
  compared with Iva's build before the change. Keep a copy of `.output` from
  `npm run build` on the old archive, install the new one, build again and run
  `node scripts/eve-bundle-equal.ts <old>/.output/server .output/server`. It exits
  0 and prints `EQUAL` when the eve modules (the `//#region` markers, and the
  workflow bundle carried as base64) are the same set and each module matches the
  old one up to the names of its bindings: literals, operators, property names
  and statement order are the same, names pair one to one, a chunk's imports and
  exports match as sets, and the eve archive version is the one literal allowed
  to differ. Any other difference rolls the removal back.
- `npm run build`, `node bin/iva.mjs version`,
  `node node_modules/eve/bin/eve.js --help` and
  `node node_modules/eve/bin/eve.js start --help` exit 0, and the eve boundary
  tests (`scripts/eve-copy.test.ts`, `scripts/eve-release.test.ts`,
  `scripts/eve-archive-update.test.ts`, `scripts/lib/plugin-build-eve.test.ts`)
  pass with `EVE_LOCAL_ARCHIVE` set to the archive path as installed.
- `scripts/eve-copy.test.ts` pins what the copy no longer carries and the CLI
  commands Iva runs.

eve is built as one rolldown program. Removing a source file reorders imports and
renames local variables or colliding top-level names in files that stay, which
is why the comparison is up to names and not byte for byte. Three parts stay
because removing them changes the program itself: the terminal UI of `eve dev`
with the setup flows it opens and `compiled/shadcn-registry` (Iva runs
`eve dev`); the evals, whose removal drops CommonJS helpers from the shared
`_virtual/_rolldown/runtime.js`; and the vendored dependencies of the removed
channels, whose removal renames the shared `compiled/_chunks/node` chunks.

The sources retain the [Apache-2.0 license](../eve/LICENSE) and
[NOTICE](../eve/NOTICE), including the Iva modifications. Both files are also
included in the archive.
