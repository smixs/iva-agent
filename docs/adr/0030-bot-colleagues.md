# Коллеги Ивы — отдельные боты Telegram в одном процессе

Решение владельца 26.11.2026 (нить `thr_f5w4ebcp5s`): вместо тем в одном чате Иву дополняют
отдельные боты Telegram — **Colleague (коллега)** со своей ролью, своей моделью и своей
перепиской, общей памятью Vault и общими инструментами Ивы. Все боты работают в **одном
процессе** Ивы («Один процесс на всех»).

Этот ADR фиксирует архитектурную границу шага 1/6 (приём и отправка от нескольких ботов) и
полную опись всех мест чтения `TELEGRAM_BOT_TOKEN` до первой правки кода.

## Что решено

1. **Механизм живёт во встроенном коде (Authored tree + Bridge), а не плагином.**
   Приём обновлений Telegram (`scripts/poller/`) и Channel (`agent/channels/telegram.ts`) живут
   во встроенном коде Ивы; формат Agent Plugins (ADR-0008, ADR-0009) добавляет скиллы, MCP и
   сервисы, но не расширяет транспортный Channel и Bridge. Выносить многоботовый приём в
   плагин значило бы завести второй транспортный шов в обход Inbound pipeline и Outbox
   (`docs/philosophy.md` §2).

2. **Токены коллег хранятся рядом с токеном Ивы в её секретах.**
   Токены коллег лежат в `.env` (права `0600`, вне git, в `.gitignore`) в переменной
   `TELEGRAM_COLLEAGUE_BOT_TOKENS` рядом с `TELEGRAM_BOT_TOKEN`. Формат значения — список
   записей через запятую (`<токен>` или `<username>=<токен>`), совместимый с общим подмножеством
   `node --env-file` и systemd `EnvironmentFile=` без кавычек и `#`. Переменная внесена в
   `agent/skills/security-defense/outbound-sensitive-keys.json`, а каждый отдельный токен
   коллеги дополнительно вырезается outbound-Gate (`agent/lib/security-gate.ts`) и проверкой
   вложений (`agent/tools/send_file.ts`).

3. **Один процесс Bridge и один замок на всех ботов, свой offset на каждого бота.**
   Процесс `telegram-poll` по-прежнему держит один общепользовательский замок
   (`acquireTelegramProcessLock`). Основной бот Ивы сохраняет `data/telegram-offset.json` и
   `data/telegram-backlog-drop.json` без изменений; каждый коллега ведёт собственный offset в
   `data/telegram-offsets.d/<botId>.json`. Опрос ботов идёт независимыми
   асинхронными циклами внутри одного процесса: задержка, сетевой сбой или 409-конфликт одного
   бота не задерживают опрос и приём сообщений другого.

   **Первый запуск коллеги — не первый запуск установки.** У основного бота первый запуск
   установки один раз подтверждает старый install-backlog (`drop_pending_updates=true` и
   fast-forward); у коллеги первый запуск совпадает с включением опции владельцем, поэтому
   его очередь — это свежие сообщения владельца, отправленные, пока опция была выключена.
   Эти сообщения нельзя молча стирать. Ленивая инициализация коллеги всегда вызывает
   `deleteWebhook` с `drop_pending_updates=false`, никогда не делает fast-forward и при
   отсутствии cursor-файла сохраняет offset `0`: первый обычный `getUpdates` забирает всю
   сохранённую Telegram-очередь и дальше подтверждает апдейты только после durable admit.
   Маркер backlog-drop коллеге не нужен: он существует только чтобы не повторить разрушительный
   drop первой установки, а у коллеги такого drop нет. Существующий cursor означает обычный
   resume без каких-либо признаков первого запуска.

