# T913 — гейт уровня 3 коллег Ивы

Замороженный кандидат проверки кода и тестов: `533e5133f91a59463659c94d49a047dcc98032d0` (`factory/T913`). В ветку поверх `origin/beta` (`63684762`) влита принятая ветка `factory/T941` (`7bc5f1cf`, включающая `factory/T940` `4d8d3699` — найм коллег из T910), которой ещё не было в `origin/beta`. Коммит сдачи новее замороженного SHA только обновлением этого файла доказательств.

## 1. Полный прогон (`npm test`, `npm run typecheck`, `npm run lint`)

Выполнено на замороженном SHA `533e5133f91a59463659c94d49a047dcc98032d0` (чистый полный git-клон со всеми 88 release tags, Node v24.22.1, `ffmpeg` и `uv` в PATH, изолированный `CLAUDE_CONFIG_DIR`, без OpenAI API и без поднятой Ивы):

- `npm run typecheck` (`tsgo`): exit 0.
- `npm run lint` (`eslint --flag unstable_native_nodejs_ts_config .` на чистом `git archive` без `.git`, чтобы ESLint не обходил объектную базу git): exit 0.
- `npx prettier --check scripts/poller/main.ts`: exit 0.
- Полный `npm test` (`node --test --test-concurrency=4 "agent/**/*.test.ts" "scripts/**/*.test.ts" "services/**/*.test.ts"`): **exit 0 — `tests 6072 | suites 9 | pass 6057 | fail 0 | cancelled 0 | skipped 14 | todo 1 | duration_ms 933622.4`**.
- Все сторожа дерева (`scripts/authored-tree-guard.test.ts`, `scripts/coverage-policy.test.ts`, `scripts/helper-enabled-wire.test.ts`, `scripts/helper-turn.test.ts`, `scripts/lib/reminder-turn-island.test.ts`, `scripts/deferred-command-repair.test.ts`, `scripts/telegram-poll-queue-durable.test.ts`): зелёные внутри полного прогона (0 fail).

## 2. TLC-модели частей 1 и 4 и их мутанты

На том же замороженном SHA `533e5133f91a59463659c94d49a047dcc98032d0`:

- `sh specs/multi-bot-poll-check.sh`: exit 0.
  - `OK MultiBotPoll: no error (16848 distinct states)`
  - Мутанты и witness нарушают ожидаемые инварианты: `shared-offset` (`NoSkippedUpdate`), `drop-activation-backlog` (`NoSkippedUpdate`), `no-lock` (`SinglePollerLock`), `no-bot-tag` (`ExactBotAttribution`), `independent-witness` (`NoIndependentProgress`).
  - `OK ColleagueHireLock: no error (48 distinct states)`
  - Мутанты нарушают ожидаемые инварианты: `no-lock` (`SingleHireWriter`), `blind-write` (`CompleteNotOverwritten`).
- `sh specs/group-and-assignments-check.sh`: exit 0.
  - `OK GroupAndAssignments: no error (1952201 distinct states)`
  - Все 9 мутантов и witness нарушают ожидаемые инварианты: `concurrent-group` (`SingleActiveGroupBot`), `drop-busy-group` (`NoLostGroupMessage`), `duplicate-group` (`NoDuplicateGroupProcessing`), `duplicate-assignment` (`NoDuplicateAssignment`), `lost-assignment` (`NoLostAssignment`), `duplicate-owner-notice` (`AtMostOneOwnerNotice`), `stuck-owner-notice` (`DoneAssignmentNotifiedOwner`), `done-no-retry` (`DoneAssignmentNotifiedOwner`), `batch-first-only` (`NoLostAssignment`), `witness` (`NoSilenceAndAssignmentWitness`).

## 3. Мутация кода канала Telegram

На том же замороженном SHA `533e5133f91a59463659c94d49a047dcc98032d0` внесена мутация в `agent/channels/telegram.ts:595` (ответ и typing уходят с основного токена Ивы вместо токена бота-адресата):

```diff
--- agent/channels/telegram.ts
+++ agent/channels/telegram.ts
@@ -592,7 +592,7 @@
     uploadPolicy: "disabled",
     credentials: {
-      botToken: () => activeTelegramBotToken(getEnv()),
+      botToken: () => getEnv().TELEGRAM_BOT_TOKEN!,
     },
```

