---- MODULE PluginMode ----
\* Режим плагина (ADR-0009): пара тумблеров `enabled` × `trusted` одной записи
\* data/custom/plugins.json и юниты, которые за ней следуют. Модель написана ПОСЛЕ кода и
\* проверяет код, не дизайн: каждое действие — шаг существующей функции (карта ниже).
\*
\* Четыре режима (agent/lib/plugin-store.ts:pluginMode):
\*   full          enabled и trusted   скиллы, код и процессы плагина
\*   no-processes  enabled             скиллы и код; MCP-серверы и сервисы не запускаются
\*   paused        trusted             ничего не работает; доверие помнится, `enable` вернёт всё
\*   off           —                   ничего не работает
\*
\* Плагин модели — с процессами (`stdio` в mcp.json или sh.iva/services): только у него
\* есть юниты, и только его `add` без терминала отклоняется. Плагин из одних скиллов модель
\* ставит сама (ADR-0009) — он вне модели.
\*
\* Кто действует:
\*   owner   владелец у терминала или его тап: Bridge запускает команду вне хода модели
\*   turn    `bash` модели в ходе (IVA_AGENT_TURN=1): ему отказано в trust и enable
\*   update  `iva update`: сборка версии и её расчёт с плагинами
\*
\* Команда `iva plugin` под замком обновления пишет plugins.json и сверяет юниты; это один
\* шаг модели (обрыв между записью и сверкой — вне модели, его закрывает следующая команда:
\* каждая кончается сверкой). `enable` и `trust` после этого шага собирают версию БЕЗ замка
\* команды: между записью и откатом несобравшейся сборки проходит любая другая команда.
\*
\* Действие модели -> код
\*   Install        scripts/cli/plugin-cli-install.ts:add — запись enabled, ответ на вопрос
\*                  доверия (askTrust: терминал или `--trust` установщика по тапу), reconcileUnits
\*   Enable         scripts/cli/plugin-cli-trust.ts:toggle(true) — запись, reconcileUnits, сборка
\*   Disable        toggle(false) — запись, reconcileUnits
\*   Trust          plugin-cli-trust.ts:setTrusted(true) — запись, порты, reconcileUnits, сборка
\*   Untrust        setTrusted(false) — запись, reconcileUnits
\*   Remove         plugin-cli-install.ts:remove — запись без плагина, reconcileUnits
\*   TurnGate       scripts/lib/deferred-command.ts:fromTurn — отказ trust|enable в ходе модели
\*   BuildOk        сборка версии прошла (или её не было: у плагина нечего собирать)
\*   EnableUndone   toggle: сборка не прошла — «stays disabled»: запись и reconcileUnits
\*   TrustUndone    setTrusted: сборка не прошла — «stays untrusted»: запись и reconcileUnits
\*   Reconcile      plugin-cli-trust.ts:reconcileUnits -> scripts/lib/plugin-units.ts:pluginUnitPlan
\*                  (юниты только режиму full) и reconcilePluginUnits (лишние сняты)
\*   UpdateOff      scripts/lib/version-update.ts:settlePlugins -> plugin-build.ts:disableCodePlugin
\*
\* Мутанты (свидетели), каждый нарушает свой инвариант:
\*   PlanNeedsTrust = FALSE   план юнитов смотрит только на enabled
\*   DisableStops = FALSE     `disable` пишет состояние без сверки юнитов
\*   UndoStops = FALSE        откат несобравшегося `enable` без сверки юнитов (код до ремонта)
\*   TurnRefused = FALSE      `iva plugin trust` проходит в ходе модели
\*   UndoRereads = FALSE      откат пишет запись, прочитанную ДО сборки (код до ремонта)
\*   UpdateReenables = TRUE   обновление включает плагин, который снова собрался
\*
\* Открытая находка, не мутант: UpdateOffStops = FALSE — так обновлятор работает сегодня.
\* settlePlugins выключает плагин с несобравшимся кодом и юниты не сверяет; конфигурация
\* PluginMode-update-off.cfg показывает нарушение DisabledIsStopped. В зелёной конфигурации
\* этого действия нет (UpdateOff = FALSE): она говорит о командах `iva plugin`.
EXTENDS Naturals

