import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint, upstreamQuery } from "./lib/version-layout.ts";
import { noticeLang } from "./lib/notice-policy.ts";
import { acquireUpdateLock } from "./lib/version-store.ts";
import { betaChannel, BranchUnavailableError } from "./lib/update-channel.ts";
import { resolveDataDir } from "../packages/data-dir/index.ts";
import {
  gitAt,
  inspectUpstream,
  markVersionNotified,
  notificationChat,
  readNotifiedVersion,
  betaOffer,
  sendUpdateOffer,
  updateOffer,
  type GitCommand,
} from "./lib/update-check.ts";
import {
  formatWhatsNew,
  parseWhatsNew,
  RELEASE_NOTES_URL,
  whatsNewBetween,
} from "./lib/whats-new.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type UpdateEnvironment = Record<string, string | undefined>;
type UpdateInfo = Awaited<ReturnType<typeof inspectUpstream>>;
type SendUpdateRequest = {
  token: string;
  chatId: string;
  offer: ReturnType<typeof updateOffer>;
};
type DailyUpdateOptions = {
  root?: string;
  env?: UpdateEnvironment;
  inspectImpl?: (options: {
    root: string;
    head?: string;
  }) => Promise<UpdateInfo>;
  sendImpl?: (request: SendUpdateRequest) => Promise<unknown>;
  readStateImpl?: typeof readNotifiedVersion;
  writeStateImpl?: typeof markVersionNotified;
  gitImpl?: GitCommand;
};

function dataDir(root: string, env: UpdateEnvironment): string {
  return resolveDataDir(root, env.ASSISTANT_DATA_DIR);
}

/**
 * What the offered release brings, from the README at the very commit this check already
 * fetched — no call over the network beyond the ones it made. The README is the one whose
 * language the Notice speaks (ADR-0007).
 *
 * The block is garnish and the Notice is the product: a README that will not read or parse
 * costs the block, never the message. Hence one line in the journal and an empty string out.
 */
