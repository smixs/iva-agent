# T913 — гейт уровня 3 коллег Ивы

Кандидат проверки: `c1b59c48c243b60d8b8d76eddbc9ae2eae98cdaa` (`factory/T913`). Коммит сдачи может быть новее только этим evidence-файлом.

## 1. Полный прогон

- `npm run typecheck` на кандидате: exit 0.
- `npm run lint` на кандидате: exit 0 (копия без `.git`; в git-полной копии ESLint перебирает объектную базу и упирается в heap, это ограничение проверяющей среды, не продукта).
- `npm test` на кандидате, git-полная чистая копия на ovh1 со всеми release tags, Node v24.17.0, ffmpeg и uv в PATH: красный: 4191 pass / 10 fail; интеграционный R7 требует отдельного approved exception для colleague, остальные fail — update/archive/network и memory SIGKILL/owner/CORE/429/ДЕФ-17 (нужен разбор следующим исполнителем).
- Дополнительный сторож дерева `node --test scripts/authored-tree-guard.test.ts`: 12/12 pass, exit 0.

## 2. TLC

`sh specs/multi-bot-poll-check.sh`: exit 0. Base `MultiBotPoll` — 16 848 distinct states, no error; мутанты `shared-offset`, `drop-activation-backlog`, `no-lock`, `no-bot-tag`, `independent-witness` нарушают ожидаемые инварианты. `ColleagueHireLock` base — no error; `no-lock` и `blind-write` нарушают ожидаемые инварианты.

`sh specs/group-and-assignments-check.sh`: exit 0. Base `GroupAndAssignments` — 1 952 201 distinct state, no error; все девять мутантов и `witness` нарушают ожидаемые инварианты/witness-condition.

## 3. Мутация Telegram-канала

Мутация `botToken: () => activeTelegramBotToken(getEnv())` → `botToken: () => getEnv().TELEGRAM_BOT_TOKEN!` в `agent/channels/telegram.ts`:

- чистый кандидат: `node --test scripts/telegram-multi-bot-channel.test.ts` — 4/4 pass, exit 0;
- мутант на `c1b59c48`: тот же тест — 3/4 pass, 1 fail, exit 1; падает `replies go out from the exact bot token that received each message`, потому что typing/ответ не уходит токеном коллеги (`assert.ok(typingTokens.includes(COLLEAGUE_TOKEN))`).

## 4. Слепой QA по сценариям решений

Все шесть сценариев решений зелёные в полном прогоне кандидата на заглушках Bot API/model provider, без живой Ивы и без OpenAI API:

1. Опция выключена по умолчанию — `п.1: clean configuration has colleagues disabled...` и `colleague config stays disabled by default...`, pass.
2. Личный чат коллеги — `п.4: each colleague has its own private conversation isolated...`, pass.
3. Модель меняют Ива и владелец — `п.3: Iva changes colleague model via tool and owner changes it via CLI`, pass.
4. Группа с молчанием без обращения — `п.2: group without @ lets each bot decide reply vs silence...`, pass; длинный `iva:none` тоже pass.
5. Поручение со строкой владельцу — `п.3: bot-to-bot assignment goes via Bot API DM and posts one visible owner line...`, pass.
6. Найм на заглушке Bot API при сбое библиотеки талисманов — `п.3b: when ip-as-logo is unavailable, colleague is hired without photo and later retry sets the avatar`, pass; positive conversion/upload `п.3a` тоже pass.

## 5. Найденное и исправленное в этой ветке

Первый прогон `c86ad6fb` показал интеграционное красное: regression off→on использовал env-токены без complete-записи роли/модели, то есть фактически incomplete hire; B1 читал чужой общий settings вместо изолированного; evidence-логи зависимых веток возвращались в дерево и ломали portable-home guard. Коммит `20e301f4` исправляет фикстуры на complete hired colleague / изолированный `colleagueCompleteImpl` и убирает кухню из сливаемого дерева. Второе интеграционное красное закрыл `c1b59c48`: colleague tool добавлен в canonical wire fixture и approved exception, исторический count оставлен 140, а `agent/tools/colleague.ts` и `agent/lib/telegram-acceptance-wire.ts` получили прямые тестовые ссылки для coverage. Targeted на кандидате: helper-enabled-wire 5/5, helper-repair-r3 21/21, helper-w3-baseline 20/20, coverage-policy 2/2.

## Выкладка после приёмки (для тимлида)

Выложить: влить `factory/T913` в `beta`, затем на c1 выполнить обычную выкладку beta: `ssh c1 'cd ~/iva/current && export PATH=$HOME/.local/bin:$PATH && iva update --verbose'` и прогнать `sh .scratch/work/gates/c1-check.sh` до `C1 CHECK PASS` плюс живой сценарий найма коллеги. Перед выкладкой сделать бэкап: `ssh c1 'tar czf ~/iva-backups/pre-$(date +%Y%m%d-%H%M).tgz -C ~/iva data .env vault'`.

Откат: `ssh c1 'cd ~/iva/current && iva rollback'`, затем снова `c1-check.sh`. Если откат ветки нужен до выкладки, вернуть `beta` на прежний `origin/beta` (`63684762`) обычным решением тимлида; боевые данные коллег не создаются этим diff сами по себе.