CONSTANTS
  PlanNeedsTrust,   \* TRUE — юниты получает только режим full
  DisableStops,     \* TRUE — `disable` кончается сверкой юнитов
  UndoStops,        \* TRUE — откат `enable` кончается сверкой юнитов
  UndoRereads,      \* TRUE — откат меняет один тумблер записи, прочитанной под замком отката
  TurnRefused,      \* TRUE — trust и enable в ходе модели отклонены
  UpdateReenables,  \* FALSE — обновление ничего не включает
  UpdateOff,        \* TRUE — обновление выключает плагин с несобравшимся кодом
  UpdateOffStops    \* TRUE — и сверяет после этого юниты

Actors == {"owner", "turn"}
Sources == {"none", "owner", "turn", "update", "stale"}

VARIABLES
  installed, enabled, trusted,  \* запись плагина в plugins.json
  units,                        \* юниты плагина написаны и работают
  enabledBy, trustBy,           \* чьим действием тумблер сейчас включён
  undoE, snapT,                 \* `enable` ждёт сборку; trusted записи, которую он прочитал
  undoT, snapE                  \* `trust` ждёт сборку; enabled записи, которую он прочитал

vars == <<installed, enabled, trusted, units, enabledBy, trustBy, undoE, snapT, undoT, snapE>>

Init ==
  /\ installed = FALSE /\ enabled = FALSE /\ trusted = FALSE
  /\ units = FALSE
  /\ enabledBy = "none" /\ trustBy = "none"
  /\ undoE = FALSE /\ snapT = FALSE
  /\ undoT = FALSE /\ snapE = FALSE