- Чистый кандидат `533e5133`: `node --test scripts/telegram-multi-bot-channel.test.ts` — **4/4 pass, exit 0**.
- Мутант на `533e5133`: `node --test scripts/telegram-multi-bot-channel.test.ts` — **3/4 pass, 1 fail, exit 1**; падает тест `replies go out from the exact bot token that received each message (two tokens on stub Bot API)` на `assert.ok(typingTokens.includes(COLLEAGUE_TOKEN))` (`scripts/telegram-multi-bot-channel.test.ts:311`).

## 4. Слепой QA по сценариям решений

Все шесть сценариев решений Сергея зелёные внутри полного `npm test` на `533e5133f91a59463659c94d49a047dcc98032d0` (на заглушках Bot API и model provider, без живой Ивы и без OpenAI API):

| #   | Сценарий решений                                                                              | Пройденные тесты (в полном прогоне `533e5133`)                                                                                                                                                                                                                                                                                                                                                        | Исход |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | Опция выключена по умолчанию                                                                  | `п.1: clean configuration has colleagues disabled and blocks colleague messages in Bridge and Channel`; `colleague config stays disabled by default even after hiring proposals exist`; `п.1 regression: bridge started with colleagues off accepts a colleague update after iva colleague on`                                                                                                        | PASS  |
| 2   | Личный чат коллеги (своя переписка, общая база заметок, все инструменты Ивы, своё расписание) | `п.4: each colleague has its own private conversation isolated from Iva's session and daily transcript`; `п.5: Vault is shared — a Card written by a colleague is visible to Iva via memory_search`; `п.6: colleague receives the exact same toolset as Iva`; `п.7: colleague reminder stores botId, runs its task turn with colleague header, and delivers from colleague bot`                       | PASS  |
| 3   | Смена модели Ивой и владельцем                                                                | `п.2: colleague turn runs on its own provider/model and role instruction, not Iva's model`; `п.3: Iva changes colleague model via tool and owner changes it via CLI`                                                                                                                                                                                                                                  | PASS  |
| 4   | Группа с молчанием без обращения и без лимита кругов                                          | `п.2: group without @ lets each bot decide reply vs silence (iva:none sends nothing), with no round limit`; `п.2 (длинный ход с инструментом): group turn >60s with tool-calls ending in iva:none sends zero messages and zero deletes`; `п.4: bots added by owner to a group accept its messages and serialize turns per group without blocking private chats`                                       | PASS  |
| 5   | Поручение личными сообщениями со строкой владельцу                                            | `п.3: bot-to-bot assignment goes via Bot API DM and posts one visible owner line in colleague chat, deduplicated on replay`; `п.3 (пачка с повтором и новым поручением): promoteReadyInbox delivers fresh 8203 alongside replayed 8201`                                                                                                                                                               | PASS  |
| 6   | Найм на заглушке Bot API со сбоем библиотеки талисманов                                       | `п.1: buildColleagueHireLink...`; `п.2: managed_bot fetches token, stores it in .env beside TELEGRAM_BOT_TOKEN...`; `п.3a: random ip-as-logo talisman converts to 640x640 JPG without role filter and uploads via setMyProfilePhoto`; `п.3b: when ip-as-logo is unavailable, colleague is hired without photo and later retry sets the avatar`; `п.4: colleague token is inventoried... and redacted` | PASS  |

## 5. Найденное красным в ходе гейта: исправлено и вне ветки

### Исправлено в этой ветке (`factory/T913`)

1. **`20e301f4`** — согласованы фикстуры гейта с durable hiring (`colleagues.test.ts` off→on использует полную карточку коллеги и изолированный `colleagueCompleteImpl`), из сливаемого дерева удалены старые логи `docs/evidence/T910|T940|T941` (нарушали `portable-home` guard).
2. **`c1b59c48`** — инструмент `colleague` добавлен в `scripts/fixtures/helper-enabled-wire.json` и в проверки `helper-enabled-wire.test.ts`, `helper-repair-r3.test.ts`, `helper-w3-baseline.test.ts`; добавлена прямая ссылка для `coverage-policy`.
3. **`91eb3aef`** — закрыты 2 интеграционные регрессии коллег (воспроизводились и на чистой `origin/beta` `63684762` из-за T909):
   - `scripts/helper-turn.test.ts` (тест R7 wire bytes): добавлен approved tool `colleague` (итого 140 инструментов вместо 139);
   - `scripts/lib/reminder-turn-island.test.ts`: добавлен `packages/telegram-bots/index.ts` в `ISLAND_FILES` (модуль из `packages/`, импортируемый `scripts/lib/reminder-turn.ts`, без зависимостей от `agent/`).
