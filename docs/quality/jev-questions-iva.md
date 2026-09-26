# Вопросы Jev для Ивы: повторяющиеся грабли

Список для гейта качества (плагин code-quality, `[review]` в `.quality.toml`). Jev, классификатор
TypeSafe, отвечает на каждый вопрос одной вероятностью по одному хунку диффа; ответ выше порога
даёт пометку в выводе гейта, не блок. Вопросы собраны по инцидентам Ивы: issues репозитория,
CHANGELOG, разборы волн (сентябрь 2026). Формат каждого: вопрос, триггер (какие хунки спрашивать),
порог, текст заметки, откуда грабли. Состояние для Jev везде одно: `file`, `diff_hunk` (хунк с тремя
строками контекста), где сказано, ещё `changed_source_files`. Вопросы к Jev задаются по-английски,
один атомарный вопрос на свойство.

«Всё ли сделано» и «всё ли покрыто тестами» здесь не повторяются: их задают общие вопросы плагина
`spec_incomplete` и `change_untested` (v1.1.0).

## 1. `silent_failure` — сбой, о котором пользователь не узнает

- **Вопрос:** Does the code added in `diff_hunk` catch, swallow or return early on an error on a
  path whose outcome the user is waiting for (a reply, a delivery, a reminder, a night run), without
  telling the user or writing a log line that names the cause?