\* pluginUnitPlan по новому состоянию: что должно работать после сверки.
Planned == installed' /\ enabled' /\ (trusted' \/ ~PlanNeedsTrust)
Reconcile == units' = Planned
NoReconcile == units' = units

May(actor) == actor = "owner" \/ ~TurnRefused

\* ── команды владельца и хода ──

\* Плагин с процессами ставит только владелец: `add` без терминала отклонён (proposalOnly).
Install(answer) ==
  /\ ~installed
  /\ installed' = TRUE
  /\ enabled' = TRUE /\ enabledBy' = "owner"
  /\ trusted' = answer /\ trustBy' = IF answer THEN "owner" ELSE "none"
  /\ Reconcile
  /\ UNCHANGED <<undoE, snapT, undoT, snapE>>

Enable(actor) ==
  /\ installed /\ ~enabled /\ ~undoE /\ May(actor)
  /\ enabled' = TRUE /\ enabledBy' = actor
  /\ undoE' = TRUE /\ snapT' = trusted
  /\ UNCHANGED <<installed, trusted, trustBy, undoT, snapE>>
  /\ Reconcile

Disable ==
  /\ installed /\ enabled
  /\ enabled' = FALSE /\ enabledBy' = "none"
  /\ UNCHANGED <<installed, trusted, trustBy, undoE, snapT, undoT, snapE>>
  /\ IF DisableStops THEN Reconcile ELSE NoReconcile

Trust(actor) ==
  /\ installed /\ ~trusted /\ ~undoT /\ May(actor)
  /\ trusted' = TRUE /\ trustBy' = actor
  \* Сборка идёт только у включённого: выключенному доверие — одна запись.
  /\ undoT' = enabled /\ snapE' = enabled
  /\ UNCHANGED <<installed, enabled, enabledBy, undoE, snapT>>
  /\ Reconcile

Untrust ==
  /\ installed /\ trusted
  /\ trusted' = FALSE /\ trustBy' = "none"
  /\ UNCHANGED <<installed, enabled, enabledBy, undoE, snapT, undoT, snapE>>
  /\ Reconcile

Remove ==
  /\ installed
  /\ installed' = FALSE
  /\ enabled' = FALSE /\ enabledBy' = "none"
  /\ trusted' = FALSE /\ trustBy' = "none"
  /\ Reconcile
  /\ UNCHANGED <<undoE, snapT, undoT, snapE>>

\* ── сборка версии после enable и trust ──

EnableBuilt ==
  /\ undoE
  /\ undoE' = FALSE /\ snapT' = FALSE
  /\ UNCHANGED <<installed, enabled, trusted, units, enabledBy, trustBy, undoT, snapE>>

TrustBuilt ==
  /\ undoT
  /\ undoT' = FALSE /\ snapE' = FALSE
  /\ UNCHANGED <<installed, enabled, trusted, units, enabledBy, trustBy, undoE, snapT>>

\* «stays disabled». Перечитанная запись теряет один тумблер; снятого плагина откат не
\* возвращает. Запись, прочитанная до сборки, возвращает и плагин, и его старое доверие.
EnableUndone ==
  /\ undoE
  /\ undoE' = FALSE /\ snapT' = FALSE
  /\ enabled' = FALSE /\ enabledBy' = "none"
  /\ IF UndoRereads
       THEN UNCHANGED <<installed, trusted, trustBy>>
       ELSE /\ installed' = TRUE
            /\ trusted' = snapT
            /\ trustBy' = IF ~snapT THEN "none"
                          ELSE IF installed /\ trusted THEN trustBy ELSE "stale"
  /\ IF UndoStops THEN Reconcile ELSE NoReconcile
  /\ UNCHANGED <<undoT, snapE>>

\* «stays untrusted». То же для второго тумблера.
TrustUndone ==
  /\ undoT
  /\ undoT' = FALSE /\ snapE' = FALSE
  /\ trusted' = FALSE /\ trustBy' = "none"
  /\ IF UndoRereads
       THEN UNCHANGED <<installed, enabled, enabledBy>>
       ELSE /\ installed' = TRUE
            /\ enabled' = snapE
            /\ enabledBy' = IF ~snapE THEN "none"
                            ELSE IF installed /\ enabled THEN enabledBy ELSE "stale"
  /\ Reconcile
  /\ UNCHANGED <<undoE, snapT>>

\* ── обновление Ивы ──

\* Плагин, чей код не собрался с новой версией, выключается; доверие остаётся.
UpdateSwitchesOff ==
  /\ UpdateOff /\ installed /\ enabled
  /\ enabled' = FALSE /\ enabledBy' = "none"
  /\ UNCHANGED <<installed, trusted, trustBy, undoE, snapT, undoT, snapE>>
  /\ IF UpdateOffStops THEN Reconcile ELSE NoReconcile

\* Мутант: «код снова собирается — включим обратно».
UpdateSwitchesOn ==
  /\ UpdateReenables /\ installed /\ ~enabled
  /\ enabled' = TRUE /\ enabledBy' = "update"
  /\ UNCHANGED <<installed, trusted, trustBy, undoE, snapT, undoT, snapE>>
  /\ Reconcile

Next ==
  \/ \E answer \in BOOLEAN : Install(answer)
  \/ \E actor \in Actors : Enable(actor) \/ Trust(actor)
  \/ Disable \/ Untrust \/ Remove
  \/ EnableBuilt \/ TrustBuilt \/ EnableUndone \/ TrustUndone
  \/ UpdateSwitchesOff \/ UpdateSwitchesOn

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ installed \in BOOLEAN /\ enabled \in BOOLEAN /\ trusted \in BOOLEAN
  /\ units \in BOOLEAN
  /\ enabledBy \in Sources /\ trustBy \in Sources
  /\ undoE \in BOOLEAN /\ snapT \in BOOLEAN
  /\ undoT \in BOOLEAN /\ snapE \in BOOLEAN

\* (1) Процессы плагина работают только при доверии.
ProcessesNeedTrust == units => installed /\ trusted

\* (2) У выключенного плагина не работает ни один юнит.
DisabledIsStopped == units => installed /\ enabled

\* (3) Доверие в записи — только действием владельца.
TrustIsOwners == trusted => trustBy = "owner"

\* (4) Обновление Ивы ничего не включает и никому не доверяет.
UpdateGrantsNothing == enabledBy # "update" /\ trustBy # "update"

\* (5) Включён — только действием владельца: ни ход, ни откат чужой сборки не включают.
EnableIsOwners == enabled => enabledBy = "owner"
====
