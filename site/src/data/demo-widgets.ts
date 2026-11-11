// What the widgets in the demonstration show. Iva draws such cards herself, inside the message
// (agent/skills/widgets/SKILL.md): a calendar, the weather, a status list, a countdown, a chart,
// a checklist. The numbers repeat the film's story; nothing here is read from a real account.
import type { DemoLang } from "./demo.ts";

const NB = " ";
export type TeamState = "late" | "stuck" | "yours" | "work";
// The taxi's way on the map (viewBox 318x150): to the pickup point, then to the airport.
export const routePaths = {
  approach: [[18, 34], [40, 34], [40, 78], [104, 78], [104, 122]],
  trip: [[104, 122], [168, 122], [168, 78], [232, 78], [232, 34], [286, 34]],
} as const;
// What the film ticks off as already at home: eggs and kefir.
export const listStruck = [2, 4] as const;

export function widgetCopy(lang: DemoLang) {
  const ru = lang === "ru";
  const t = (r: string, e: string) => ru ? r : e;
  return {
    day: {
      tabs: [t("Сегодня", "Today"), t("Неделя", "Week")],
      now: t("сейчас", "now"),
      events: [
        { time: "11:00", title: t("Встреча с Марком", "Meeting with Mark"), note: t(`до${NB}12:00, переговорка`, `until 12:00, meeting room`) },
        { time: "14:00", title: t("Подписать договор Алекса", "Sign Alex’s contract"), note: "DocuSign" },
        { time: "19:00", title: t("Ужин с Марией", "Dinner with Maria"), note: t("у неё день рождения", "it’s her birthday") },
      ],
      // Monday to Sunday; the film's day is a Tuesday.
      week: [
        { day: t("Пн", "Mo"), date: 9, count: 2 }, { day: t("Вт", "Tu"), date: 10, count: 3, today: true },
        { day: t("Ср", "We"), date: 11, count: 1 }, { day: t("Чт", "Th"), date: 12, count: 2 },
        { day: t("Пт", "Fr"), date: 13, count: 0 }, { day: t("Сб", "Sa"), date: 14, count: 1 },
        { day: t("Вс", "Su"), date: 15, count: 0 },
      ],
      ahead: [
        { when: t("Ср", "Wed"), title: t("Отчёт по рекламе", "The ads report") },
        { when: t("Чт", "Thu"), title: t("Стоматолог, 11:30", "Dentist, 11:30") },
        { when: t("Сб", "Sat"), title: t("Ужин с родителями", "Dinner with parents") },
      ],
    },
    weather: {
      city: t("Ташкент", "Tashkent"), temp: "+18°", note: t("Облачно, к вечеру дождь", "Cloudy, rain by evening"),
      range: t("днём до +21°, ночью +11°", "high +21°, low +11°"),
      hours: [
        { at: t("сейчас", "now"), temp: 18, sky: "cloud" }, { at: "12", temp: 20, sky: "sun" }, { at: "15", temp: 21, sky: "sun" },
        { at: "18", temp: 17, sky: "rain" }, { at: "21", temp: 14, sky: "rain" }, { at: "00", temp: 12, sky: "moon" }, { at: "03", temp: 11, sky: "moon" },
      ],
      tiles: [
        { label: t("Дождь", "Rain"), value: "60%", note: t(`с${NB}18:00`, "from 18:00") },
        { label: t("Ветер", "Wind"), value: t(`4${NB}м/с`, `9${NB}mph`), note: t("северный", "from the north") },
        { label: t("Закат", "Sunset"), value: "17:12", note: t(`через 7${NB}ч`, `in 7${NB}h`) },
      ],
      advice: t("Возьми зонт на вечер", "Take an umbrella for the evening"),
    },
    team: {
      source: t(`Bitrix24 и${NB}чаты команды, 5${NB}задач`, `Bitrix24 and the team chats, 5${NB}tasks`),
      states: { late: t("просрочено", "overdue"), stuck: t(`ждёт 3${NB}дня`, `stuck 3${NB}days`), yours: t("ждёт тебя", "needs you"), work: t("в работе", "in progress") } as Record<TeamState, string>,
      rows: [
        { state: "late", title: t("Смета для «Альфы»", "The Alfa estimate"), who: t("не успели вчера", "not done yesterday") },
        { state: "stuck", title: t("Доступ к рекламе", "Access to the ads"), who: t("Лео", "Leo") },
        { state: "yours", title: t("Бюджет на ноябрь", "The November budget"), who: t("нужно твоё решение", "your call") },
        { state: "work", title: t("Лендинг", "Landing page"), who: t("Ева", "Eva") },
        { state: "work", title: t("Отчёт", "Report"), who: t("Макс", "Max") },
      ] as { state: TeamState; title: string; who: string }[],
    },
    route: {
      label: t("Маршрут до аэропорта", "The route to the airport"),
      from: t("Офис", "Office"), to: t("Аэропорт", "Airport"),
      wait: t("Подача через", "Pickup in"), ride: t("В пути, до аэропорта", "On the way, airport in"), min: t("мин", "min"),
      done: t("Поездка завершена", "Trip finished"), doneNote: t(`в${NB}аэропорту в${NB}16:02`, `at the airport at 16:02`),
      car: t("Белый седан", "White sedan"), plate: "01 A 777 BA",
    },
    game: {
      label: t("Игра: вырасти иву. Нажми, когда капля над ростком.", "Game: grow a willow. Tap when the drop is over the sprout."),
      score: t("Рост", "Height"), hint: t("Нажми, когда капля над ивой", "Tap when the drop is over the willow"),
    },
    list: {
      hint: t("Отметь, что уже есть дома", "Tick what you already have at home"),
      left: t("Осталось купить", "Left to buy"), have: t("уже есть", "have it"),
      prices: [4, 9, 2, 5, 2],
    },
    order: {
      photo: t("Бумажный пакет с продуктами: брокколи, рыба и курица", "A paper bag of groceries: broccoli, fish and chicken"),
      shop: t(`Доставка к${NB}20:00`, `Delivery by 20:00`), total: t("Итого", "Total"),
      cart: t("В корзине", "In the basket"), paying: t("Оформляю…", "Placing the order…"), paid: t("Оплачено", "Paid"),
      number: t("заказ №318", "order no. 318"),
    },
    goal: {
      steps: [
        { state: "done", title: t("Нашла почту провайдера", "Found the provider’s email"), note: "19:04" },
        { state: "done", title: t("Написала в поддержку", "Wrote to support"), note: "19:05" },
        { state: "now", title: t("Жду ответа", "Waiting for a reply"), note: t(`проверю завтра в${NB}10:00`, `I’ll check tomorrow at 10:00`) },
        { state: "wait", title: t("Напишу директору", "Write to the director"), note: t("если не ответят", "if they stay silent") },
      ] as { state: "done" | "now" | "wait"; title: string; note: string }[],
    },
    ads: {
      source: t(`Meta Ads за${NB}неделю`, `Meta Ads, this week`),
      rows: [
        { name: t("«Осень-1»", "“Autumn 1”"), spend: 42, leads: 14, result: t(`14${NB}заявок`, `14${NB}leads`), note: t(`$42, по${NB}$3 за${NB}заявку`, `$42, $3 per lead`) },
        { name: t("«Осень-2»", "“Autumn 2”"), spend: 40, leads: 0, result: t(`0${NB}заявок`, `0${NB}leads`), note: t(`$40 потрачено`, `$40 spent`) },
      ],
    },
    stock: {
      name: t(`Белые футболки${NB}M`, `White T-shirts,${NB}M`), left: t(`12${NB}шт`, `12${NB}left`),
      note: t(`хватит на${NB}3${NB}дня`, `enough for 3${NB}days`), of: t(`из${NB}60`, `of${NB}60`), share: 0.2,
    },
    summary: {
      tabs: [t("Неделя", "Week"), t("Месяц", "Month")],
      revenue: 5200, label: t("Выручка сегодня", "Revenue today"), delta: "+12%", deltaNote: t("к прошлой среде", "vs last Wednesday"),
      week: [
        { label: t("Ср", "We"), value: 4640 }, { label: t("Чт", "Th"), value: 4100 }, { label: t("Пт", "Fr"), value: 4900 }, { label: t("Сб", "Sa"), value: 3600 },
        { label: t("Вс", "Su"), value: 2800 }, { label: t("Пн", "Mo"), value: 4300 }, { label: t("Вт", "Tu"), value: 4700 }, { label: t("Ср", "We"), value: 5200 },
      ],
      month: [
        { label: t("1–7", "1–7"), value: 27400 }, { label: t("8–14", "8–14"), value: 29100 }, { label: t("15–21", "15–21"), value: 30800 }, { label: t("22–28", "22–28"), value: 33900 },
      ],
      monthTotal: t(`$121${NB}200 за${NB}четыре недели`, `$121,200 in four weeks`),
      facts: [
        { value: "7", label: t(`заявок в${NB}amoCRM`, `leads in amoCRM`) },
        { value: "+3", label: t(`места в${NB}Яндексе`, `places in search`) },
        { value: "9", label: t(`задач закрыто`, `tasks closed`) },
      ],
    },
  };
}
export type WidgetCopy = ReturnType<typeof widgetCopy>;