- **Триггер:** хунки исходников в `agent/` и `scripts/`, где добавлены `catch`, `.catch(`,
  `try {`, `return;`/`return null` внутри обработчика ошибки, `?? null` на результате вызова.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev silent_failure: an error on a user-facing path is swallowed; the user or the log must learn the cause`.
- **Откуда:** #217 сбой модели молча паркует сессию; #85 лимит провайдера убивает агента без ответа;
  #87 мёртвая сессия оставляет бота немым; #178 ответы теряются без уведомления; CHANGELOG
  «Молчащие сбои отправки и ночных операций теперь видны», «Каждый упавший ход объясняется в чате»,
  «Пустой ответ больше не считается отправленным».

## 2. `identity_literal` — сравнение идентичности со строкой

- **Вопрос:** Does the code added in `diff_hunk` compare a channel kind, provider id, model name,
  session or version identity against a string literal written in place, instead of a constant or
  resolver that the rest of the project already uses for that identity?
- **Триггер:** хунки в `agent/`, `scripts/` с `=== "` / `!== "` / `startsWith("` рядом со словами
  `kind`, `provider`, `model`, `channel`, `version`.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev identity_literal: an identity is compared with an inline literal; the September hang wave started with "channel:telegram" vs "telegram"`.
- **Откуда:** волна зависаний 04.09.2026 (retire не срабатывал: kind «channel:telegram» против
  «telegram»); #187 `/model` сохраняет обрезанное имя модели; #161 неверный MODEL_PROVIDER мешает
  конфиг Ollama с чужой идентичностью.

## 3. `vault_path_by_hand` — путь в vault собран руками

- **Вопрос:** Does the code added in `diff_hunk` build a path into the vault, the data directory
  or the versioned install layout by string concatenation, `path.join` from a hard-coded base, or a
  relative path, instead of the project's shared resolver for that location?
- **Триггер:** хунки в `agent/tools/`, `agent/lib/`, `scripts/memory/`, `scripts/lib/` с `vault`,
  `data/`, `versions/`, `../`, `path.join(`, `resolve(`.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev vault_path_by_hand: a vault or data path is built in place; use the shared resolver (vault/vault doubling, ENOENT under versions/)`.
- **Откуда:** #199 и #242 удвоение `vault/vault`; #17 путаница cwd в bash; T93 (сентябрь 2026)
  ночь читала правила по путям проекта, резолвер vault отказывал; CHANGELOG «путь к vault считается
  в одной формуле», «Glob и grep видят Vault через симлинк».

## 4. `memory_overwrite` — память затирается, а не дописывается

- **Вопрос:** Does the code added in `diff_hunk` replace, truncate or regenerate an existing memory
  file (a card, CORE.md, a daily note, a summary) instead of merging into it or appending, or write
  it without the project's atomic write and vault commit helpers?
- **Триггер:** хунки в `agent/lib/card-store*`, `agent/tools/write_card*`, `agent/tools/supersede*`,
  `scripts/memory/`, любые хунки с `CORE.md`, `writeFile`, `truncate`.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev memory_overwrite: an existing memory file is replaced rather than merged; Iva only appends and corrects, never rewrites what a person wrote`.
- **Откуда:** #43 write_card молча затирает карточки; #201 и #220 ночь выхолащивает секции CORE.md;
  #86 и #90 сжатие CORE только промптом; #88 описание карточки удваивается до 1,4 ГБ; #133 секции
  «Обновление» штабелируются; решение владельца 26.09.2026 «ночь не трогает строки, написанные
  человеком».

## 5. `unbounded_turn` — ход или цикл без предела и без стопа

- **Вопрос:** Does the code added in `diff_hunk` start a model turn, background job, loop that repeats a failed call, or
  timer (night rollup, schedule, wake after failure, subagent) without a bound on steps, tokens or
  time, or without a way for the user's Stop or /new to cancel it?
- **Триггер:** хунки в `scripts/memory/`, `scripts/jobs/`, `agent/schedules/`,
  `agent/lib/schedule-runner*`, `agent/lib/eve-cancel*`, с `send(`, `while (`, `for await`,
  `setInterval` и повторные вызовы после отказа.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev unbounded_turn: a turn or loop has no ceiling or no cancel path; #249 burned tokens all night`.
- **Откуда:** #249 день не закрывается, неотменённый ход жжёт токены; #247 2,44 млн токенов и
  37 шагов за ночь; #184 `/new` не убивает ход, зомби зацикливается; #216 и #218 таймаут ночи вешает
  чат; #36 и #68 рестарт посреди хода блокирует диалог; CHANGELOG «Молчащая модель больше не держит
  ход бесконечно», «Фоновый агент не опрашивается по кругу».

## 6. `prompt_depends_on_layout` — инструкция модели зависит от путей или окружения

- **Вопрос:** Does the instruction or prompt text added in `diff_hunk` tell the model to read a
  file by path, run a script, or rely on a skill, provider or model that the running install may
  not have, instead of putting the needed text into the prompt itself?
- **Триггер:** хунки в `agent/instructions*`, `scripts/memory/instructions/`, `agent/skills/`,
  файлы `*.md` под `agent/`, шаблонные строки, уходящие в `send(`/`buildPrompt`.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev prompt_depends_on_layout: the prompt points the model at a path, script or model it may not have; inline the text or give a tool`.
- **Откуда:** T93 (сентябрь 2026): промпт ночи давал пути к правилам, под `versions/` они не
  читались, ночь шла без скилла; #38 instructions.md требует отсутствующий скилл rich-post; #113 и
  #230 правила учат на путях, которые скрипты не пишут.

## 7. `per_vendor_branch` — заплатка под одного провайдера

- **Вопрос:** Does the code added in `diff_hunk` add a branch keyed on one provider, model or
  vendor (for example `if provider === "claude"`) for behaviour that every provider needs, instead
  of one mechanism that works for all of them?
- **Триггер:** хунки с `provider ===`, `MODEL_PROVIDER`, проверки провайдера по имени, `case "ollama"`
  вне `agent/provider*.ts` и списка моделей.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev per_vendor_branch: a vendor-specific branch patches a shared behaviour; the owner's rule is one mechanism for all providers`.
- **Откуда:** правило владельца 13.09.2026 «класс, не экземпляр; per-vendor хук = заплатка»; серия
  провайдерских починок #236, #239, #240 (Claude), #15 и #219 (Codex), #161 (Ollama).

## 8. `user_text_quality` — текст пользователю: язык, ясность, кнопки

- **Вопрос:** Does the user-facing text added in `diff_hunk` (a Telegram message, menu label,
  notice or error shown in chat) lack the Russian/English pair through `tr()`, expose a stack
  trace, internal identifier, file path or multi-line shell command, or send buttons through
  `reply_markup` rows instead of the project's in-text rich button with an explanation?
- **Триггер:** хунки в `agent/channels/`, `agent/lib/telegram-*`, `scripts/lib/menu/`,
  `scripts/poller/`, `scripts/setup/` со строковыми литералами с кириллицей, `sendMessage`,
  `reply_markup`, `inline_keyboard`, `<tg-button>`.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev user_text_quality: chat text must be ru+en via tr(), plain words, no traces or paths, buttons in text with an explanation`.
- **Откуда:** #210 HookConflictError уходит пользователю сырым; правило 13.09.2026 «пользователю
  только curl … | bash, длинные пайпы в чат запрещены»; кнопки только в rich-сообщении и с
  пояснением (ADR-0015, поломка Android-меню 13.09.2026); CHANGELOG «Отказ запуска обновления из
  меню называет причину».

## 9. `words_or_secrets_in_logs` — слова владельца или секреты в журнале

- **Вопрос:** Does the code added in `diff_hunk` write a token, key, `.env` content, or the user's
  own words (message text, memory content, reminder text) into a log line, diagnostic bundle, error
  message, trace or telemetry?
- **Триггер:** хунки с `console.error`/`console.log`/`log(`, `diagnose`, `JSON.stringify(` объекта
  окружения, авторизации, сообщения или напоминания; хунки в `scripts/cli/diagnose*`,
  `agent/hooks/trace*`, `agent/hooks/transcript*`.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev words_or_secrets_in_logs: a log or bundle carries a secret or the owner's words; log ids and codes, not content`.
- **Откуда:** CHANGELOG «Секрет с строчными percent-escape не уезжает в пакет», «Жалоба
  превращается в пакет улик без секретов», «Провал напоминания в диагностике назван хешем id и кодом
  ошибки, без слов владельца», «Копия .env создаётся сразу приватной»; #40 сервер слушал 0.0.0.0 и
  решал доступ по заголовку Host.

## 10. `update_without_rollback` — обновление без пути назад

- **Вопрос:** Does the code added in `diff_hunk` change the update, install or restart flow
  (version directories, systemd units, symlinks, `.env` copy, node_modules) without a rollback path
  or a check that the previous version still starts if the new one fails?
- **Триггер:** хунки в `scripts/update-*`, `scripts/lib/version-*`, `scripts/cli/systemd*`,
  `scripts/setup/`, `bin/`.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev update_without_rollback: the update path changed without a proven way back; every update needs a candidate probe and a rollback`.
- **Откуда:** #191 прямое обновление через границы старого CLI падает; #175 повторный запуск
  установки повторяет тяжёлые шаги и оставляет мусор; #194 обновление забивает диск; #176 и #181
  кастомный слой роняет старт; волна 0.4.2 (13.09.2026) «не удалось запустить обновление»; CHANGELOG
  «Откат обновления лучше защищает локальные изменения», «Один обновлятор: версия рядом, проба,
  переключение».

## 11. `state_file_for_a_counter` — файл состояния там, где хватит счётчика

- **Вопрос:** Does the code added in `diff_hunk` introduce a new persisted file, lock, queue or
  budget record under the data directory to guarantee something that an in-memory value at the
  place where the events already arrive would guarantee just as well?
- **Триггер:** хунки, добавляющие `writeFile`/`writeFileSync`/`appendFile` под `data/`, новый
  `*.json`/`*.jsonl` в `data/`, `acquireFileLock`, слово `budget`, `stop file`.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev state_file_for_a_counter: a new state file replaces a counter; count where the events are, files only for what must survive a restart`.
- **Откуда:** правило владельца 26.09.2026 «никакого оверинжиниринга, мало кода» после T91
  (1 450 строк, файлы бюджета и стопа) и T92 (LRU, claim/release); файлы состояния гниют: CHANGELOG
  «Одна мусорная строка в tasks.json больше не обнуляет весь список», «Испорченный файл состояния
  расписаний больше не стирает остальные».

## 12. `event_without_dedup` — второе прибытие события действует дважды

- **Вопрос:** Does the code added in `diff_hunk` act on an inbound update, a repeated call after a failure, a replayed event or
  timer without a key (message id, `file_unique_id`, turn id, reminder id) that makes a second
  delivery of the same event a no-op?
- **Триггер:** хунки в `scripts/poller/`, `scripts/lib/telegram-queue*`, `agent/channels/`,
  `agent/lib/telegram-*`, `agent/schedules/` с `replay`, повторными вызовами после отказа, `update_id`, `message_id`,
  `download`, `send`.
- **Порог:** p ≥ 0.7 → пометка.
- **Note:** `jev event_without_dedup: a retried or replayed event has no idempotency key; eve delivers hooks at least once`.
- **Откуда:** #119 фото скачивается дважды при второй доставке; #80 батч медиа обрабатывается как несколько
  сообщений; #78 ложное «в очереди»; волна 04.09.2026 (скан pending за O(n) давал дубли); CHANGELOG
  «Reply отвечает без висяков и дублей», «Напоминание срабатывает ровно один раз».

## Запас (если общий список надо сократить)

- `contract_change_without_consumers` (состояние с `changed_source_files`): сигнатура, формат файла
  или ключ конфига изменены, потребители в том же диффе не тронуты. Откуда: правило 23.09.2026 «чинить
  ровно причину; смена контракта только с правкой всех потребителей», прецедент коммита, давшего #242;
  #130 и #182 скрипты напоминаний импортировали `.ts`, который системный node не грузит.
- `thin_harness_violated`: код решает то, что правила проекта оставляют модели (что писать в карточку,
  как сводить день). Откуда: docs/philosophy.md, правило 12.09.2026 «упрощения не переносят работу с
  модели на код». Вопрос трудный для классификатора, держать порог выше (0.85).

## Как подключить

Каждый вопрос получает ключ `[review] <id> = true` и порог `<id>_threshold`, как у пяти базовых
вопросов плагина. Пометки пишутся в `jev-log.jsonl` рядом с отчётом; по своей истории пороги
пересматриваются. Блокируют только детерминированные проверки.
