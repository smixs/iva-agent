---
name: Iva website
description: Manrope, pale green paper and Iva's native Telegram demonstration.
colors:
  canvas: "#fbfcf8"
  ink: "#17251f"
  muted: "#536258"
  panel: "#f0f3eb"
  line: "#dce2d6"
  leaf: "#a4dc55"
  leaf-hover: "#b0e46b"
  leaf-pressed: "#95ce48"
  leaf-tint: "#e8f2db"
  blue: "#368ad2"
  link: "#2468a8"
  white: "#ffffff"
  telegram-ink: "#17211d"
  telegram-blue: "#0589ff"
  telegram-blue-hover: "#0473d6"
  telegram-outgoing: "#e1fec7"
  telegram-secondary: "#e7e6e9"
  telegram-secondary-hover: "#d5d4d8"
  telegram-keyboard: "#e4f3ff"
  telegram-keyboard-ink: "#075a9c"
  telegram-selected: "#c9e5ff"
  telegram-note: "#395549"
typography:
  display:
    fontFamily: '"Manrope", "Avenir Next", sans-serif'
    fontSize: "clamp(52px, 4.75vw, 68px)"
    fontWeight: 650
    lineHeight: 1.07
    letterSpacing: "-0.04em"
  headline:
    fontFamily: '"Manrope", "Avenir Next", sans-serif'
    fontSize: "clamp(38px, 3.4vw, 46px)"
    fontWeight: 650
    lineHeight: 1.12
    letterSpacing: "-0.035em"
  title:
    fontFamily: '"Manrope", "Avenir Next", sans-serif'
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  body:
    fontFamily: '"Manrope", "Avenir Next", sans-serif'
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.55
  supporting:
    fontFamily: '"Manrope", "Avenir Next", sans-serif'
    fontSize: "20px"
    fontWeight: 400
    lineHeight: 1.55
  hero-lead:
    fontFamily: '"Manrope", "Avenir Next", sans-serif'
    fontSize: "22px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.012em"
  label:
    fontFamily: '"Manrope", "Avenir Next", sans-serif'
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.35
  compact-label:
    fontFamily: '"Manrope", "Avenir Next", sans-serif'
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.35
  navigation:
    fontFamily: '"Manrope", "Avenir Next", sans-serif'
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.55
  review:
    fontFamily: '"Manrope", "Avenir Next", sans-serif'
    fontSize: "22px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "-0.018em"
  telegram-body:
    fontFamily: '"V7IvaUI", "Apple Color Emoji", sans-serif'
    fontSize: "max(14px, calc(17 * var(--vp)))"
    fontWeight: 400
    lineHeight: "max(18.5px, calc(22.5 * var(--vp)))"
    letterSpacing: "calc(-0.15 * var(--vp))"
  telegram-choice:
    fontFamily: '"V7IvaUI", "Apple Color Emoji", sans-serif'
    fontSize: "max(12px, calc(16.5 * var(--vp)))"
    fontWeight: 600
    lineHeight: "max(18.5px, calc(22.5 * var(--vp)))"
    letterSpacing: "calc(-0.2 * var(--vp))"
  telegram-menu-keyboard:
    fontFamily: '"V7IvaUI", "Apple Color Emoji", sans-serif'
    fontSize: "max(13px, calc(15 * var(--vp)))"
    fontWeight: 600
    lineHeight: 1.2
  telegram-menu-keyboard-root:
    fontFamily: '"V7IvaUI", "Apple Color Emoji", sans-serif'
    fontSize: "max(12px, calc(15 * var(--vp)))"
    fontWeight: 600
    lineHeight: 1.2
  telegram-title:
    fontFamily: '"V7IvaSerif", "Apple Color Emoji", serif'
    fontSize: "calc(26 * var(--vp))"
    fontWeight: 400
    lineHeight: "calc(31 * var(--vp))"
    letterSpacing: "calc(-0.2 * var(--vp))"
rounded:
  button: "10px"
  mobile-control: "8px"
  consent: "6px"
  telegram-card: "calc(18 * var(--vp))"
  telegram-choice: "calc(19 * var(--vp))"
  telegram-keyboard: "calc(12 * var(--vp))"
  telegram-phrase: "calc(8 * var(--vp))"
  circle: "50%"
spacing:
  tight: "8px"
  label: "12px"
  grouped: "16px"
  copy: "24px"
  gutter: "48px"
  columns: "64px"
  story-row: "84px"
  section: "96px"