4. **Сквозная метка бота и изоляция ключей.**
   Входящий апдейт коллеги помечается полем конверта `iva_bot_id` (добавлено в
   `TELEGRAM_MESSAGE_ENVELOPE_KEYS`) и передаётся в Channel также заголовком
   `X-Iva-Telegram-Bot-Id`. Ключи inbox, очереди, Chat record (`run-status.d/`), дедупликации
   (`completed-updates.<botId>.json`) и сессии Eve (`from(address)`) для коллеги получают
   префикс `bot:<botId>:`, поэтому личный чат владельца (где `chat.id === user.id`) и общие
   группы двух ботов не сталкиваются ни в очередях, ни в сессиях. Для основного бота Ивы
   (и без коллег) все ключи и файлы остаются прежними.

5. **Исходящие вызовы идут токеном бота-адресата без правки `eve/`.**
   `eve/packages/eve/src/public/channels/telegram/api.ts` уже поддерживает динамический
   `credentials.botToken: () => string`. Channel передаёт поставщик токена поверх
   `AsyncLocalStorage` активного бота, сохраняя `botId` в `TelegramChannelState` сессии:
   любой ответ (Outbox, rich, widget, typing, draft, progress message, ошибки, callback ack,
   скачивание медиа и `send_file`) уходит от имени того бота, которому пришло сообщение.

6. **Опция по умолчанию выключена.**
   Без настроенных коллег (один `TELEGRAM_BOT_TOKEN`) поведение Bridge и Channel совпадает с
   одноботовым выпуском 0.5.15. В `data/settings.json` опция живёт под ключом
   `colleagues: { enabled: boolean, items: Record<botId, ColleagueEntry> }`
   (`agent/lib/colleagues.ts`), по умолчанию `enabled: false`. При выключенной опции Bridge не
   опрашивает ботов коллег и отбрасывает их апдейты, а Channel и диспетчер напоминаний не
   запускают ходы коллег.

7. **Роль, своя модель, своя переписка, общий Vault и свои расписания (шаг 2/6).**
   - Четыре базовые роли: `critic` (Критик), `programmer` (Программист), `researcher`
     (Исследователь), `secretary` (Секретарь). Роль инжектится динамической инструкцией
     `agent/instructions/01-colleague.ts` на каждый ход коллеги (без перезапуска).
   - У каждого коллеги свой провайдер из `MODEL_PROVIDER_NAMES` и своя модель; Ива предлагает
     модель под роль (`suggestColleagueModel`), а менять модель вправе и Ива (инструмент
     `colleague`, `agent/tools/colleague.ts` — запись только в личном чате владельца), и
     владелец (`iva colleague model <botId> <provider> <model>`).
   - Переписка коллеги изолирована от переписки Ивы в сессиях Eve (`bot:<botId>:…`) и не
     пишется в дневник Ивы `vault/daily/`; долговременная память Vault (`CORE.md`, `cards/`,
     `memory_search`, `write_card`) и полный набор инструментов Ивы общие.
   - Напоминания и расписания коллеги сохраняют необязательное поле `chat.botId` в
     `data/reminders.json` (для Ивы и прежних строк поле отсутствует): в срок
     `scripts/reminders/fire.ts` запускает ход с заголовком `X-Iva-Telegram-Bot-Id` (на модели
     и роли этого коллеги) и доставляет результат в его чат токеном его бота.

