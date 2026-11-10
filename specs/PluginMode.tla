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
\* каждая кончается сверкой). `enable`, `trust` и `update` после этого шага собирают версию
\* БЕЗ замка команды: между записью и откатом несобравшейся сборки проходит любая другая
\* команда.
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
\*   Update         plugin-cli-install.ts:update — новый код в стор, запись с теми же тумблерами,
\*                  reconcileUnits; сборка версии после замка
\*   UpdateBuilt    сборка после `update` прошла
\*   UpdateUndone   update: сборка не прошла — undoInstalls возвращает папку, а в запись код и
\*                  версию прежней записи; тумблеры — из записи под замком отката; снятый за
\*                  время сборки плагин не возвращается. Юниты не сверяет.
\*   Reconcile      plugin-cli-trust.ts:reconcileUnits -> scripts/lib/plugin-units.ts:pluginUnitPlan
\*                  (юниты только режиму full) и reconcilePluginUnits (лишние сняты)
\*   UpdateOff      scripts/lib/version-update.ts:settlePlugins -> plugin-build.ts:disableCodePlugin,
\*                  затем юниты выключенного плагина снимает update-finish.ts:restartPluginUnits
\*                  (сверка по записи: работает только то, что в режиме full)
\*
\* Мутанты (свидетели), каждый нарушает свой инвариант:
\*   PlanNeedsTrust = FALSE   план юнитов смотрит только на enabled
\*   DisableStops = FALSE     `disable` пишет состояние без сверки юнитов
\*   UndoStops = FALSE        откат несобравшегося `enable` без сверки юнитов (код до ремонта)
\*   TurnRefused = FALSE      `iva plugin trust` проходит в ходе модели
\*   UndoRereads = FALSE      откат пишет запись, прочитанную ДО сборки (код до ремонта)
\*   UpdateUndoKeeps = FALSE  откат `update` возвращает прежнюю запись целиком (код до ремонта)
\*   UpdateReenables = TRUE   обновление включает плагин, который снова собрался
\*   UpdateOffStops = FALSE   обновление выключает запись и юниты не сверяет (код до ремонта)
EXTENDS Naturals

CONSTANTS
  PlanNeedsTrust,   \* TRUE — юниты получает только режим full
  DisableStops,     \* TRUE — `disable` кончается сверкой юнитов
  UndoStops,        \* TRUE — откат `enable` кончается сверкой юнитов
  UndoRereads,      \* TRUE — откат меняет один тумблер записи, прочитанной под замком отката
  UpdateUndoKeeps,  \* TRUE — откат `update` оставляет тумблеры записи, прочитанной под его замком
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
  undoT, snapE,                 \* `trust` ждёт сборку; enabled записи, которую он прочитал
  undoU, prior                  \* `update` ждёт сборку; тумблеры записи, которую он заменил

vars == <<installed, enabled, trusted, units, enabledBy, trustBy, undoE, snapT, undoT, snapE,
          undoU, prior>>

NoPrior == [enabled |-> FALSE, trusted |-> FALSE]

Init ==
  /\ installed = FALSE /\ enabled = FALSE /\ trusted = FALSE
  /\ units = FALSE
  /\ enabledBy = "none" /\ trustBy = "none"
  /\ undoE = FALSE /\ snapT = FALSE
  /\ undoT = FALSE /\ snapE = FALSE
  /\ undoU = FALSE /\ prior = NoPrior

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
  /\ UNCHANGED <<undoE, snapT, undoT, snapE, undoU, prior>>

Enable(actor) ==
  /\ installed /\ ~enabled /\ ~undoE /\ May(actor)
  /\ enabled' = TRUE /\ enabledBy' = actor
  /\ undoE' = TRUE /\ snapT' = trusted
  /\ UNCHANGED <<installed, trusted, trustBy, undoT, snapE, undoU, prior>>
  /\ Reconcile

Disable ==
  /\ installed /\ enabled
  /\ enabled' = FALSE /\ enabledBy' = "none"
  /\ UNCHANGED <<installed, trusted, trustBy, undoE, snapT, undoT, snapE, undoU, prior>>
  /\ IF DisableStops THEN Reconcile ELSE NoReconcile

Trust(actor) ==
  /\ installed /\ ~trusted /\ ~undoT /\ May(actor)
  /\ trusted' = TRUE /\ trustBy' = actor
  \* Сборка идёт только у включённого: выключенному доверие — одна запись.
  /\ undoT' = enabled /\ snapE' = enabled
  /\ UNCHANGED <<installed, enabled, enabledBy, undoE, snapT, undoU, prior>>
  /\ Reconcile