components:
  button-primary:
    backgroundColor: "{colors.leaf}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.button}"
    padding: "16px 26px"
  button-primary-hover:
    backgroundColor: "{colors.leaf-hover}"
  button-primary-active:
    backgroundColor: "{colors.leaf-pressed}"
  button-small:
    backgroundColor: "{colors.leaf}"
    textColor: "{colors.ink}"
    typography: "{typography.compact-label}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.link}"
    typography: "{typography.label}"
    rounded: "0"
    padding: "0"
  navigation:
    textColor: "{colors.ink}"
    typography: "{typography.navigation}"
  review:
    textColor: "{colors.ink}"
    typography: "{typography.review}"
  faq:
    textColor: "{colors.ink}"
    padding: "17px 0"
  telegram-card:
    backgroundColor: "{colors.white}"
    textColor: "{colors.telegram-ink}"
    typography: "{typography.telegram-body}"
    rounded: "{rounded.telegram-card}"
    padding: "calc(12 * var(--vp)) calc(15 * var(--vp)) calc(7 * var(--vp))"
  telegram-choice-primary:
    backgroundColor: "{colors.telegram-blue}"
    textColor: "{colors.white}"
    typography: "{typography.telegram-choice}"
    rounded: "{rounded.telegram-choice}"
    padding: "0 calc(5 * var(--vp))"
    height: "max(32px, calc(38 * var(--vp)))"
  telegram-choice-secondary:
    backgroundColor: "{colors.telegram-secondary}"
    textColor: "{colors.telegram-ink}"
    typography: "{typography.telegram-choice}"
    rounded: "{rounded.telegram-choice}"
    padding: "0 calc(5 * var(--vp))"
    height: "max(32px, calc(38 * var(--vp)))"
  telegram-menu-toggle:
    backgroundColor: "{colors.telegram-blue}"
    textColor: "{colors.white}"
    rounded: "{rounded.circle}"
    size: "calc(36 * var(--vp))"
    padding: "0"
  telegram-menu-keyboard:
    backgroundColor: "{colors.telegram-keyboard}"
    textColor: "{colors.telegram-keyboard-ink}"
    typography: "{typography.telegram-menu-keyboard}"
    rounded: "{rounded.telegram-keyboard}"
    padding: "calc(7 * var(--vp)) calc(5 * var(--vp))"
  telegram-menu-keyboard-root:
    typography: "{typography.telegram-menu-keyboard-root}"
  telegram-menu-selected:
    backgroundColor: "{colors.telegram-selected}"
  telegram-menu-install:
    backgroundColor: "{colors.leaf}"
    textColor: "{colors.telegram-ink}"
    rounded: "{rounded.telegram-keyboard}"
    padding: "calc(8 * var(--vp))"
---

# Design System: Iva website

## Overview

**Creative North Star: "Iva in Telegram"**

Сайт сочетает тёплую светлую основу, тёмный Manrope и исходную двухлистную марку Ивы. Крупный предметный текст, свободные поля и фотографии людей дают ритм странице; фронтальный телефон показывает подготовленный разговор и результат поручений. Это описание текущей реализации `site/src`, а композиция главной относится к этой поверхности.

Нативный V6 — источник геометрии телефона, обоев, сообщений, шрифтов чата и движения сцен. Семейство сайта и семейства внутри телефона загружаются локально и сохраняют отдельные области применения. Документация использует ту же палитру и Manrope в собственной полосе чтения.

**Key Characteristics:**

- Тёплый светлый фон, тёмные зелёные чернила и зелёное основное действие.
- Самостоятельный Manrope на сайте и Inter / Source Serif 4 внутри телефона.
- Крупные фотографии с конкретным пояснением и свободным полем вокруг.
- Внешняя подсказка демо, видимый фокус и ручной проход сцен при reduced motion.

## Colors

Значения frontmatter извлечены из `src/styles/global.css`, `HeroChat.astro` и `Phone.astro`; они задают используемые цвета. Тональные полосы sidecar синтезированы для панели каталога и служат просмотром семейства цвета.

### Primary

- **Leaf** — основная кнопка сайта и отдельное действие установки в меню телефона; hover и pressed взяты из CSS кнопки сайта.
- **Leaf tint** — фон полноширинной полосы установки.

### Secondary