8. **Найм коллеги по ссылке с подтверждением владельца и случайным талисманом (шаг 3/6).**
   - Ива предлагает нанять коллегу через инструмент `colleague` (`action: "hire"`) или CLI
     `iva colleague hire <role>`, собирая ссылку Bot API 9.6
     `https://t.me/newbot/<бот Ивы>/<имя>bot?name=…` и сохраняя открытое предложение найма
     (`colleagues.pendingHires` в `data/settings.json`, TTL 24 ч). Бота Ива сама не создаёт —
     подтверждение всегда за владельцем в Telegram.
   - Основной цикл Bridge запрашивает `"managed_bot"` в `allowed_updates`. По приходе
     `managed_bot` (`scripts/poller/managed-bot.ts`) проверяет Allowlist владельца, получает
     токен через `getManagedBotToken`, атомарно записывает его в `.env`
     (`TELEGRAM_COLLEAGUE_BOT_TOKENS`, права `0600`), сохраняет роль/модель/имя в
     `data/settings.json`, ставит имя и описание роли (`setMyName`, `setMyDescription`,
     `setMyShortDescription`) и сразу запускает опрос нового коллеги в том же процессе Bridge.
     Канал Eve, `send_file` и outbound-Gate читают актуальный `TELEGRAM_COLLEAGUE_BOT_TOKENS`
     через `liveTelegramEnv` (`packages/telegram-bots/index.ts`), поэтому новый коллега
     принимает и отвечает без перезапуска сервисов.
   - Найм имеет durable журнал стадий `data/colleague-hires.d/<botId>.json` (права `0600`,
     без токена): решение о роли/модели/имени пишется до первого вызова Bot API, затем стадии
     `token -> profile -> settings` отмечают доведённые части. Временный сбой
     `getManagedBotToken` (тайм-аут, 429, 5xx) и сбои записи настроек повторяют управляющее
     событие конечное число раз; по исчерпании предела событие подтверждается строкой журнала
     с `update_id`, а фоновая сверка `reconcilePendingColleagueHires` получает токен и доводит
     найм без блокировки обычного входа. Постоянный отказ Bot API 4xx терминален для этого
     события. При старте Bridge опрашивает только коллегу, у которого есть и токен, и
     complete-запись роли/модели в `data/settings.json`; одиночный токен от незавершённого
     найма опрос не начинает.
   - Аватарка коллеги — случайный талисман библиотеки `ip-as-logo` без связи с ролью,
     сконвертированный в JPG 640×640 (`scripts/lib/colleague-avatar.ts`) и загруженный через
     `setMyProfilePhoto`. Состояние аватарки — явная машина фаз `avatarPhase`
     (`"pending" | "set" | "retry"`): при недоступности `ip-as-logo` или сбое загрузки бот
     сразу работает без фото (`avatarPhase: "retry"`), а Bridge повторяет попытку с
     экспоненциальной паузой (`reconcilePendingColleagueAvatars`).

## Что отвергнуто

- **Отдельный процесс / отдельный systemd-юнит на каждого коллегу.** Противоречит решению
  владельца «Один процесс на всех», умножает память и усложняет обновление и замок Bridge.
- **Плагин вместо встроенного кода.** Плагин не имеет шва к `scripts/poller/` и
  `agent/channels/telegram.ts`; копирование поллера в сервис плагина породило бы второй
  независимый вход и второй Outbox (нарушение `docs/philosophy.md` §2).
- **Общий `telegram-offset.json` на всех ботов.** `update_id` в Telegram независим у каждого
  бота; общий курсор перепрыгивает необработанные обновления более медленного бота (доказано
  мутантом модели `specs/MultiBotPoll-shared-offset.cfg`).
- **Drop или fast-forward очереди коллеги при первом включении.** Такая очередь состоит не из
  шумного install-backlog, а из сообщений владельца, отправленных боту до `iva colleague on`;
  молча удалять их нельзя. Поэтому первая активация начинается с offset `0` и сохраняет очередь
  для обычного durable ingress.
- **Правка `eve/packages/eve/src/public/channels/telegram/api.ts`.** `resolveTelegramBotToken`
  уже принимает функцию; правка `eve/` потребовала бы пересборки и выпуска нового архива eve
  без функциональной необходимости (принцип «сначала бери то, что eve уже делает»,
  `docs/philosophy.md` §4).

## Полная опись мест чтения `TELEGRAM_BOT_TOKEN` (до кода)