Untrust ==
  /\ installed /\ trusted
  /\ trusted' = FALSE /\ trustBy' = "none"
  /\ UNCHANGED <<installed, enabled, enabledBy, undoE, snapT, undoT, snapE, undoU, prior>>
  /\ Reconcile

Remove ==
  /\ installed
  /\ installed' = FALSE
  /\ enabled' = FALSE /\ enabledBy' = "none"
  /\ trusted' = FALSE /\ trustBy' = "none"
  /\ Reconcile
  /\ UNCHANGED <<undoE, snapT, undoT, snapE, undoU, prior>>

\* ── сборка версии после enable и trust ──

EnableBuilt ==
  /\ undoE
  /\ undoE' = FALSE /\ snapT' = FALSE
  /\ UNCHANGED <<installed, enabled, trusted, units, enabledBy, trustBy, undoT, snapE, undoU, prior>>

TrustBuilt ==
  /\ undoT
  /\ undoT' = FALSE /\ snapE' = FALSE
  /\ UNCHANGED <<installed, enabled, trusted, units, enabledBy, trustBy, undoE, snapT, undoU, prior>>

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
  /\ UNCHANGED <<undoT, snapE, undoU, prior>>

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
  /\ UNCHANGED <<undoE, snapT, undoU, prior>>

\* ── `iva plugin update` и откат его несобравшейся сборки ──

\* Тумблеры записи не меняются; юниты сверяются по ним (новый код — тот же режим).
Update ==
  /\ installed /\ ~undoU
  /\ undoU' = TRUE
  /\ prior' = [enabled |-> enabled, trusted |-> trusted]
  /\ UNCHANGED <<installed, enabled, trusted, enabledBy, trustBy, undoE, snapT, undoT, snapE>>
  /\ Reconcile

UpdateBuilt ==
  /\ undoU
  /\ undoU' = FALSE /\ prior' = NoPrior
  /\ UNCHANGED <<installed, enabled, trusted, units, enabledBy, trustBy, undoE, snapT, undoT, snapE>>

\* Перечитанная запись получает назад только код и версию: тумблеры и снятие плагина —
\* чужие решения за время сборки, их откат не трогает. Мутант возвращает запись целиком:
\* снятое доверие, выключение и сам снятый плагин.
UpdateUndone ==
  /\ undoU
  /\ undoU' = FALSE /\ prior' = NoPrior
  /\ IF UpdateUndoKeeps
       THEN UNCHANGED <<installed, enabled, trusted, enabledBy, trustBy>>
       ELSE /\ installed' = TRUE
            /\ enabled' = prior.enabled
            /\ enabledBy' = IF ~prior.enabled THEN "none"
                            ELSE IF installed /\ enabled THEN enabledBy ELSE "stale"
            /\ trusted' = prior.trusted
            /\ trustBy' = IF ~prior.trusted THEN "none"
                          ELSE IF installed /\ trusted THEN trustBy ELSE "stale"
  /\ NoReconcile
  /\ UNCHANGED <<undoE, snapT, undoT, snapE>>

\* ── обновление Ивы ──

\* Плагин, чей код не собрался с новой версией, выключается; доверие остаётся.
UpdateSwitchesOff ==
  /\ UpdateOff /\ installed /\ enabled
  /\ enabled' = FALSE /\ enabledBy' = "none"
  /\ UNCHANGED <<installed, trusted, trustBy, undoE, snapT, undoT, snapE, undoU, prior>>
  /\ IF UpdateOffStops THEN Reconcile ELSE NoReconcile

\* Мутант: «код снова собирается — включим обратно».
UpdateSwitchesOn ==
  /\ UpdateReenables /\ installed /\ ~enabled
  /\ enabled' = TRUE /\ enabledBy' = "update"
  /\ UNCHANGED <<installed, trusted, trustBy, undoE, snapT, undoT, snapE, undoU, prior>>
  /\ Reconcile

Next ==
  \/ \E answer \in BOOLEAN : Install(answer)
  \/ \E actor \in Actors : Enable(actor) \/ Trust(actor)
  \/ Disable \/ Untrust \/ Remove
  \/ EnableBuilt \/ TrustBuilt \/ EnableUndone \/ TrustUndone
  \/ Update \/ UpdateBuilt \/ UpdateUndone
  \/ UpdateSwitchesOff \/ UpdateSwitchesOn

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ installed \in BOOLEAN /\ enabled \in BOOLEAN /\ trusted \in BOOLEAN
  /\ units \in BOOLEAN
  /\ enabledBy \in Sources /\ trustBy \in Sources
  /\ undoE \in BOOLEAN /\ snapT \in BOOLEAN
  /\ undoT \in BOOLEAN /\ snapE \in BOOLEAN
  /\ undoU \in BOOLEAN
  /\ prior \in [enabled : BOOLEAN, trusted : BOOLEAN]

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
