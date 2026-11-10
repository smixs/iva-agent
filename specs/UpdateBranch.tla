----------------------------- MODULE UpdateBranch -----------------------------
(* Update branch: одна запись решает, какая версия приезжает обновлением (ADR-0018).

   `scripts/lib/update-channel.ts` пишет выбор владельца в два репозитория установки:
   сам репозиторий установки (его читают install.sh и `git config` владельца) и зеркало
   `<home>/repo`, из которого обновление берёт историю и - сегодня - саму ветку
   (`resolveUpdateTarget` спрашивает `iva.updateBranch` у того репозитория, чей `git`
   ему передали, а передают зеркало). Между двумя записями процесс можно убить, а откат
   неудавшейся записи сам может не пройти (`setBeta` возвращает "partial").

   Модель спрашивает: достаточно ли одной записи, и что чинит расхождение. Ответ,
   который она проверяет: запись владельца - установка; зеркало - её кэш; чтение
   сверяет кэш с записью и чинит расхождение (тогда обновление ставит то, что выбрал
   владелец), а версию, которую ставит обновление, определяет одна запись.

   Инварианты (нумерация задания):
     (1) OneRecord      версию, которую ставит обновление, определяет одна запись
     (2) AgreeAfterRead после чтения установка и зеркало согласованы
     (3) NotBelow       обновление не уводит установку назад (ADR-0018)

   Мутанты (свидетели):
     TwoSides = FALSE, RepairOnRead = FALSE  запись только в установку, без починки при
                                            чтении -> (1) и (2)
     RepairOnRead = FALSE, RollbackWorks = FALSE  расхождение после неудавшегося отката
                                            не чинится чтением -> (1) и (2)
     BelowAllowed = TRUE                    обновление ставит ветку ниже установленного -> (3)

   Вне модели: сеть и доступность ветки (BranchUnavailableError); что `git config` двух
   репозиториев не атомарен сам по себе - это и есть место, где ход рвётся; формат
   репозитория и отбор меток vX.Y.Z.
*)
EXTENDS Naturals

CONSTANTS
  TwoSides,      \* TRUE - выбор пишется в оба репозитория
  RepairOnRead,  \* TRUE - чтение чинит расхождение: кэш (зеркало) получает запись установки
  RollbackWorks, \* TRUE - откат неудавшейся записи возвращает прежнее значение
  BelowAllowed   \* TRUE - обновление ставит ветку ниже установленной (мутант, ADR-0018)

VARIABLES
  install,   \* `iva.updateBranch` в репозитории установки (запись владельца)
  mirror,    \* ... в зеркале (кэш, из которого обновление читает ветку)
  choice,    \* что владелец попросил последним: "main" | "beta"
  pending,   \* "none" | "install" - первая запись сделана, вторая нет
  fresh,     \* TRUE - после последнего чтения ничего не писали: чтение свежее
  installing,\* ветка, которую ставит следующее обновление
  installed, \* установленный выпуск: 1 (main) | 2 (beta)
  target     \* выпуск, который поставит обновление

vars == <<install, mirror, choice, pending, fresh, installing, installed, target>>

\* Выпуск, который несёт ветка.
ReleaseOf(b) == IF b = "beta" THEN 2 ELSE 1

Init ==
  /\ install = "main" /\ mirror = "main" /\ choice = "main"
  /\ pending = "none" /\ fresh = FALSE
  /\ installing = "main"
  /\ installed = 1 /\ target = 1

\* `iva beta` и `iva stable`: первая запись - установка.
SetBranch ==
  /\ \E b \in {"main", "beta"}:
       /\ pending = "none"
       /\ choice' = b
       /\ install' = b
       /\ pending' = "install" /\ fresh' = FALSE
       /\ UNCHANGED <<mirror, installing, installed, target>>

\* Вторая запись - зеркало. Без TwoSides зеркало не пишется вовсе.
SetMirror ==
  /\ pending = "install"
  /\ mirror' = IF TwoSides THEN choice ELSE mirror
  /\ pending' = "none" /\ fresh' = FALSE
  /\ UNCHANGED <<install, choice, installing, installed, target>>

\* Процесс убит между двумя записями.
Break ==
  /\ pending = "install"
  /\ pending' = "none" /\ fresh' = FALSE
  /\ UNCHANGED <<install, mirror, choice, installing, installed, target>>

\* Откат неудавшейся записи: `setBeta` возвращает установку к прежнему значению. Не
\* прошёл (RollbackWorks = FALSE) - остаётся "partial": записи разошлись.
Rollback ==
  /\ pending = "install"
  /\ pending' = "none"
  \* Состоявшийся откат возвращает и выбор владельца: «beta» тогда не выбор, а неудавшаяся
  \* попытка. Несостоявшийся оставляет запись владельца на месте — следующее чтение донесёт
  \* её до кэша.
  /\ install' = IF RollbackWorks THEN mirror ELSE install
  /\ choice' = IF RollbackWorks THEN mirror ELSE choice
  /\ fresh' = FALSE
  /\ UNCHANGED <<mirror, installing, installed, target>>

\* Чтение: обновление и `iva version` спрашивают ветку. С RepairOnRead кэш получает
\* запись установки - расхождение чинится тем же чтением.
Read ==
  /\ pending = "none"
  /\ fresh' = TRUE
  /\ mirror' = IF RepairOnRead /\ install # mirror THEN install ELSE mirror
  /\ installing' = IF RepairOnRead /\ install # mirror THEN install ELSE mirror
  /\ UNCHANGED <<install, choice, pending, installed, target>>

\* Обновление решает, что ставить: выпуск ветки, но не ниже установленного.
Plan ==
  /\ pending = "none"
  /\ fresh
  /\ target' = IF ~BelowAllowed /\ ReleaseOf(installing) < installed
                 THEN installed
                 ELSE ReleaseOf(installing)
  /\ UNCHANGED <<install, mirror, choice, pending, fresh, installing, installed>>

\* И ставит: переезд на выбранный выпуск.
Install ==
  /\ pending = "none"
  /\ fresh
  /\ installed' = target
  /\ UNCHANGED <<install, mirror, choice, pending, fresh, installing, target>>

Next ==
  \/ SetBranch \/ SetMirror \/ Break \/ Rollback \/ Read \/ Plan \/ Install

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ install \in {"main", "beta"} /\ mirror \in {"main", "beta"}
  /\ choice \in {"main", "beta"}
  /\ pending \in {"none", "install"}
  /\ fresh \in BOOLEAN
  /\ installing \in {"main", "beta"}
  /\ installed \in {1, 2} /\ target \in {1, 2}

\* (1) Версию, которую ставит обновление, определяет одна запись: ветка, прочитанная
\* для обновления, - это выбор владельца.
OneRecord == fresh => installing = choice

\* (2) После чтения установка и зеркало согласованы: расхождение чинится чтением.
AgreeAfterRead == fresh => install = mirror

\* (3) Обновление не уводит установку назад (ADR-0018).
NotBelow == target >= installed
====
