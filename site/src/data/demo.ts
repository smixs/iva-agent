// Transcript and event frames from V6 -> v5/Film5.tsx. Titles, logo and connection
// interstitials are omitted; Telegram content and the five default choices are retained.
export type DemoLang = "ru" | "en";
export type ActionId = "reminder" | "taxi" | "invoice" | "restaurant" | "shopping";
export type DemoBlock = { kind: "title" | "p" | "item"; text: string; emoji?: string };
export type DemoMessage = {
  id: string; at: number; think?: number; time?: string;
  kind: "card" | "out" | "voice" | "date" | "venue" | "in";
  blocks?: DemoBlock[]; text?: string; action?: ActionId;
};
const NB = "\u00a0";
const p = (text: string): DemoBlock => ({ kind: "p", text });
const item = (emoji: string, text: string): DemoBlock => ({ kind: "item", emoji, text });
export const actionFrames: Record<ActionId, number> = {
  reminder: 2200, taxi: 2590, invoice: 3090, restaurant: 3350, shopping: 3790,
};
export const demoCopy = {
  ru: {
    label: "Интерактивная демонстрация Ивы в Telegram",
    demo: "Демо", hint: "Демо: нажимайте кнопки в чате", viewed: "Просмотрено",
    note: "Все действия происходят внутри демонстрации.",
    play: "Продолжить", pause: "Пауза", replay: "Сначала", next: "Следующая сцена",
    end: "Демонстрация завершена", paused: "На паузе", playing: "Воспроизведение",
    today: "Сегодня", yesterday: "Вчера", iva: "Ива", maria: "Мария", bot: "бот",
    online: "в сети", typing: "печатает", thinking: "Думаю…", message: "Сообщение",
    voice: "Голосовое сообщение, 12 секунд", invoice: "Счёт №14.pdf",
    restaurant: "Ресторан «Олива»", address: "Садовая ул., 18",
    map: "Карта расположения ресторана «Олива»",
    scenes: ["Утро", "Голосовое и CRM", "Кто писал", "Напоминание", "Такси для Алеси", "Счёт Тимуру", "Ресторан для Марии", "Чат с Марией", "Покупки", "Задача про интернет", "Интернет починили"],
    choices: {
      reminder: { yes: "Напомнить", no: "Не надо", accepted: `✅ Напомню завтра в${NB}10:00`, declined: "Хорошо, напоминание пропускаю." },
      taxi: { yes: "Заказать", no: "Не надо", accepted: `✅ Такси будет в${NB}19:15`, declined: "Хорошо, такси пропускаю." },
      invoice: { yes: "Отправить", no: "Не сейчас", accepted: "✅ Отправила Тимуру", declined: "Хорошо, письмо остаётся черновиком." },
      restaurant: { yes: "Скинуть", no: "Не надо", accepted: "✅ Скинула Марии", declined: "Хорошо, ресторан оставляю здесь." },
      shopping: { yes: "Составить", no: "Не надо", accepted: "", declined: "Хорошо, список покупок пропускаю." },
    },
    shopping: [item("🥦", "Брокколи"), item("🐟", "Рыба"), item("🥚", "Яйца"), item("🍗", "Курица"), item("🥛", "Кефир")],
    mariaMessages: ["Завтра в силе?", "Да, в 19", "Куда ехать?"],
  },
  en: {
    label: "Interactive Iva demo in Telegram",
    demo: "Demo", hint: "Demo: try the buttons in the chat", viewed: "Viewed",
    note: "Every action takes place inside this demo.",
    play: "Continue", pause: "Pause", replay: "Replay", next: "Next scene",
    end: "Demo complete", paused: "Paused", playing: "Playing",
    today: "Today", yesterday: "Yesterday", iva: "Iva", maria: "Maria", bot: "bot",
    online: "online", typing: "typing", thinking: "Thinking…", message: "Message",
    voice: "Voice message, 12 seconds", invoice: "Invoice №14.pdf",
    restaurant: "Oliva restaurant", address: "18 Sadovaya St.",
    map: "Map showing Oliva restaurant",
    scenes: ["Morning", "Voice note and CRM", "Who messaged", "Reminder", "Alesya’s taxi", "Timur’s invoice", "Restaurant for Maria", "Chat with Maria", "Shopping", "Fixing the internet", "Internet fixed"],
    choices: {
      reminder: { yes: "Remind me", no: "No thanks", accepted: "✅ I’ll remind you tomorrow at 10:00", declined: "Okay, skipping the reminder." },
      taxi: { yes: "Book it", no: "No thanks", accepted: "✅ The taxi will be there at 19:15", declined: "Okay, skipping the taxi." },
      invoice: { yes: "Send", no: "Not now", accepted: "✅ Sent to Timur", declined: "Okay, the email stays a draft." },
      restaurant: { yes: "Share it", no: "No thanks", accepted: "✅ Shared with Maria", declined: "Okay, keeping the restaurant here." },
      shopping: { yes: "Make a list", no: "No thanks", accepted: "", declined: "Okay, skipping the shopping list." },
    },
    shopping: [item("🥦", "Broccoli"), item("🐟", "Fish"), item("🥚", "Eggs"), item("🍗", "Chicken"), item("🥛", "Kefir")],
    mariaMessages: ["Still on for tomorrow?", "Yes, at 7", "Where should I go?"],
  },
} as const;

