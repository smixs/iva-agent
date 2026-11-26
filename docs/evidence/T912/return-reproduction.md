# T912 — воспроизведение возврата приёмки до и после правки

Проверено 26.11.2026 локально (`python3 -m http.server 8912 --directory docs/evidence/T912`, agent-browser). Живое превью после правки: https://t912.iva-menu-show.pages.dev/

## 1. Rich-режим: разметка кнопок показывалась текстом

Шаги: открыть `preview.html`, нажать `Rich`, прочитать `#sim-stage`.

До правки, коммит `306c154f`:

```json
{
  "buttonCount": 7,
  "buttons": [
    "<tg-button type=\"callback_data\" data=\"iva_menu:gm:o\">🧠 Модель",
    "💬 Общение",
    "<tg-button type=\"callback_data\" data=\"iva_menu:gmem:o\">💾 Память",
    "🔗 Подключения",
    "<tg-button type=\"callback_data\" data=\"iva_menu:gsch:o\">⏰ Расписание",
    "🛠 Система",
    "<tg-button type=\"callback_data\" style=\"danger\" data=\"iva_menu:r:x\">✖ Закрыть"
  ],
  "style": "Rich",
  "text": "⚙️ Настройки\n<tg-button type=\"callback_data\" data=\"iva_menu:gm:o\">🧠 Модель\n💬 Общение\n<tg-button type=\"callback_data\" data=\"iva_menu:gmem:o\">💾 Память\n🔗 Подключения\n<tg-button type=\"callback_data\" data=\"iva_menu:gsch:o\">⏰ Расписание\n🛠 Система\n<tg-button type=\"callback_data\" style=\"danger\" data=\"iva_menu:r:x\">✖ Закрыть"
}
```

После правки, тот же сценарий:

```json
{
  "buttonCount": 7,
  "buttons": [
    "🧠 Модель",
    "💬 Общение",
    "💾 Память",
    "🔗 Подключения",
    "⏰ Расписание",
    "🛠 Система",
    "✖ Закрыть"
  ],
  "markupVisible": false,
  "style": "active",
  "text": "⚙️ Настройки\n🧠 Модель\n💬 Общение\n💾 Память\n🔗 Подключения\n⏰ Расписание\n🛠 Система\n✖ Закрыть"
}
```

## 2. «Модель» и «Размышления» — ручные карточки вместо штатных экранов

Шаги: в Classic нажать `iva_menu:gm:o`, затем `iva_menu:mdl`, прочитать `#sim-stage`.

До правки, коммит `306c154f`:

```json
{
  "buttonCount": 2,
  "buttons": ["‹ Назад", "‹ Меню"],
  "crumb": "🧠 Выбор модели",
  "steps": [
    { "clicked": true, "step": "open-model-group" },
    { "clicked": true, "step": "open-model-wizard" }
  ],
  "text": "🧠 Модель\n\nПередаёт управление визарду /model в том же сообщении (провайдер, модель, ключ).\n\n‹ Назад\n‹ Меню"
}
```

После правки, тот же сценарий для «Модели»:

```json
{
  "afterGroup": "🧠 Модель\n🧠 Модель\n🤔 Размышления\n🔍 Поиск\n🔀 Новые сообщения\n‹ Меню",
  "crumb": "🧠 Выбор модели",
  "buttonCount": 3,
  "buttons": [
    { "cb": "iva_model:helper", "text": "Помощники: claude-sonnet-5-5" },
    { "cb": "iva_model:chg", "text": "Сменить" },
    { "cb": "iva_model:keep", "text": "Оставить" }
  ],
  "text": "🧠 Модель\n\nПровайдер — Модель — Размышления\nclaude — claude-fable-5-2 — medium\n\nПомощники: claude-sonnet-5-5\nСменить\nОставить",
  "markupVisible": false
}
```

Тот же сценарий после правки для «Размышлений» (`iva_menu:gm:o`, затем `iva_menu:thk`):

```json
{
  "crumb": "🤔 Размышления",
  "buttonCount": 7,
  "buttons": [
    { "cb": "iva_think:eff:low", "text": "low" },
    { "cb": "iva_think:eff:medium", "text": "medium" },
    { "cb": "iva_think:eff:high", "text": "high" },
    { "cb": "iva_think:eff:xhigh", "text": "xhigh" },
    { "cb": "iva_think:eff:max", "text": "max" },
    { "cb": "iva_think:eff:unset", "text": "Не задавать" },
    { "cb": "iva_think:keep", "text": "Оставить" }
  ],
  "text": "🤔 Размышления\n\nУровень размышлений для claude-fable-5-2: medium.\n\nlow\nmedium\nhigh\nxhigh\nmax\nНе задавать\nОставить",
  "markupVisible": false
}
```

## 3. Проверки после правки

```text
node --test scripts/menu-preview.test.ts scripts/poller/wizards.test.ts scripts/lib/menu/*.test.ts scripts/lib/telegram-buttons.test.ts
ℹ tests 197
ℹ pass 197
ℹ fail 0
exit=0

npm run typecheck
exit=0

npm run lint
exit=0
```

Снимки после правки: `docs/evidence/T912/preview-1440.png` (1440×4804) и `docs/evidence/T912/preview-390.png` (390×9814).
