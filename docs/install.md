# Install

Everything between `curl` and a working bot. One command on a fresh server: the installer asks your language, walks you through five keys, and ends by messaging you from your own bot.

## Requirements

- 🖥️ **A server or your own machine** — Ubuntu/Debian is the tested path (apt); Fedora (dnf) and macOS (brew) work too. Any always-on box.
- 🧠 **512MB RAM is enough** — on boxes under 1.5GB the installer adds a 2GB swapfile so the build isn't OOM-killed (needs ~2.6GB free disk).
- 💾 **At least ~1.5GB free for Iva itself** — two version directories of ~400MB each plus the npm cache; allow 2GB more when the installer adds a swapfile.
- 🔑 **sudo** — asked up front, and only if system packages are missing or a swapfile is needed; the Chromium step may ask once more.

> Never used a server? The host sends you an address (IP), a login and a password. On Mac or Linux open Terminal, on Windows PowerShell, type `ssh root@YOUR_ADDRESS`, enter the password. You're in. First thing: make yourself a normal user and switch to it — `adduser iva && usermod -aG sudo iva && su - iva` — and install from there. Iva's shell tool runs with the permissions of whoever installed it, so don't hand it root.

> If the installer ends with `Failed to connect to bus: No medium found`, leave the `su - iva` shell. Enable linger and reconnect directly:
>
> ```bash
> exit                          # back to the root session on the server
> loginctl enable-linger iva
> exit                          # back to your own computer
> ssh iva@YOUR_ADDRESS
> ```
>
> Then run the installer again.

## Step 0 (optional): prepare a fresh VPS

Brand-new server, still logged in as `root`? One command gets it ready — run it **as root**, before anything else:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/bootstrap.sh)
```

It asks three things up front — a login, its password, and the timezone — then: updates the system, installs Iva's system packages (`git gh python3 ffmpeg pandoc poppler-utils`), creates that user with sudo and systemd lingering already enabled, turns on a firewall that allows SSH only, starts fail2ban and unattended security upgrades, and hardens sshd last — with a reload, so the session you're typing in is never dropped. Every step is detect-then-skip, so re-running it is safe. It ends by printing the `ssh` and `install.sh` commands to run next. Log: `/var/log/iva-bootstrap.log`.

No SSH key is involved: you log in as the new user with the password you just set, and hardening stops at `PermitRootLogin no`. Headless runs take `--non-interactive` with `IVA_USER` and `IVA_PASS`, plus optional `IVA_PUBKEY` (authorizes a key), `IVA_TZ` and `IVA_DISABLE_PASSWORD_AUTH` (key-only login — ignored without a valid key).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh | bash
```

The first question is your language — English or Russian — before anything touches the system. Input is read from `/dev/tty`, so the wizard stays interactive even piped through `curl`. If there's no terminal at all (Docker, CI), setup is skipped and the script prints how to run it later.

## Setup wizard

Five steps. Each key comes with a direct link to where it lives, and each is validated live — a bad key is rejected on the spot, not discovered at runtime. Enter keeps the current value, so re-running the wizard (`iva config`) changes only what you want.

1. **Provider and model.** Ollama Cloud, OpenCode Go, an OpenAI (ChatGPT) subscription, OpenRouter, Requesty or your own OpenAI-compatible endpoint ([comparison](providers.md)); the key (or the subscription sign-in) is checked, then you pick a model.
2. **Voice, search, hybrid memory.** Deepgram key (free starter credit) — Enter skips it, voice notes stay untranscribed until you add the key in `/menu` → 🎤 Voice; recognition language `multi` auto-detects ru/uz/en. The same step picks a web-search provider — Tavily, Exa, Parallel or Brave; Enter skips and search stays off — and offers optional hybrid memory with an embedding key.
3. **Telegram bot.** Paste the token from @BotFather; the wizard validates it via `getMe` and detects the bot's username itself.
4. **Access.** Send your new bot any message — "hi" works. The wizard reads `getUpdates`, shows who wrote, and you pick yourself. Iva answers only these IDs; an empty list means it answers nobody.
5. **Timezone, vault, port.** IANA timezone so nightly jobs run on your clock, the vault directory, and the port — default 8723, probed for conflicts.

## What install.sh does