export function demoMessages(lang: DemoLang): DemoMessage[] {
  const ru = lang === "ru";
  const t = (r: string, e: string) => ru ? r : e;
  return [
    { id: "morning", at: 300, think: 250, kind: "card", time: "9:41", blocks: [
      { kind: "title", text: t("☀️ Доброе утро!", "☀️ Good morning!") },
      p(t(`Я твоя Ива. Вот что у нас на${NB}сегодня:`, "I’m your Iva. Here’s what we have today:")),
      item("📅", t(`11:00 встреча с${NB}Тимуром`, "11:00 meeting with Timur")),
      item("✍️", t(`Арсен ждёт подпись в${NB}DocuSign`, "Arsen is waiting for your signature in DocuSign")),
      item("🎂", t(`У${NB}Марии сегодня день рождения`, "It’s Maria’s birthday today")),
    ] },
    { id: "voice", at: 1240, kind: "voice", time: "12:04" },
    { id: "crm", at: 1380, think: 1290, kind: "card", time: "12:04", blocks: [
      p(t(`✅ Принято. Итоги встречи записала в${NB}Bitrix24. Во${NB}вторник напомню позвонить Олегу.`, "✅ Got it. I’ve saved the meeting notes in Bitrix24. I’ll remind you to call Oleg on Tuesday.")),
    ] },
    { id: "who-ask", at: 1530, kind: "out", time: "12:10", text: t("Что мне сегодня писали?", "What did people message me today?") },
    { id: "who", at: 1630, think: 1570, kind: "card", time: "12:10", blocks: [
      p(t("Тебе писали трое:", "Three people messaged you:")),
      item("💬", t(`Арсен про${NB}договор`, "Arsen about the contract")),
      item("🍽", t(`Мария про${NB}ужин`, "Maria about dinner")),
      item("💵", t("Тимур ждёт счёт", "Timur is waiting for the invoice")),
    ] },
    { id: "reminder", at: 2060, think: 2010, kind: "card", action: "reminder", time: "13:00", blocks: [
      p(t(`🗂 В${NB}Bitrix24 обновились 3${NB}карточки клиентов. Напомнить завтра?`, "🗂 Three client cards changed in Bitrix24. Remind you tomorrow?")),
    ] },
    { id: "flight-ask", at: 2330, kind: "out", time: "15:20", text: t("Во сколько Алеся прилетает?", "What time does Alesya arrive?") },
    { id: "taxi", at: 2420, think: 2370, kind: "card", action: "taxi", time: "15:20", blocks: [
      p(t(`✈️ Нашла её билеты. Прилетает в${NB}19:30. Заказать такси?`, "✈️ I found her tickets. She arrives at 19:30. Book a taxi?")),
    ] },
    { id: "invoice", at: 2950, think: 2910, kind: "card", action: "invoice", time: "16:05", blocks: [
      p(t(`✉️ Тимур ждёт счёт на${NB}$4${NB}800. Письмо готово. Отправить?`, "✉️ Timur is waiting for the $4,800 invoice. The email is ready. Send it?")),
    ] },
    { id: "restaurant", at: 3220, think: 3180, kind: "card", action: "restaurant", time: "17:41", blocks: [
      p(t("📍 Мария спрашивает, куда ехать. Скинуть ей ресторан?", "📍 Maria asks where to go. Share the restaurant with her?")),
    ] },
    { id: "shopping", at: 3640, think: 3600, kind: "card", action: "shopping", time: "18:30", blocks: [
      p(t(`🥗 На${NB}прошлой неделе ты просил помочь снизить вес. Составить список покупок на${NB}неделю?`, "🥗 Last week you asked for help losing weight. Make a shopping list for the week?")),
    ] },
    { id: "goal-ask", at: 3950, kind: "out", time: "19:04", text: t("Интернет не работает третий день. Добейся, чтобы починили", "The internet has been down for three days. Make sure they fix it") },
    { id: "goal", at: 4050, think: 3990, kind: "card", time: "19:05", blocks: [
      p(t(`Нашла почту провайдера, написала в${NB}поддержку. Ставлю задачу на${NB}мониторинг. Если не${NB}ответят, напишу директору.`, "I found the provider’s email and contacted support. I’m monitoring the task. If they don’t reply, I’ll write to the director.")),
    ] },
    { id: "next-day", at: 4220, kind: "date", text: t("Сегодня", "Today") },
    { id: "done", at: 4226, kind: "card", time: "14:31", blocks: [
      p(t(`✅ Интернет починили. Мастер был в${NB}14:00.`, "✅ The internet is fixed. The technician came at 14:00.")),
    ] },
  ];
}

