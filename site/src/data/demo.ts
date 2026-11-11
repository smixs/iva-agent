// Transcript and event frames from V6 -> v5/Film5.tsx. Titles, logo and connection
// interstitials are omitted; Telegram content and the five default choices are retained.
// The next day goes on past the film: ads, stock, a payment, a contract, a post and the day's
// numbers, each asking before it acts. The morning adds a team brief, and in the meeting Helga
// writes: three ready answers, the way Iva offers them.
export type DemoLang = "ru" | "en";
export type ActionId = "helga" | "reminder" | "taxi" | "invoice" | "restaurant" | "shopping" | "order" | "ads" | "stock" | "payment" | "contract" | "post";
// A widget is a live card inside the message, the way Iva sends them with Bot API 10.4.
export type WidgetId = "day" | "weather" | "team" | "game" | "order" | "goal" | "ads" | "stock" | "summary";
export type DemoBlock = { kind: "title" | "p" | "item"; text: string; emoji?: string };
export type DemoMessage = {
  id: string; at: number; think?: number; time?: string;
  kind: "card" | "out" | "voice" | "date" | "venue" | "in";
  blocks?: DemoBlock[]; text?: string; action?: ActionId;
  doc?: [name: string, size: string]; photo?: string;
  // The card's widget, and the answer this message waits for: it only comes after that "yes".
  widget?: WidgetId; widgetAt?: number; when?: ActionId;
};
// The widget scenes are longer than the film's: frames inserted before these film frames.
// Every film frame number below stays the film's own and goes through T().
const inserts: [before: number, frames: number][] = [[540, 200], [2760, 660], [3950, 430]];
export const T = (film: number) => film + inserts.reduce((sum, [before, frames]) => film >= before ? sum + frames : sum, 0);
const NB = "\u00a0";
const p = (text: string): DemoBlock => ({ kind: "p", text });
const item = (emoji: string, text: string): DemoBlock => ({ kind: "item", emoji, text });
export const actionFrames: Record<ActionId, number> = {
  helga: T(1085), reminder: T(2200), taxi: T(2590), invoice: T(3090), restaurant: T(3350), shopping: T(3790),
  order: T(3950) - 160,
  ads: T(4520), stock: T(4800), payment: T(5100), contract: T(5480), post: T(5860),
};
// An answer that is only asked after another one was "yes".
export const actionNeeds: Partial<Record<ActionId, ActionId>> = { order: "shopping" };
// Moments inside the widget scenes, in the retimed frames.
export const widgetFrames = {
  weather: T(540) - 175, game: T(2760) - 560, strike: [T(3790) + 120, T(3790) + 180], order: T(3950) - 290,
};
export const demoCopy = {
  ru: {
    label: "Интерактивная демонстрация Ивы в Telegram",
    demo: "Демо", hint: "Демо: нажимайте кнопки в чате", cue: "нажми меня", viewed: "Просмотрено",
    note: "Все действия происходят внутри демонстрации.",
    play: "Продолжить", pause: "Пауза", replay: "Сначала", next: "Следующая сцена",
    end: "Демонстрация завершена", paused: "На паузе", playing: "Воспроизведение",
    today: "Сегодня", yesterday: "Вчера", iva: "Ива", maria: "Мария", helga: "Хельга", bot: "бот",
    online: "в сети", typing: "печатает", thinking: "Думаю…", message: "Сообщение",
    voice: "Голосовое сообщение, 12 секунд", photo: "Осенняя коллекция: пальто, свитер, шапка и ботинки",
    restaurant: "Ресторан «Олива»", address: "Садовая ул., 18",
    map: "Карта расположения ресторана «Олива»",
    scenes: ["Утро", "Погода", "Сводка по команде", "Хельга пишет", "Голосовое и CRM", "Кто писал", "Напоминание", "Такси в аэропорт", "Игра в дорогу", "Счёт Марку", "Ресторан для Марии", "Чат с Марией", "Покупки", "Заказ продуктов", "Задача про интернет", "Интернет починили", "Реклама в Meta", "Склад", "Платёжка", "Договор", "Пост", "Итоги дня"],
    choices: {
      helga: { yes: "Освобожусь через полчаса", no: "Я в курсе", open: "Открыть чат", accepted: "✅ Ответила Хельге: «Освобожусь через полчаса»", declined: "✅ Ответила Хельге: «Я в курсе»", opened: "Хорошо, ответишь Хельге сам." },
      reminder: { yes: "Напомнить", no: "Не надо", accepted: `✅ Напомню завтра в${NB}10:00`, declined: "Хорошо, напоминание пропускаю." },
      taxi: { yes: "Заказать", no: "Не надо", accepted: "✅ Такси заказала", declined: "Хорошо, такси пропускаю." },
      invoice: { yes: "Отправить", no: "Не сейчас", accepted: "✅ Отправила Марку", declined: "Хорошо, письмо остаётся черновиком." },
      restaurant: { yes: "Скинуть", no: "Не надо", accepted: "✅ Скинула Марии", declined: "Хорошо, ресторан оставляю здесь." },
      shopping: { yes: "Составить", no: "Не надо", accepted: "", declined: "Хорошо, список покупок пропускаю." },
      order: { yes: "Заказать", no: "Не сейчас", accepted: "✅ Заказала, привезут к 20:00", declined: "Хорошо, список остаётся у тебя." },
      ads: { yes: "Перенести", no: "Оставить", accepted: "✅ «Осень-2» на паузе, бюджет перешёл в «Осень-1»", declined: "Хорошо, кампании не трогаю." },
      stock: { yes: "Отправить", no: "Не сейчас", accepted: "✅ Заказ ушёл, поставка в четверг", declined: "Хорошо, заказ остаётся черновиком." },
      payment: { yes: "Отправить", no: "Не сейчас", accepted: "✅ Платёжка ушла в банк", declined: "Хорошо, платёжка ждёт в банке." },
      contract: { yes: "Отправить", no: "Не сейчас", accepted: "✅ Договор ушёл на подпись в Didox", declined: "Хорошо, договор остаётся черновиком." },
      post: { yes: "Опубликовать", no: "Не надо", accepted: `✅ Пост выйдет завтра в${NB}10:00`, declined: "Хорошо, пост остаётся в черновиках." },
    },
    shopping: [item("🥦", "Брокколи"), item("🐟", "Рыба"), item("🥚", "Яйца"), item("🍗", "Курица"), item("🥛", "Кефир")],
    mariaMessages: ["Завтра в силе?", "Да, в 19", "Куда ехать?"],
    helgaMessage: `Клиент приехал, ждёт в${NB}переговорке`,
  },
  en: {
    label: "Interactive Iva demo in Telegram",
    demo: "Demo", hint: "Demo: try the buttons in the chat", cue: "tap me", viewed: "Viewed",
    note: "Every action takes place inside this demo.",
    play: "Continue", pause: "Pause", replay: "Replay", next: "Next scene",
    end: "Demo complete", paused: "Paused", playing: "Playing",
    today: "Today", yesterday: "Yesterday", iva: "Iva", maria: "Maria", helga: "Helga", bot: "bot",
    online: "online", typing: "typing", thinking: "Thinking…", message: "Message",
    voice: "Voice message, 12 seconds", photo: "Autumn collection: a coat, a sweater, a beanie and boots",
    restaurant: "Oliva restaurant", address: "18 Sadovaya St.",
    map: "Map showing Oliva restaurant",
    scenes: ["Morning", "Weather", "Team brief", "Helga writes", "Voice note and CRM", "Who messaged", "Reminder", "Taxi to the airport", "A game for the ride", "Mark’s invoice", "Restaurant for Maria", "Chat with Maria", "Shopping", "Grocery order", "Fixing the internet", "Internet fixed", "Meta ads", "Stock", "Payment", "Contract", "Post", "Day in numbers"],
    choices: {
      helga: { yes: "Free in 30 minutes", no: "Got it", open: "Open chat", accepted: "✅ Replied to Helga: “Free in 30 minutes”", declined: "✅ Replied to Helga: “Got it”", opened: "Okay, you’ll reply to Helga yourself." },
      reminder: { yes: "Remind me", no: "No thanks", accepted: "✅ I’ll remind you tomorrow at 10:00", declined: "Okay, skipping the reminder." },
      taxi: { yes: "Book it", no: "No thanks", accepted: "✅ Taxi booked", declined: "Okay, skipping the taxi." },
      invoice: { yes: "Send", no: "Not now", accepted: "✅ Sent to Mark", declined: "Okay, the email stays a draft." },
      restaurant: { yes: "Share it", no: "No thanks", accepted: "✅ Shared with Maria", declined: "Okay, keeping the restaurant here." },
      shopping: { yes: "Make a list", no: "No thanks", accepted: "", declined: "Okay, skipping the shopping list." },
      order: { yes: "Order", no: "Not now", accepted: "✅ Ordered, arriving by 20:00", declined: "Okay, the list stays with you." },
      ads: { yes: "Move it", no: "Leave it", accepted: "✅ “Autumn 2” is paused, its budget went to “Autumn 1”", declined: "Okay, leaving the campaigns alone." },
      stock: { yes: "Send", no: "Not now", accepted: "✅ Order sent, delivery on Thursday", declined: "Okay, the order stays a draft." },
      payment: { yes: "Send", no: "Not now", accepted: "✅ The payment order went to the bank", declined: "Okay, the payment order waits in the bank." },
      contract: { yes: "Send", no: "Not now", accepted: "✅ Sent for signing in Didox", declined: "Okay, the contract stays a draft." },
      post: { yes: "Publish", no: "No thanks", accepted: "✅ The post goes out tomorrow at 10:00", declined: "Okay, the post stays in drafts." },
    },
    shopping: [item("🥦", "Broccoli"), item("🐟", "Fish"), item("🥚", "Eggs"), item("🍗", "Chicken"), item("🥛", "Kefir")],
    mariaMessages: ["Still on for tomorrow?", "Yes, at 7", "Where should I go?"],
    helgaMessage: "The client is here, waiting in the meeting room.",
  },
} as const;

