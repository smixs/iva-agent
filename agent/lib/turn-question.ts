// Вопрос хода — текст последнего принятого сообщения владельца в чате — для сообщения об
// обрыве посреди ответа. Если оборвался первый запрос хода, eve не кладёт вопрос в историю
// сессии; поэтому канал цитирует его (коротко, для человека), а мост по нажатию «Повторить»
// подставляет модели вопрос целиком (scripts/poller/control.ts). Живёт в записи чата
// run-status: её читают оба процесса, и она переживает перезапуск (решение лида 07.10.2026).
//
// Сообщение без текста (голос, фото без подписи) старый вопрос стирает: «Повторить» не
// должен отвечать на предыдущее сообщение. Вложение помечается: кнопка его не вернёт, и
// сообщение об обрыве просит прислать его ещё раз. В режиме «по очереди» мост держит
// следующее сообщение до конца хода, поэтому последнее принятое и есть вопрос хода; в режиме
// «сразу» это последнее сообщение владельца.
import { isRetryTap } from "./error-humanizer.ts";
import { getChatStatus, setChatStatusIf } from "./run-status.ts";

/** Предел текста вопроса: одно сообщение Telegram. */
export const TURN_QUESTION_LIMIT = 4096;

export type TurnQuestion = { readonly text: string; readonly media: boolean };

export function rememberTurnQuestion(
  chatKey: string,
  { text, media }: TurnQuestion,
): void {
  const question = Array.from(text.trim())
    .slice(0, TURN_QUESTION_LIMIT)
    .join("");
  if (isRetryTap(question) && turnQuestion(chatKey) !== undefined) return;
  // touch: false — запись вопроса не говорит «ход жив» и не продлевает чужой ход.
  setChatStatusIf(
    chatKey,
    {},
    {
      turnQuestion: question === "" ? null : question,
      turnQuestionMedia: media ? true : null,
    },
    { touch: false },
  );
}

export function turnQuestion(chatKey: string): TurnQuestion | undefined {
  const status = getChatStatus(chatKey);
  const text =
    typeof status?.turnQuestion === "string" ? status.turnQuestion : "";
  const media = status?.turnQuestionMedia === true;
  return text === "" && !media ? undefined : { text, media };
}

/** Жетон, снимок вопроса и update_id живут в одной записи. */
export function claimInterruptedTap(
  chatKey: string,
  data: string,
  updateId: number,
): TurnQuestion | null {
  const current = getChatStatus(chatKey);
  if (current?.status !== "idle" || current.restartRetryData !== data)
    return null;
  if (
    current.restartRetryUpdate !== undefined &&
    current.restartRetryUpdate !== updateId
  )
    return null;
  const claimed = setChatStatusIf(
    chatKey,
    {
      generation: current.generation,
      status: "idle",
      restartRetryData: data,
      restartRetryUpdate: current.restartRetryUpdate,
    },
    { restartRetryUpdate: updateId },
    { touch: false },
  );
  return claimed === null
    ? null
    : {
        text:
          typeof current.restartRetryQuestion === "string"
            ? current.restartRetryQuestion
            : "",
        media: current.restartRetryMedia === true,
      };
}
