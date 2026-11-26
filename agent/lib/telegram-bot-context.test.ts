import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTelegramBot,
  activeTelegramBotToken,
  botFromChannelState,
  colleagueBotIdFromState,
  colleagueBotIdOf,
  withTelegramBot,
} from "./telegram-bot-context.ts";
import type { TelegramBotConfig } from "../../packages/telegram-bots/index.ts";

const IVA: TelegramBotConfig = {
  botId: "111111111",
  token: "111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  username: "iva_bot",
  isPrimary: true,
};

const COLLEAGUE: TelegramBotConfig = {
  botId: "222222222",
  token: "222222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  username: "critic_bot",
  isPrimary: false,
};

const ENV: NodeJS.ProcessEnv = {
  TELEGRAM_BOT_TOKEN: IVA.token,
  TELEGRAM_BOT_USERNAME: IVA.username,
  TELEGRAM_COLLEAGUE_BOT_TOKENS: `${COLLEAGUE.username}=${COLLEAGUE.token}`,
};

void test("withTelegramBot propagates colleague token across async boundaries and isolates concurrent runs", async () => {
  assert.equal(activeTelegramBot(ENV)?.botId, IVA.botId);
  assert.equal(activeTelegramBotToken(ENV), IVA.token);

  const [fromColleague, fromIva] = await Promise.all([
    withTelegramBot(COLLEAGUE, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return activeTelegramBotToken(ENV);
    }),
    withTelegramBot(IVA, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return activeTelegramBotToken(ENV);
    }),
  ]);

  assert.equal(fromColleague, COLLEAGUE.token);
  assert.equal(fromIva, IVA.token);
});

void test("activeTelegramBotToken throws when neither context nor env provides a token", () => {
  assert.throws(() => activeTelegramBotToken({}), /TELEGRAM_BOT_TOKEN/u);
});

void test("botFromChannelState and colleagueBotIdFromState resolve colleague state or fall back to primary", () => {
  assert.equal(colleagueBotIdOf(IVA), null);
  assert.equal(colleagueBotIdOf(COLLEAGUE), COLLEAGUE.botId);
  assert.equal(colleagueBotIdOf(null), null);

  assert.equal(
    botFromChannelState({ botId: COLLEAGUE.botId }, ENV)?.token,
    COLLEAGUE.token,
  );
  assert.equal(
    colleagueBotIdFromState({ botId: COLLEAGUE.botId }, ENV),
    COLLEAGUE.botId,
  );

  // Primary / legacy state without botId resolves to primary bot with null colleagueId.
  assert.equal(botFromChannelState({}, ENV)?.token, IVA.token);
  assert.equal(colleagueBotIdFromState({}, ENV), null);

  // Unknown botId in state fails closed to null.
  assert.equal(botFromChannelState({ botId: "999999999" }, ENV), null);
  assert.equal(colleagueBotIdFromState({ botId: "999999999" }, ENV), null);
});