4. **`96882d8d`** — исправлена реальная регрессия T940/T941 в `scripts/poller/main.ts`, из-за которой в полном `npm test` падали 18 из 31 тестов `scripts/telegram-poll-queue-durable.test.ts` (на чистой `origin/beta` `63684762` все 31/31 зелёные): безусловный запуск `launchBotLoop(primaryBot)` в фоне обгонял `promoteReadyInbox`/`drainReadyQueueHeads`. Одноботовый режим оставлен синхронным с `promote`/`drain` (с `PRIMARY_ALLOWED_UPDATES`, включая `managed_bot`) и бесшовно переключается на фоновый `launchBotLoop(primaryBot, offset)` с точным post-batch offset при появлении активного коллеги. После правки: `scripts/telegram-poll-queue-durable.test.ts` 31/31 PASS.
5. **`533e5133`** — в `scripts/poller/main.ts` восстановлена локальная привязка `const pendingInboxCount = await promoteReadyInbox(...)` в цикле `for (;;)`, чтобы статический сторож `scripts/deferred-command-repair.test.ts` (`R1`) вырезал корректное окно до `promoteReadyInbox`, а не до конца файла (`indexOf(...) === -1` после T940). После правки: `scripts/deferred-command-repair.test.ts` зелёный, полный `npm test` 6057 pass / 0 fail.

### Наблюдения вне зоны коллег (отдельной строкой)

- **`scripts/memory/night-process.test.ts` — подвисание процесса теста при редком сбое `CORE owner-only` (pre-existing, код `scripts/memory/` веткой коллег не тронут: `git diff origin/main..HEAD -- scripts/memory/` пуст).** Причина разобрана: в `ModelDouble` (`scripts/memory/night-process.test.ts:51-81`) обработчик запускается как `void this.handle(request, response)`, и при обрыве/пустом теле HTTP-запроса под конкурентной нагрузкой `JSON.parse(body)` (строка 78) бросает unhandled `SyntaxError: Unexpected end of JSON input`. Node test runner немедленно завершает тест `CORE owner-only preserves every owner-backed candidate` (строка 1233) и исполняет его `t.after`-хуки, пока цикл `fc.assert` (30 итераций) продолжает работу в фоне; последующие вызовы `fixture(t)` → `model.start(t)` открывают новые `http.Server`, чьи `t.after`-хуки уже не вызываются на завершённом `TestContext`, и осиротевший listening socket держит процесс `night-process.test.ts` живым неограниченно долго после прохождения всех остальных тестов (воспроизводилось на ovh1 и один раз на zenbook на `96882d8d`; на `533e5133` прошло чисто с exit 0). Рекомендация тимлиду: вынести отдельным фиксом в `night-process.test.ts` (ловить ошибки в `ModelDouble.handle`, закрывать `fixture` внутри каждой итерации `fc.assert` через `try/finally`, а не через `t.after`).

## Выкладка после приёмки (для тимлида)

- **Ветка и база:** `factory/T913` от `origin/beta` (`63684762`), с влитой принятой `factory/T941` (`7bc5f1cf`, включающей `factory/T940` `4d8d3699`).
- **Бэкап c1 перед выкладкой:** `ssh c1 'tar czf ~/iva-backups/pre-$(date +%Y%m%d-%H%M).tgz -C ~/iva data .env vault'`.
- **Выкладка на c1:** влить `factory/T913` в `beta` (вместе с влитыми `T940`/`T941`), push `origin/beta`, затем на c1: `ssh c1 'cd ~/iva/current && export PATH=$HOME/.local/bin:$PATH && iva update --verbose'`, затем `export PATH=$HOME/.bun/bin:$PATH && sh .scratch/work/gates/c1-check.sh` до `C1 CHECK PASS` плюс живой сценарий найма коллеги на c1.
- **Проверенный откат:** `ssh c1 'cd ~/iva/current && iva rollback'`, затем снова `c1-check.sh` до `C1 CHECK PASS`; при откате ветки до выкладки — вернуть `beta` на прежний `origin/beta` (`63684762`). Коллеги по умолчанию выключены (`enabled: false`), боевые данные без явного включения и найма не затрагиваются.