async function whatsNewBlock({
  root,
  ref,
  locale,
  installedVersion,
  remoteVersion,
  gitImpl,
}: {
  root: string;
  ref: string | undefined;
  locale: string;
  installedVersion: string | null | undefined;
  remoteVersion: string;
  gitImpl: GitCommand;
}): Promise<string> {
  if (!ref) return "";
  const file = locale === "ru" ? "README.ru.md" : "README.md";
  try {
    const shown = await gitImpl(root, ["show", `${ref}:${file}`]);
    if (typeof shown !== "string" && shown.code !== 0)
      throw new Error(shown.stderr || `could not read ${file} at ${ref}`);
    const text = typeof shown === "string" ? shown : (shown.stdout ?? "");
    const selection = whatsNewBetween(
      parseWhatsNew(text),
      installedVersion,
      remoteVersion,
    );
    return formatWhatsNew(selection, locale, RELEASE_NOTES_URL);
  } catch (error) {
    console.error(
      `Update notice without What's New: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

/** CHANGELOG.md на коммите ветки; не читается — пустой, Alert уходит без списка. */
async function textAt(gitImpl: GitCommand, root: string, ref: string) {
  const shown = await gitImpl(root, ["show", `${ref}:CHANGELOG.md`]);
  if (typeof shown === "string") return shown;
  return shown.code === 0 ? (shown.stdout ?? "") : "";
}

type DailyUpdateDeps = Required<DailyUpdateOptions>;
type DailyCheck = {
  deps: DailyUpdateDeps;
  storage: string;
  token: string;
  chatId: string;
  upstream: { root: string; head: string };
};

export async function runDailyUpdateCheck(options: DailyUpdateOptions = {}) {
  const deps: DailyUpdateDeps = {
    root: ROOT,
    env: process.env,
    inspectImpl: inspectUpstream,
    sendImpl: sendUpdateOffer,
    readStateImpl: readNotifiedVersion,
    writeStateImpl: markVersionNotified,
    gitImpl: gitAt,
    ...options,
  };
  const token = String(deps.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = notificationChat(deps.env);
  if (!token || !chatId) return { status: "not-configured" as const };

  const storage = dataDir(deps.root, deps.env);
  // The same lock the updater itself takes, with the same rules about when a
  // holder counts as gone: two answers to that question on one file is how a
  // crashed update ends up blocking the daily check for hours.
  const lock = acquireUpdateLock(storage);
  if (!lock) return { status: "update-running" as const };
  try {
    // One answer to «which repository», for the inspection and for the README it reads:
    // on the versioned layout that is the mirror, never the install root.
    const upstream = upstreamQuery(deps.root);
    let info: UpdateInfo;
    try {
      info = await deps.inspectImpl(upstream);
    } catch (error) {
      // Бета без ветки (нет сети или ветки): молчим, как current; отказ скажет iva update.
      const git = (...args: string[]) => gitAt(upstream.root, args);
      if (error instanceof BranchUnavailableError && (await betaChannel(git)))
        return { status: "current" as const };
      throw error;
    }
    const check = { deps, storage, token, chatId, upstream };
    // Бета: новые коммиты ветки, помнится коммит; стабильный: новая метка, помнится версия.
    return info.beta
      ? await notifyBeta(check, info)
      : await notifyStable(check, info);
  } finally {
    lock.release();
  }
}

async function notifyBeta(check: DailyCheck, info: UpdateInfo) {
  const { deps, storage, token, chatId, upstream } = check;
  if (!info.hasCommitUpdate) return { status: "current" as const, info };
  if ((await deps.readStateImpl(storage)) === info.remote)
    return { status: "already-notified" as const, info };
  const changelog = await textAt(deps.gitImpl, upstream.root, info.remote);
  const locale = await noticeLang(deps.env);
  const version = info.remoteVersion ?? "?";
  const offer = betaOffer(version, changelog, locale, info.updaterTooOld);
  await deps.sendImpl({ token, chatId, offer });
  await deps.writeStateImpl(storage, info.remote);
  return { status: "notified" as const, info };
}

async function notifyStable(check: DailyCheck, info: UpdateInfo) {
  const { deps, storage, token, chatId, upstream } = check;
  if (!info.hasVersionUpdate) return { status: "current" as const, info };
  if ((await deps.readStateImpl(storage)) === info.remoteVersion) {
    return { status: "already-notified" as const, info };
  }

  // The update prompt is an Alert (ADR-0007) and speaks the one language the owner picked:
  // settings.language first, AGENT_LANGUAGE after it — the same resolver the chat uses.
  const locale = await noticeLang(deps.env);
  const offer = updateOffer(
    info.localVersion,
    info.remoteVersion,
    locale,
    info.updaterTooOld,
  );
  // An Alert that only names two numbers leaves the owner to guess what the update
  // brings; the What's New of the offered release says it, in their language.
  const whatsNew = await whatsNewBlock({
    root: upstream.root,
    ref: info.remote,
    locale,
    installedVersion: info.localVersion,
    remoteVersion: info.remoteVersion,
    gitImpl: deps.gitImpl,
  });
  // What's New стоит перед кнопками: кнопки — часть текста и закрывают сообщение.
  const body = offer.text.slice(0, -offer.actions.length).trimEnd();
  const text = whatsNew
    ? `${body}\n\n${whatsNew}\n\n${offer.actions}`
    : offer.text;
  await deps.sendImpl({ token, chatId, offer: { ...offer, text } });
  await deps.writeStateImpl(storage, info.remoteVersion);
  return { status: "notified" as const, info };
}

export async function main(entryUrl = import.meta.url): Promise<void> {
  if (!isEntrypoint(entryUrl)) return;
  try {
    const result = await runDailyUpdateCheck();
    if (result.status === "notified") {
      console.log(`Update notification sent: v${result.info.remoteVersion}`);
    }
  } catch (error) {
    // Preserve the former JavaScript entrypoint's unchecked property access and
    // template coercion exactly; this boundary must not normalize thrown values.
    console.error(
      `Update check failed: ${(error as { message: string }).message}`,
    );
    process.exitCode = 1;
  }
}