export function demoMessages(lang: DemoLang): DemoMessage[] {
  const ru = lang === "ru";
  const t = (r: string, e: string) => ru ? r : e;
  return [
    { id: "morning", at: T(300), think: T(250), kind: "card", time: "9:41", widget: "day", blocks: [
      { kind: "title", text: t("☀️ Доброе утро!", "☀️ Good morning!") },
      p(t(`Я твоя Ива. Вот твой день:`, "I’m your Iva. Here’s your day:")),
    ] },
    { id: "weather", at: widgetFrames.weather, think: widgetFrames.weather - 45, kind: "card", time: "9:41", widget: "weather" },
    { id: "team", at: T(595), think: T(540), kind: "card", time: "9:42", widget: "team", blocks: [
      { kind: "title", text: t("📋 Сводка по команде", "📋 Team brief") },
    ] },
    { id: "helga", at: T(970), think: T(915), kind: "card", action: "helga", time: "11:25", blocks: [
      p(t(`💬 Хельга пишет: «Клиент приехал, ждёт в${NB}переговорке». По${NB}расписанию у${NB}тебя встреча с${NB}Марком до${NB}12:00. Что ей ответить?`, "💬 Helga writes: “The client is here, waiting in the meeting room.” Your calendar has you with Mark until 12:00. What should I reply?")),
    ] },
    { id: "voice", at: T(1240), kind: "voice", time: "12:04" },
    { id: "crm", at: T(1380), think: T(1290), kind: "card", time: "12:04", blocks: [
      p(t(`✅ Принято. Итоги встречи записала в${NB}Bitrix24. Во${NB}вторник напомню позвонить Нику.`, "✅ Got it. I’ve saved the meeting notes in Bitrix24. I’ll remind you to call Nick on Tuesday.")),
    ] },
    { id: "who-ask", at: T(1530), kind: "out", time: "12:10", text: t("Что мне сегодня писали?", "What did people message me today?") },
    { id: "who", at: T(1630), think: T(1570), kind: "card", time: "12:10", blocks: [
      p(t("Тебе писали трое:", "Three people messaged you:")),
      item("💬", t(`Алекс про${NB}договор`, "Alex about the contract")),
      item("🍽", t(`Мария про${NB}ужин`, "Maria about dinner")),
      item("💵", t("Марк ждёт счёт", "Mark is waiting for the invoice")),
    ] },
    { id: "reminder", at: T(2060), think: T(2010), kind: "card", action: "reminder", time: "13:00", blocks: [
      p(t(`🗂 В${NB}Bitrix24 обновились 3${NB}карточки клиентов. Напомнить завтра?`, "🗂 Three client cards changed in Bitrix24. Remind you tomorrow?")),
    ] },
    { id: "flight-ask", at: T(2330), kind: "out", time: "15:20", text: t("Во сколько Анна прилетает?", "What time does Anna arrive?") },
    { id: "taxi", at: T(2420), think: T(2370), kind: "card", action: "taxi", time: "15:20", blocks: [
      p(t(`✈️ Нашла её билеты. Прилетает в${NB}16:10, ехать 35${NB}минут. Заказать такси в${NB}аэропорт?`, "✈️ I found her tickets. She lands at 16:10, and it’s a 35-minute drive. Book a taxi to the airport?")),
    ] },
    { id: "game", at: widgetFrames.game, think: widgetFrames.game - 50, kind: "card", when: "taxi", time: "15:24", widget: "game", blocks: [
      p(t(`🎮 Ехать ещё полчаса. Держи игру в${NB}дорогу: вырасти иву.`, "🎮 Half an hour to go. Here’s a game for the ride: grow a willow.")),
    ] },
    { id: "invoice", at: T(2950), think: T(2910), kind: "card", action: "invoice", time: "16:05", doc: [t("Счёт №14.pdf", "Invoice №14.pdf"), "84 KB"], blocks: [
      p(t(`✉️ Марк ждёт счёт на${NB}$4${NB}800. Письмо готово. Отправить?`, "✉️ Mark is waiting for the $4,800 invoice. The email is ready. Send it?")),
    ] },
    { id: "restaurant", at: T(3220), think: T(3180), kind: "card", action: "restaurant", time: "17:41", blocks: [
      p(t("📍 Мария спрашивает, куда ехать. Скинуть ей ресторан?", "📍 Maria asks where to go. Share the restaurant with her?")),
    ] },
    { id: "shopping", at: T(3640), think: T(3600), kind: "card", action: "shopping", time: "18:30", blocks: [
      p(t(`🥗 На${NB}прошлой неделе ты просил помочь снизить вес. Составить список покупок на${NB}неделю?`, "🥗 Last week you asked for help losing weight. Make a shopping list for the week?")),
    ] },
    { id: "order", at: widgetFrames.order, think: widgetFrames.order - 50, kind: "card", action: "order", when: "shopping", time: "18:34", widget: "order", widgetAt: 0, blocks: [
      p(t(`🛒 Остальное привезут к${NB}20:00. Заказать?`, "🛒 The rest can arrive by 20:00. Order it?")),
    ] },
    { id: "goal-ask", at: T(3950), kind: "out", time: "19:04", text: t("Интернет не работает третий день. Добейся, чтобы починили", "The internet has been down for three days. Make sure they fix it") },
    { id: "goal", at: T(4050), think: T(3990), kind: "card", time: "19:05", widget: "goal", blocks: [
      p(t(`Взялась. Буду добиваться, пока не${NB}починят:`, "On it. I’ll keep pushing until it’s fixed:")),
    ] },
    { id: "next-day", at: T(4220), kind: "date", text: t("Сегодня", "Today") },
    { id: "done", at: T(4226), kind: "card", time: "14:31", blocks: [
      p(t(`✅ Интернет починили. Мастер был в${NB}14:00.`, "✅ The internet is fixed. The technician came at 14:00.")),
    ] },
    { id: "ads", at: T(4380), think: T(4330), kind: "card", action: "ads", time: "15:10", widget: "ads", widgetAt: 0, blocks: [
      p(t(`📉 «Осень-2» тратит бюджет без${NB}заявок. Перенести его на${NB}«Осень-1»?`, "📉 “Autumn 2” spends with no leads. Move its budget to “Autumn 1”?")),
    ] },
    { id: "stock", at: T(4660), think: T(4620), kind: "card", action: "stock", time: "16:02", widget: "stock", widgetAt: 0, blocks: [
      p(t(`📦 В${NB}МойСклад заканчиваются белые футболки${NB}M. Заказ поставщику готов. Отправить?`, "📦 White T-shirts in size M are running low in MoySklad. The supplier order is ready. Send it?")),
    ] },
    { id: "payment", at: T(4950), think: T(4910), kind: "card", action: "payment", time: "16:40", doc: [t("Счёт №218.pdf", "Invoice №218.pdf"), "96 KB"], blocks: [
      p(t(`🧾 Пришёл счёт от${NB}«Текстиль Плюс» на${NB}$2${NB}400. Сверила с${NB}договором, суммы сходятся. Платёжка в${NB}банке готова. Отправить?`, "🧾 Textile Plus sent a $2,400 invoice. I checked it against the contract and the amounts match. The payment order is ready in the bank. Send it?")),
    ] },
    { id: "contract-ask", at: T(5220), kind: "out", time: "17:15", text: t(`Подготовь договор поставки с${NB}Дилшодом, как в${NB}прошлый раз`, "Prepare a supply contract with Dilshod, like last time") },
    { id: "contract", at: T(5320), think: T(5260), kind: "card", action: "contract", time: "17:16", doc: [t("Договор №37.pdf", "Contract №37.pdf"), "128 KB"], blocks: [
      p(t(`📄 Договор готов по${NB}вашему шаблону: 300${NB}футболок, оплата 50/50, поставка до${NB}20${NB}ноября. Отправить Дилшоду на${NB}подпись в${NB}Didox?`, "📄 The contract is ready from your template: 300 T-shirts, 50/50 payment, delivery by 20 November. Send it to Dilshod to sign in Didox?")),
    ] },
    { id: "post-ask", at: T(5600), kind: "out", time: "18:20", text: t(`Сделай пост про осеннюю коллекцию для${NB}Instagram и${NB}канала`, "Make a post about the autumn collection for Instagram and the channel") },
    { id: "post", at: T(5710), think: T(5640), kind: "card", action: "post", time: "18:22", photo: "/media/demo/autumn-post", blocks: [
      p(t(`🎨 Картинку сделала в${NB}Nano${NB}Banana, текст написала. Опубликовать завтра в${NB}10:00?`, "🎨 I made the picture in Nano Banana and wrote the text. Publish tomorrow at 10:00?")),
    ] },
    { id: "summary", at: T(6000), think: T(5950), kind: "card", time: "20:00", widget: "summary", widgetAt: 1, blocks: [
      { kind: "title", text: t("📊 Итоги дня", "📊 Your day in numbers") },
      p(t(`Отчёт в${NB}Google Таблице. Такой буду присылать каждый вечер.`, "The report is in Google Sheets. I’ll send one every evening.")),
    ] },
  ];
}