- **Blue** — малый лист логотипа, общий фокус, индикаторы FAQ и системные акценты страницы.
- **Link** — текстовые ссылки и вторичное действие.

### Neutral

- **Canvas** — тёплый светлый фон сайта.
- **Ink** — заголовки, основной текст, навигация и текст основной кнопки.
- **Muted** — пояснения, условия, ответы FAQ и подписи.
- **Panel** — мобильная навигация, её переключатель и блоки кода документации.
- **Line** — границы FAQ, согласия на аналитику и таблиц документации.
- **White** — входящие сообщения и небольшие служебные поверхности.

Telegram имеет собственные ink, action blue, outgoing green, серую вторичную кнопку и голубую клавиатуру настроек. Selected оттенок отмечает текущую модель и другие выбранные настройки. Цвета корпуса и стекла остаются локальными материалами `Phone.astro` и `HeroChat.astro`.

**The Native Boundary Rule.** Нативные градиенты, стекло и цвета сообщений принадлежат телефону; сайт сохраняет свою спокойную плоскую поверхность.

## Typography

**Display Font / Body Font:** локальный variable Manrope (весовой диапазон 200–800), затем Avenir Next и sans-serif. Latin и Cyrillic поставляются отдельными WOFF2 с `font-display: swap`. Логотип — готовый SVG, его надпись сохраняет исходные очертания.

**Telegram Font:** локальный Inter под именем `V7IvaUI` для интерфейса и Source Serif 4 под именем `V7IvaSerif` для заголовков карточек. Единица `--vp` масштабируется вместе с телефоном.

### Hierarchy

- **Display** — H1 главной: вес 650, плотный интерлиньяж и трекинг из frontmatter; каждая заданная строка выведена отдельным span.
- **Headline** — H2 разделов; конкретные ситуации используют близкий интерлиньяж (1.13).
- **Title** — H3 общей типографики.
- **Body / Supporting** — обычная полоса чтения и более крупные пояснения главной соответственно. Hero lead имеет собственную роль. Ширина пояснений обычно ограничена 35–48ch; intro — 42ch на desktop.
- **Label / Navigation** — плотные, читаемые действия и компактные ссылки. Регистровая сетка сохраняет обычное написание слов.
- **Review** — крупная короткая цитата; имя и ссылка источника образуют отдельную подпись меньшего размера.
- **Telegram body / title** — типографика подготовленного V6, связанная с размерами корпуса. Body имеет нижний предел 14px и интерлиньяж 18.5px при любой ширине; названия документа и места и состояние «Думаю…» сохраняют такой же предел читаемости. Кнопки выбора имеют минимум 12px, кнопки вложенного меню — 13px, корневого — 12px; эти правила заданы в базовом CSS.

На ширинах до 960px H1 имеет размер 48px, H2 — 38px. До 600px H1 меняется на `clamp(30px, 8.5vw, 36px)` с интерлиньяжем 1.1, H2 — 32px; заголовки ситуаций — 30px, пояснения — 17px. Документация имеет свои H1/H2/H3 (48/32/24px на desktop; 38/29px для H1/H2 до 600px).

**The Concrete Heading Rule.** Заголовок называет предмет или действие и завершается словом; утверждённый H1 — «Личный AI помощник в телеграм».

## Layout

Общий контейнер секций ограничен 1280px, header — 1376px. Базовые боковые поля — 48px; на промежуточной desktop-ширине 961–1150px — 36px, до 960px — 28px, до 600px — 22px. Базовый вертикальный шаг секции — 96px; до 960px — 76px, до 600px — 56px. Каждая содержательная секция уточняет свои отступы в CSS.

Hero на desktop состоит из текста слева и телефона справа с промежутком 88px (56px при 961–1150px). Ширина телефона — `clamp(280px, calc((100svh - 176px) * 434 / 890), 388px)`. До 960px порядок меняется на заголовок, телефон, пояснение с установкой; ширина равна `min(388px, calc(100vw - 44px))`. До 600px максимум составляет 360px: `min(360px, calc(100vw - 44px))`, что даёт 276px при viewport 320px и 346px при 390px. На этих ширинах размер определяется viewport по горизонтали; полный корпус остаётся частью демо при смене сцен.