Ниже перечислены все файлы, которые возвращает
`rg -l TELEGRAM_BOT_TOKEN agent scripts eve/packages/eve/src` на базе `075433f5` (всего 126:
30 рабочих файлов и 96 файлов тестов, фикстур и смоков), с решением на каждое место.

### Рабочий код (30 файлов)

| Файл | Строки | Решение | Обоснование |
|---|---|---|---|
| `agent/channels/telegram.ts` | 108, 205 | **бот адресата** | `credentials.botToken` динамический по активному боту; `sendWidget` берёт токен адресата (фолбэк `TELEGRAM_BOT_TOKEN`) |
| `agent/lib/telegram-acceptance.ts` | 113 | **бот адресата** | `botId` берётся из запроса/метки апдейта (фолбэк `TELEGRAM_BOT_TOKEN`); отдельный ledger `completed-updates.<botId>.json` на коллегу |
| `agent/lib/telegram-bot-context.ts` | 29 | **бот адресата** | Новый модуль контекста активного бота (`AsyncLocalStorage`): возвращает токен активного бота, при отсутствии бросает `TELEGRAM_BOT_TOKEN is required.` |
| `agent/lib/telegram-inbound.ts` | 694 | **бот адресата** | `botId` адресата передаётся в `buildTelegramReplyContext` и `auth.attributes.bot_id` (фолбэк `TELEGRAM_BOT_TOKEN`) |
| `agent/lib/telegram-media.ts` | 72, 366 | **бот адресата** | Скачивание файла `/file/bot<token>/…` и маскирование токена в ошибке используют токен адресата |
| `agent/tools/send_file.ts` | 282 | **бот адресата** | Отправка файла в чат хода берёт токен по `bot_id` хода (фолбэк `TELEGRAM_BOT_TOKEN`); проверка утечки проверяет и токены коллег |
| `agent/skills/security-defense/outbound-sensitive-keys.json` | 16 | **бот адресата** | Сохраняем `TELEGRAM_BOT_TOKEN` и добавляем `TELEGRAM_COLLEAGUE_BOT_TOKENS`, чтобы outbound-Gate вырезал секреты всех ботов |
| `eve/packages/eve/src/public/channels/telegram/api.ts` | 100–103 | **не трогаем** | `resolveTelegramBotToken` уже принимает `token?: string \| (() => string \| Promise<string>)`; `TELEGRAM_BOT_TOKEN` лишь фолбэк |
| `scripts/poller/config.ts` | 13 | **бот адресата** | `TOKEN` остаётся токеном Ивы для совместимости; рядом строится реестр ботов из `TELEGRAM_BOT_TOKEN` и `TELEGRAM_COLLEAGUE_BOT_TOKENS` |
| `scripts/poller/main.ts` | 319 | **бот адресата** | Требует основной `TELEGRAM_BOT_TOKEN` и запускает независимый опрос всех настроенных ботов в одном процессе под одним замком |
| `scripts/poller/update-flow.ts` | 451, 474 | **бот Ивы** | Экран обновления инсталляции принадлежит основному боту Ивы |
| `scripts/reminders/fire.ts` | 246, 259 | **бот Ивы** | На шаге 1/6 диспетчер Reminder шлёт через бота Ивы; расписания коллег — отдельный шаг |
| `scripts/reminders/command.ts` | 92 | **бот Ивы** | Alert командных задач инсталляции шлёт Ива |
| `scripts/jobs/watchdog.ts` | 13, 21 | **бот Ивы** | Сторож расписаний инсталляции шлёт Alert от Ивы |
| `scripts/jobs/wake.ts` | 41, 55 | **бот Ивы** | Пробуждение по сбоям расписаний шлёт Ива |
| `scripts/proactive/precheck.ts` | 345 | **бот Ивы** | Watch юзербота отфильтровывает собственный чат бота Ивы |
| `scripts/proactive/tick.ts` | 1546 | **бот Ивы** | Watch, Brief и Insight отправляет Ива |
| `scripts/memory/night.ts` | 1131 | **бот Ивы** | Ночной Report Rollup отправляет Ива |
| `scripts/memory/brain.ts` | 195 | **бот Ивы** | Ночной Alert Brain отправляет Ива |
| `scripts/model-auth-alert.ts` | 10 | **бот Ивы** | Alert протухшей авторизации модели отправляет Ива |
| `scripts/check-update.ts` | 123 | **бот Ивы** | Alert о новом Release отправляет Ива |
| `scripts/update-finish.ts` | 896 | **бот Ивы** | Итог `iva update` отправляет Ива |
| `scripts/cli/version-update-command.ts` | 304 | **бот Ивы** | Прогресс обновления из CLI отправляет Ива |
| `scripts/cli/doctor.ts` | 566 | **бот Ивы** | `iva doctor` проверяет обязательный основной токен установки |
| `scripts/cli/notify.ts` | 35, 37 | **бот Ивы** | CLI-команда `iva notify` отправляет от имени Ивы |
| `scripts/cli/post.ts` | 377, 379 | **бот Ивы** | CLI-команда `iva post` отправляет от имени Ивы |
| `scripts/cli/remind.ts` | 41, 43 | **бот Ивы** | CLI-команда напоминаний работает через бота Ивы |
| `scripts/cli/plugin-cli-proposal.ts` | 89, 91 | **бот Ивы** | Предложение плагина на тап владельца идёт только через бота Ивы |
| `scripts/setup/steps.ts` | 868, 871, 991 | **бот Ивы** | Мастер первоначальной настройки инсталляции спрашивает основной токен |
| `scripts/setup/config-file.ts` | 46 | **бот Ивы** | Список ключей конфигурации установки |
| `scripts/setup/wizard.ts` | 97, 226 | **бот Ивы** | Проверка обязательных переменных инсталляции |