// Bounded demo catalog, taken from scripts/lib/model-catalog.ts (CATALOG) and
// scripts/poller/wizards.ts. The real installation loads the live provider catalog.
export const demoProviders = {
  codex: { ru: "OpenAI (подписка)", en: "OpenAI (subscription)", models: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"] },
  claude: { ru: "Claude (подписка Pro/Max)", en: "Claude (Pro/Max subscription)", models: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
  opencode: { ru: "OpenCode Go", en: "OpenCode Go", models: ["deepseek-v4-pro", "kimi-k3", "glm-5.2", "qwen3.7-max"] },
  ollama: { ru: "Ollama Cloud", en: "Ollama Cloud", models: ["deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2"] },
  // Any OpenAI-compatible endpoint (custom in the catalog): its models come from the address the
  // owner sends, so the demo has none to offer and says how it works instead.
  custom: { ru: "Свой провайдер", en: "Your own provider", models: [] },
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
    now: "Сейчас", provider: "Выбери провайдера:", chooseModel: "Выбери модель:", customModels: "Пришли адрес своего OpenAI-совместимого сервиса, и Ива сама подтянет его модели.",
    restart: "Применить и перезапустить?", restartButton: "Перезапустить",
    restartNote: "В демо показан перезапуск. Реальный сервер остаётся без изменений.",
    restarted: "✅ Перезапуск показан в демо. Модель выбрана.",
    closed: "Настройки закрыты", writes: "Сама пишет", on: "включено", off: "выключено",
    notices: "Присмотр за пропущенным и обзор дня в 08:30 и 14:00. О сбоях Ива пишет всегда.",
    language: "🌐 Язык интерфейса", languageNote: "Язык меню меняется сразу. Переписка выше записана для демонстрации.",
    install: "Хотите установить Иву, личного AI-помощника в Telegram?", yes: "Установить Иву", no: "Не сейчас",
    installNext: "Передайте фразу своему агенту Codex или Claude, и он установит Иву.",
    installLater: "Хорошо, установить Иву можно позже.",
    copied: "Фраза для установки Ивы скопирована.", copyDenied: "Скопируйте фразу для установки Ивы:",
    copyPending: "Копирую фразу для установки Ивы…",
  },
  en: {
    installIva: "Install Iva", open: "Open Iva’s menu", settings: "⚙️ Settings", close: "✖ Close", back: "‹ Menu",
    demo: "Demo settings: changes apply only here.",
    preview: "This is a screen preview. Connections and commands are available in your own Iva.",
    now: "Now", provider: "Pick a provider:", chooseModel: "Pick a model:", customModels: "Send the address of your OpenAI-compatible service and Iva will pull its models herself.",
    restart: "Apply and restart?", restartButton: "Restart",
    restartNote: "This demo shows the restart. No real server is changed.",
    restarted: "✅ Restart shown in the demo. Model selected.",
    closed: "Settings closed", writes: "Writes on her own", on: "on", off: "off",
    notices: "Watch for missed items and a daily brief at 08:30 and 14:00. Iva always reports failures.",
    language: "🌐 Interface language", languageNote: "The menu language changes immediately. The chat above is a recorded demonstration.",
    install: "Would you like to install Iva, your personal AI assistant in Telegram?", yes: "Install Iva", no: "Not now",
    installNext: "Give the installation phrase to your Codex or Claude agent and it will install Iva.",
    installLater: "Okay, you can install Iva later.",
    copied: "Iva installation phrase copied.", copyDenied: "Copy the Iva installation phrase below:",
    copyPending: "Copying the Iva installation phrase…",
  },
} as const;