После hero идут четыре конкретные ситуации: каждая сразу начинает собственный H2. Desktop чередует фото и текст в двух колонках с промежутком 64px и расстоянием между строками 84px. До 760px порядок каждой ситуации — заголовок, пояснение, фото; расстояние между ситуациями — 48px. Изображения имеют формат 4:3, `object-fit: contain`, responsive AVIF/WebP и ленивую загрузку.

Три отзыва образуют desktop-сетку из трёх равных колонок с промежутком 40px. До 760px используется нативная горизонтальная прокрутка: колонка `minmax(244px, 84%)`, промежуток 26px и `scroll-snap-align: start`; край следующей цитаты остаётся видимым. Заголовок раздела выражен доступным `aria-label`.

Подключения имеют восемь равных колонок логотипов на desktop и четыре до 960px. Настройки и владение данными построены редакционными строками: заголовок слева, пояснения или пары термин/факт справа; до 760px они переходят в одну колонку. Установка лежит в полноширинной leaf-tint полосе, а её содержимое сохраняет общий контейнер. FAQ — одна закрытая группа с шестью закрытыми вопросами.

## Elevation & Depth

Обычные разделы сайта используют пространство, тон и тонкие границы. Глубина сосредоточена в материале телефона и временной обратной связи: корпус отделён мягкой тенью, сообщения имеют едва заметное поднятие, стеклянные элементы сохраняют нативные блики и backdrop blur.

### Shadow Vocabulary

- **Clipboard toast** — `0 8px 28px rgba(20, 26, 23, 0.22)`; временное сообщение от кнопки сайта.
- **Telegram message** — `0 calc(0.6 * var(--vp)) calc(1 * var(--vp)) #17211d1a`; обычный bubble. У карточки вертикальное размытие составляет `calc(1.2 * var(--vp))`.
- **Telegram menu toggle** — `0 calc(1.5 * var(--vp)) calc(6 * var(--vp)) #0589ff4d`; голубой круг меню.
- **Phone enclosure** — inset-блики и две мягкие внешние тени; полная запись находится в sidecar и `Phone.astro`.

## Shapes

Кнопки сайта имеют мягкий компактный угол, указанный в frontmatter. Текстовые действия сохраняют прямой силуэт и подчёркивание. Фотографии и цитаты стоят на общем фоне без добавочной оболочки; мобильная навигация получает тональную панель.

Телефон сохраняет систему координат V6: внешний корпус 434 × 890, экран 402 × 858, внешний радиус `73.3 * --vp`, радиус экрана `57.3 * --vp`. Внешняя тень принадлежит корпусу; отдельные слои корпуса и экрана обрезают содержимое по собственным скруглениям. Сообщения используют закруглённую форму с нативным хвостиком, действия выбора — капсулу, menu toggle — круг.

## Components

### Website actions and feedback

Основная кнопка имеет минимальную высоту 56px, малый вариант — 44px. Hover меняет leaf на leaf-hover, active — на leaf-pressed и сдвигает кнопку вниз на 1px. Вторичная кнопка — текстовая ссылка с минимальной высотой 48px. Общий keyboard focus — синий outline 3px с отступом 5px. Внешние действия копирования показывают временный toast (успех 3.2s; ручная копия при отказе 9s).

### Navigation

Desktop-header сочетает исходный логотип, четыре якорные ссылки, язык, GitHub и установку. До 960px ссылки и язык переходят в панель по кнопке меню 44 × 44px; GitHub сохраняется отдельной видимой кнопкой. Панель закрывается повторным нажатием, Escape, выбором ссылки и нажатием снаружи; состояние отражает `aria-expanded`.

### People situations, reviews and integration marks

Ситуация объединяет конкретный H2, короткое пояснение и связанное фото. Отзывы используют три существующие короткие цитаты на каждом языке, имя автора и исходную `t.me` ссылку. Логотипы подключений — существующие SVG; название сопровождает каждый знак. В этой реализации карточный декор уступает месту типографике, фотографиям и интервалам.

### Settings, ownership, install and FAQ

Настройки имеют текстовое действие «Открыть меню в демо» (локализованная подпись берётся из copy). Владение данными оформлено как `dl` с читаемыми `dt`/`dd`. Полоса установки собирает H2, пояснение, основную кнопку и ссылку документации; до 600px действия занимают вертикальную последовательность. FAQ использует вложенные native `details`/`summary`, тонкие верхнюю и нижнюю линии и синий плюс, который при раскрытии становится минусом.

### Native Telegram demonstration

