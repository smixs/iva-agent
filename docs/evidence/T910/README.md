# T910 final-round verification

Synthetic tokens only; no live Telegram API was used.

## Red evidence before repair

- `red-final-round.log`: `node --test scripts/colleague-hire.test.ts` at red-test commit `2f19b5d4` exited 1 with 14 pass / 4 fail. Permanent `getManagedBotToken` 400 held offset 1010 and blocked update 1011; durable-hire reconciliation/startup seams were absent; corrupt settings returned `retry=true`; initialization logging contained the synthetic colleague token.
- `red-empty-token.log`: the added empty-token regression at `39ef5927` exited 1 because `ok:true` without a token still returned `retry=true`.

## Green evidence after repair

- `targeted-green.log`: `node --test scripts/colleague-hire.test.ts scripts/poller/main.test.ts scripts/poller/control.test.ts` exited 0: 131 pass / 0 fail.
- `multi-bot-green.log`: `node --test scripts/poller/multi-bot.test.ts` exited 0: 10 pass / 0 fail.
- `typecheck.log`: `npm run typecheck` exited 0.
- `lint.log`: `npm run lint` exited 0.
- `multi-bot-poll-tlc.log`: `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" sh specs/multi-bot-poll-check.sh` exited 0. Base model: no error, 15552 distinct states; all five mutants/witnesses violate their expected invariants.
- `npm run build` also exited 0 during final verification.

## Repair commits

- A: `b2268c42` classifies permanent managed-token failures and acknowledges them; `f855cfcb` also makes an empty `ok:true` token response terminal.
- B: `1c701c6e` adds durable hire state, startup filtering and background reconciliation; `f855cfcb` writes durable state before storing the token; `48fce863` documents the journal in ADR-0030.
- C: `e822a17d` redacts known bot tokens from initialization errors; `fc7431e2` drives the regression through a stubbed `deleteWebhook` response.
- D: `90cf3ed2` models permanent/temporary managed-hire failure and complete-before-polling in `specs/MultiBotPoll.tla`.