// Bounded demo catalog, taken from scripts/lib/model-catalog.ts (CATALOG) and
// scripts/poller/wizards.ts. The real installation loads the live provider catalog.
export const demoProviders = {
  codex: { ru: "OpenAI (подписка)", en: "OpenAI (subscription)", models: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"] },
  claude: { ru: "Claude (подписка Pro/Max)", en: "Claude (Pro/Max subscription)", models: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
  ollama: { ru: "Ollama Cloud", en: "Ollama Cloud", models: ["deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2"] },
} as const;
export type DemoProvider = keyof typeof demoProviders;
// Root labels and descriptions follow scripts/lib/menu/root.ts and docs/menu.md.
// Screens that would need an account, keys or real data are an explicitly read-only preview.
export const demoMenuEntries = {
  model: { ru: "🧠 Модель", en: "🧠 Model" },
  thinking: { ru: "🤔 Размышления", en: "🤔 Thinking" },
  search: { ru: "🔍 Поиск", en: "🔍 Search" },
  language: { ru: "🌐 Язык", en: "🌐 Language" },
  rich: { ru: "💬 Богатые ответы", en: "💬 Rich replies" },
  voice: { ru: "🎤 Голос", en: "🎤 Voice" },
  character: { ru: "🎭 Характер", en: "🎭 Character" },
  memory: { ru: "💾 Память", en: "💾 Memory" },
  userbot: { ru: "📡 Userbot", en: "📡 Userbot" },
  google: { ru: "🔗 Google", en: "🔗 Google" },
  timers: { ru: "⏰ Кроны", en: "⏰ Timers" },
  notices: { ru: "🔔 Уведомления", en: "🔔 Notices" },
  skills: { ru: "🧩 Скиллы", en: "🧩 Skills" },
  status: { ru: "📊 Статус", en: "📊 Status" },
  maintenance: { ru: "🛠 Обслуживание", en: "🛠 Maintenance" },
} as const;
export type DemoMenuEntry = keyof typeof demoMenuEntries;
export const demoMenuInfo: Partial<Record<DemoMenuEntry, { ru: string; en: string }>> = {
  thinking: { ru: "Уровень размышлений выбирается для текущей модели. Изменение применяется после перезапуска.", en: "Thinking levels depend on the current model. Changes apply after a restart." },
  search: { ru: "Поиск: Tavily, Brave, Exa или Parallel. В своей Иве провайдер и ключ настраиваются здесь.", en: "Search uses Tavily, Brave, Exa or Parallel. Configure the provider and key here in your own Iva." },
  rich: { ru: "Авто: таблицы, списки задач и формулы приходят богатыми сообщениями Telegram. Доступен и обычный текст.", en: "Auto sends tables, task lists and formulas as Telegram rich messages. Plain text is also available." },
  voice: { ru: "Голосовые расшифровывает Deepgram. Доступны автоопределение языка, русский, английский и узбекский.", en: "Deepgram transcribes voice notes. Choose automatic language detection, Russian, English or Uzbek." },
  character: { ru: "Тест из десяти утверждений подбирает тон, выразительность, инициативу и способ объяснять.", en: "A ten-statement test shapes tone, expression, initiative and how Iva explains things." },
  memory: { ru: "Интервью из шести вопросов помогает Иве запомнить, как к вам обращаться, ваши дела, приоритеты и границы.", en: "A six-question interview helps Iva remember your name, work, priorities and boundaries." },
  userbot: { ru: "Личный Telegram-аккаунт подключается по вашему выбору: Ива сможет читать ваши чаты и писать от вашего имени.", en: "Connect your personal Telegram account if you choose. Iva can then read your chats and write on your behalf." },
  google: { ru: "Подключение Google даёт доступ к Gmail, Календарю, Tasks, Drive, Sheets и Docs.", en: "Google connects Gmail, Calendar, Tasks, Drive, Sheets and Docs." },
  timers: { ru: "Здесь показаны расписания Ивы, ближайшие напоминания и результаты последних запусков.", en: "This screen shows Iva’s schedules, upcoming reminders and the results of recent runs." },
  skills: { ru: "Здесь перечислены установленные скиллы с коротким описанием каждого.", en: "Installed skills are listed here with a short description of each." },
  maintenance: { ru: "Диагностика, уборка памяти, ночной уход и обновление запускаются здесь с подтверждением.", en: "Run diagnostics, memory cleanup, nightly care and updates here, after confirmation." },
};
export const demoMenuCopy = {
  ru: {
    installIva: "Установить Иву", open: "Открыть меню Ивы", settings: "⚙️ Настройки", close: "✖ Закрыть", back: "‹ Меню",
    demo: "Демо настроек: изменения действуют только здесь.",
    preview: "Это обзор экрана. Подключения и команды доступны в своей Иве.",
    now: "Сейчас", provider: "Выбери провайдера:", chooseModel: "Выбери модель:",
    restart: "Применить и перезапустить?", restartButton: "Перезапустить",
    restartNote: "В демо показан перезапуск. Реальный сервер остаётся без изменений.",
    restarted: "✅ Перезапуск показан в демо. Модель выбрана.",
    closed: "Настройки закрыты.", writes: "Сама пишет", on: "включено", off: "выключено",
    notices: "Присмотр за пропущенным и обзор дня в 08:30 и 14:00. О сбоях Ива пишет всегда.",
    language: "🌐 Язык интерфейса", languageNote: "Язык меню меняется сразу. Переписка выше — запись демонстрации.",
    install: "Хотите установить Иву — личного AI-помощника в Telegram?", yes: "Установить Иву", no: "Не сейчас",
    installNext: "Передайте фразу своему агенту Codex или Claude — он установит Иву.",
    installLater: "Хорошо, установить Иву можно позже.",
    copied: "Фраза для установки Ивы скопирована.", copyDenied: "Скопируйте фразу для установки Ивы:",
    copyPending: "Копирую фразу для установки Ивы…",
  },
  en: {
    installIva: "Install Iva", open: "Open Iva’s menu", settings: "⚙️ Settings", close: "✖ Close", back: "‹ Menu",
    demo: "Demo settings: changes apply only here.",
    preview: "This is a screen preview. Connections and commands are available in your own Iva.",
    now: "Now", provider: "Pick a provider:", chooseModel: "Pick a model:",
    restart: "Apply and restart?", restartButton: "Restart",
    restartNote: "This demo shows the restart. No real server is changed.",
    restarted: "✅ Restart shown in the demo. Model selected.",
    closed: "Settings closed.", writes: "Writes on her own", on: "on", off: "off",
    notices: "Watch for missed items and a daily brief at 08:30 and 14:00. Iva always reports failures.",
    language: "🌐 Interface language", languageNote: "The menu language changes immediately. The chat above is a recorded demonstration.",
    install: "Would you like to install Iva — your personal AI assistant in Telegram?", yes: "Install Iva", no: "Not now",
    installNext: "Give the installation phrase to your Codex or Claude agent — it will install Iva.",
    installLater: "Okay, you can install Iva later.",
    copied: "Iva installation phrase copied.", copyDenied: "Copy the Iva installation phrase below:",
    copyPending: "Copying the Iva installation phrase…",
  },
} as const;