Телефон и его интерфейс наследуют V6, а реальные кнопки отвечают на выбор в подготовленном сценарии. Голубое основное и серое вторичное действие сохраняют форму нативных капсул; высота равна `max(32px, calc(38 * var(--vp)))`, размер текста — `max(12px, calc(16.5 * var(--vp)))` при любой ширине. Входящие карточки, исходящие реплики, голосовое, PDF, карта и переход к переписке сохраняют собственные детали; декоративные composer-элементы остаются частью изображения интерфейса.

Menu toggle открывает настройки и повторным нажатием закрывает их с продолжением сюжета. Текущая модель отражается в тексте состояния, а выбранный вариант — в `aria-pressed` и selected-цвете. Корневая клавиатура имеет две колонки; вложенная — одну. Кнопки обеих клавиатур имеют минимальную высоту 32px; размер текста — `max(13px, calc(15 * var(--vp)))`, в корневой — `max(12px, calc(15 * var(--vp)))`. Отдельная зелёная кнопка установки появляется в корневом меню.

Стрелка меню — отдельный SVG-сосед `Phone` внутри внешнего контейнера с `preserveAspectRatio="none"`; на desktop её начало координат вынесено влево на 42 внешние единицы, размер — 42 × 82, нижний отступ — 15. Кончик попадает в точку x = −7, y = 802 системы полного корпуса. До 960px применяются `left: -20px` и `width: 18px`; высота и нижний отступ сохраняют нативное масштабирование через `--outer-vp`. Единственная видимая поясняющая подпись под телефоном — `[data-demo-hint]`: в сюжете она показывает «Демо: нажимайте кнопки в чате», а в меню меняется по контексту. Приоритет в `renderMenu()` — закрытое меню, экран перезапуска, показанный перезапуск, язык, обзорный экран или статус, прочие настройки. Подписи сцены и общей оговорки доступны через `v7-sr`; рядом расположен повтор. Первое знакомство с меню даёт три мягких пульса за 1.8s каждый после задержки 0.6s; после открытия стрелка исчезает, seen-состояние сохраняется при Replay. Действие установки в меню пульсирует два раза за 1.8s после задержки 0.4s.

Финальная карточка спрашивает: «Хотите установить Иву — личного AI-помощника в Telegram?» и предлагает «Установить Иву» / «Не сейчас». Копирование проходит через единственный обработчик Home. Результат и доступный для выделения текст ручной копии остаются в чате; глобальный toast используется внешними кнопками сайта.

Переходы кнопок сайта длятся 160ms, toast — 180ms. Подготовленное движение сообщений, нажатий и смены переписки управляется кадрами и пятью исходными spring-конфигурациями в `demo-state.ts`; эта запись фиксирует реализованный фильм. При `prefers-reduced-motion: reduce` CSS отключает transition/animation, а демо предлагает ручную следующую сцену с полным текстом. Обычные разделы страницы появляются статично.

Источник формы — V6 (`Film6.tsx` / `Film5.tsx`); справочник сопоставлений — `.scratch/work/site-v7/online-references.md` в основной рабочей папке на MacBook и `ref-*.png` той же задачи. Family, Lindy и Things служили ориентирами разделения продукта и пояснения; Sana и Daylight — ориентирами фотографических разделов. Эта запись утверждает только наблюдаемую реализацию выше, а чужие эффекты сохраняет материалом сравнения.

## Do's and Don'ts

### Do:

- **Do** сохранять исходный SVG логотипа, пропорции и цвета листьев.
- **Do** держать Manrope сайта и нативные шрифты телефона в отдельных областях.
- **Do** давать конкретные заголовки без завершающих точек.
- **Do** сохранять на mobile порядок ситуации: заголовок, пояснение, фото.
- **Do** размещать общую подсказку демо и стрелку снаружи корпуса.
- **Do** сохранять видимый GitHub, keyboard focus и ручной проход сцен при reduced motion.
- **Do** показывать результат копирования внутри того же контекста, где выбрана установка.

### Don't:

- **Don't** переносить стекло, металлические градиенты и нативные bubbles в обычные блоки сайта.
- **Don't** возвращать маркетинговую плашку внутрь корпуса телефона.
- **Don't** добавлять общий вводный H2 перед четырьмя конкретными ситуациями.
- **Don't** добавлять пустой заголовок для ряда отзывов или вымышленные цитаты.
- **Don't** превращать композицию главной в обязательный шаблон документации.