### Тесты, фикстуры и смоки (96 файлов — решение: **не трогаем**)

Следующие 96 файлов упоминают `TELEGRAM_BOT_TOKEN` как тестовую переменную окружения, фикстуру
или проверку одноботового пути и не требуют замены на многоботовый выбор токена:

- `agent/lib/inbound-chaos-muse.test.ts`
- `agent/lib/job-facts.test.ts`
- `agent/lib/model-auth-dispatch.test.ts`
- `agent/lib/open-failures.test.ts`
- `agent/lib/telegram-bot-context.test.ts`
- `agent/lib/telegram-inbound-chaos.property.test.ts`
- `agent/lib/telegram-inbound.test.ts`
- `agent/lib/telegram-media-chaos.property.test.ts`
- `agent/lib/telegram-media.test.ts`
- `scripts/chat-record.test.ts`
- `scripts/cli/config.test.ts`
- `scripts/cli/diagnose.test.ts`
- `scripts/cli/doctor.test.ts`
- `scripts/cli/main.test.ts`
- `scripts/cli/notify.test.ts`
- `scripts/cli/plugin-description-cap.test.ts`
- `scripts/cli/plugin.test.ts`
- `scripts/cli/post.test.ts`
- `scripts/cli/remind.test.ts`
- `scripts/cli/signal.property.test.ts`
- `scripts/cli/signal.test.ts`
- `scripts/cli/systemd.test.ts`
- `scripts/cli/version-update-telegram.test.ts`
- `scripts/compaction-kill-matrix.test.ts`
- `scripts/diagnose-usage-shell.test.ts`
- `scripts/env-runtime-agreement.test.ts`
- `scripts/fixtures/queue-drain-model.ts`
- `scripts/fixtures/reset-bridge-restart-child.ts`
- `scripts/fixtures/setup-wizard/fresh.env.txt`
- `scripts/fixtures/setup-wizard/reconfigure.env.txt`
- `scripts/fixtures/telegram-main-guard-child.ts`
- `scripts/fixtures/telegram-poll-queue-harness.ts`
- `scripts/fixtures/telegram-process-lock-child.ts`
- `scripts/fixtures/update-pin-harness.ts`
- `scripts/helper-enabled-wire.test.ts`
- `scripts/helper-w4-consumers.test.ts`
- `scripts/install-decisions.test.ts`
- `scripts/install-shell.test.ts`
- `scripts/jobs/wake.test.ts`
- `scripts/lib/health-probe.test.ts`
- `scripts/lib/reminder-turn-island.test.ts`
- `scripts/lib/telegram-queue.test.ts`
- `scripts/lib/update-check.test.ts`
- `scripts/lib/update-ui.test.ts`
- `scripts/memory/brain.test.ts`
- `scripts/memory/night-process.test.ts`
- `scripts/pbt-r4-update-crash.test.ts`
- `scripts/poller/config.test.ts`
- `scripts/poller/control.test.ts`
- `scripts/poller/deliver.test.ts`
- `scripts/poller/entrypoint.test.ts`
- `scripts/poller/ingress-chaos-deepseek-3-3.property.test.ts`
- `scripts/poller/multi-bot.test.ts`
- `scripts/poller/plugin-proposal-tap.test.ts`
- `scripts/poller/queue-batch.test.ts`
- `scripts/poller/queued-sign.test.ts`
- `scripts/poller/status-before-050.test.ts`
- `scripts/poller/update-flow.test.ts`
- `scripts/poller/update-reconcile.test.ts`
- `scripts/poller/wizards-callback.test.ts`
- `scripts/proactive/insight.test.ts`
- `scripts/proactive/precheck.test.ts`
- `scripts/proactive/tick-chaos.property.test.ts`
- `scripts/proactive/tick.test.ts`
- `scripts/proactive/watch-live.test.ts`
- `scripts/reminder-failure-consumers.test.ts`
- `scripts/reminders/fire-child.test.ts`
- `scripts/reminders/fire.test.ts`
- `scripts/reminders/lifecycle.test.ts`
- `scripts/reminders/precision.test.ts`
- `scripts/restart-mid-compaction.test.ts`
- `scripts/restart-mid-turn.test.ts`
- `scripts/restart-retry-button.test.ts`
- `scripts/send-file-repair.test.ts`
- `scripts/send-file-tool.test.ts`
- `scripts/setup/main.test.ts`
- `scripts/setup/steps.test.ts`
- `scripts/setup/wizard.test.ts`
- `scripts/smoke/harness.ts`
- `scripts/smoke/reminders.smoke.ts`
- `scripts/stop-mid-turn.test.ts`
- `scripts/telegram-acceptance.test.ts`
- `scripts/telegram-compact.test.ts`
- `scripts/telegram-failure-events.test.ts`
- `scripts/telegram-media-identity.test.ts`
- `scripts/telegram-multi-bot-channel.test.ts`
- `scripts/telegram-poll-entrypoint.test.ts`
- `scripts/telegram-poll-reset.test.ts`
- `scripts/telegram-poll.test.ts`
- `scripts/telegram-question-events.test.ts`
- `scripts/telegram-reply-context.test.ts`
- `scripts/telegram-reset-mixed.test.ts`
- `scripts/telegram-reset-restart.test.ts`
- `scripts/telegram-rich-replies.test.ts`
- `scripts/telegram-status-never.test.ts`
- `scripts/telegram-status-progress.test.ts`
- `scripts/update-finish.test.ts`
- `scripts/version-050-telegram.test.ts`
- `scripts/version-050.test.ts`

Дополнительно, в Bridge `scripts/poller/transport.ts` и `scripts/poller/queue.ts` читают
импортированный `TOKEN` из `scripts/poller/config.ts` (без прямого `TELEGRAM_BOT_TOKEN`); оба
модуля также переводятся на токен бота-адресата с фолбэком на `TOKEN` Ивы.