- 📦 **System packages** — `git gh python3 ffmpeg pandoc poppler-utils` (`poppler` on brew): `gh` backs your vault up to a private GitHub repo, pandoc and poppler extract text from incoming docx/pdf files, ffmpeg converts media the transcriber can't take directly.
- 🐍 **uv** — runs the vault's Python maintenance scripts.
- 🟢 **Node 24 via nvm** — no root needed; 24 is a hard floor because memory search uses the built-in `node:sqlite`.
- 🌐 **agent-browser + Chromium** — headless browser for web tasks; the longest step, 1–3 minutes of visible download output.
- 🗂️ **Vault init** — your memory is created from `vault-template/` as a separate git repo, so personal data never enters the code repo.
- ⚙️ **Background runtime** — two systemd user services, two systemd watchdog timers and seven in-process eve schedules, with linger enabled so they survive logout. Details: [deploy.md](deploy.md).
- 🧰 **The `iva` command** — installed into `~/.local/bin`: `iva status`, `iva doctor`, `iva update`. Full reference: [cli.md](cli.md).
- ✅ **Telegram confirmation** — the last thing the installer does is message you from your own bot: "Iva is installed and online. Send me a message — I'll reply." That's the success signal.

Re-running the same command later is safe: over an installation that already exists the installer updates nothing itself — it hands the installation to the one updater, exactly as `iva update` and `repair.sh` do. A checkout is put back onto its release first (edits to Iva's own code are removed, `.env`, `data/` and the vault are not touched), a versioned installation goes straight to its own updater, and a checkout you marked with `.iva-dev` is refused.

Every stage checks whether its work is already done and skips it, so a run after a failure costs seconds instead of minutes:

| Stage           | Skipped when                                                                            |
| --------------- | --------------------------------------------------------------------------------------- |
| System packages | the command is already there (`git`, `gh`, `python3`, `ffmpeg`, `pandoc`, `pdftotext`)  |
| `npm ci`        | `node_modules` matches `package-lock.json` — npm's own record; patches are re-applied   |
| agent-browser   | the binary is installed and really opens a page                                         |
| `gws`           | the binary is installed (`iva update` keeps it current)                                 |
| Build           | `.output` carries this installer's stamp for the current commit, local edits and `.env` |

The wizard, the vault check, the `iva` command and the systemd units are cheap, so they run every time. A run that fails is undone: the copy it made of `.env` goes back, the build it replaced is put back, and both copies are deleted — on Ctrl-C and on a dropped SSH session too. The code is never this script's to move.

If the undo itself cannot finish — a read-only checkout, a full disk — nothing it saved is thrown away. Whatever is still the only copy of something stays where it is, and the installer prints each one by name before it exits: the copy of `.env` under `data/update-backups/`, and the previous build under `.output.iva-install-backup-*`. Read those lines before running anything else. An installation unpacked from an archive instead of cloned has no commit to compare against, so it rebuilds every time; so does one with a file the build cannot read.

Only one installer runs in an installation at a time: a second one is refused by name, with the process id of the one already working. A lock left by a run that no longer exists is taken over, so a power cut cannot leave the installation unusable.

### Flags and overrides

Flags pass through the pipe with `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/main/install.sh | bash -s -- --skip-setup
```

| Option              | Effect                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `--skip-setup`      | install everything, don't run the wizard                               |
| `--non-interactive` | no questions at all — defaults only, wizard skipped                    |
| `-h`, `--help`      | show the built-in help and exit                                        |
| `REPO_URL=…`        | install from a fork (default `https://github.com/smixs/iva-agent.git`) |
| `BRANCH=…`          | install and keep updating from this branch (default `main`)            |
| `INSTALL_DIR=…`     | where the code goes (default `~/iva`)                                  |

The last three are environment variables, read by the script at startup.

## If the wizard didn't run

Skipped setup, or no terminal at install time:

```bash
cd ~/iva && npm run setup
```

Then re-run the install command above — it finds the existing checkout and finishes the build, the systemd units and the confirmation.

## Next steps

- Every `.env` variable, defaults and warnings — [configuration.md](configuration.md)
- The `iva` server CLI and Telegram commands — [cli.md](cli.md)
- Transport, timers, webhook mode and operations — [deploy.md](deploy.md)
