/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Счёт установок (ADR-0029): что уходит с машины, чем выключается и чем отправка не может
// помешать установке. Запрос проверяется на проводе: настоящий HTTP-сервер на loopback
// принимает ровно то, что отправил бы fetch, а адрес сайта подменяется только хостом.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import fc from "fast-check";
import {
  INSTALL_COUNT_URL,
  installCountEnabled,
  sendInstallCount,
} from "./install-count.ts";

const SEED = Number(process.env.FC_SEED ?? 20_261_122);

type Seen = {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
};

/** Сайт на loopback: записывает запрос и отвечает тем, что велел тест. */
async function site(
  answer: { readonly status: number; readonly location?: string } | "silent",
): Promise<{
  readonly seen: Seen[];
  /** Адрес этого сайта: на него тест направляет чужой редирект. */
  readonly url: string;
  readonly request: typeof fetch;
  readonly close: () => Promise<void>;
}> {
  const seen: Seen[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      seen.push({
        method: incoming.method ?? "",
        path: incoming.url ?? "",
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (answer === "silent") return;
      response.writeHead(
        answer.status,
        answer.location ? { location: answer.location } : {},
      );
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const published = new URL(INSTALL_COUNT_URL);
  return {
    seen,
    url: `http://127.0.0.1:${port}/`,
    // Подменяется только происхождение: путь, метод, заголовки и тело идут как есть.
    request: (input, init) => {
      const asked = new URL(input instanceof Request ? input.url : input);
      assert.equal(asked.origin, published.origin);
      return fetch(`http://127.0.0.1:${port}${asked.pathname}`, init);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("the request carries the plugin name and nothing that tells one installation from another", async () => {
  const world = await site({ status: 200 });
  try {
    assert.equal(await sendInstallCount("voice-reply", world.request), true);
  } finally {
    await world.close();
  }
  assert.equal(world.seen.length, 1);
  const [sent] = world.seen;
  assert.equal(sent.method, "POST");
  assert.equal(sent.path, "/api/plugins/installs");
  assert.equal(sent.body, '{"name":"voice-reply"}');
  assert.equal(sent.headers["content-type"], "application/json");
  // Ни куки, ни авторизации, ни своего заголовка: всё, что есть сверх тела, ставит сам fetch.
  const ours = Object.keys(sent.headers).filter(
    (header) =>
      ![
        "host",
        "connection",
        "content-type",
        "content-length",
        "accept",
        "accept-language",
        "accept-encoding",
        "sec-fetch-mode",
        "user-agent",
      ].includes(header),
  );
  assert.deepEqual(ours, []);
  assert.doesNotMatch(String(sent.headers["user-agent"]), /iva/iu);
});

test("a site that refuses, redirects or never answers costs the install nothing", async () => {
  const refused = await site({ status: 500 });
  const elsewhere = await site({ status: 200 });
  const moved = await site({ status: 302, location: elsewhere.url });
  const silent = await site("silent");
  try {
    assert.equal(await sendInstallCount("trace", refused.request), false);
    // Редирект не выполняется: имя не уходит по адресу, который назвал ответ.
    assert.equal(await sendInstallCount("trace", moved.request), false);
    const started = Date.now();
    assert.equal(await sendInstallCount("trace", silent.request, 150), false);
    assert.ok(Date.now() - started < 2000, "the wait is bounded");
  } finally {
    await Promise.all(
      [refused, elsewhere, moved, silent].map((one) => one.close()),
    );
  }
  assert.equal(moved.seen.length, 1);
  assert.deepEqual(elsewhere.seen, []);
  // Сети нет вовсе — тоже `false`, без исключения наружу.
  const offline: typeof fetch = () => Promise.reject(new TypeError("offline"));
  assert.equal(await sendInstallCount("trace", offline), false);
});

const OFF_WORDS = ["off", "0", "false", "no"] as const;
const padding = fc.stringMatching(/^[ \t]{0,3}$/u);
/** Слово в произвольном регистре: владелец пишет `.env` руками. */
const anyCase = (word: string) =>
  fc
    .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
    .map((upper) =>
      [...word]
        .map((letter, index) =>
          upper[index] ? letter.toUpperCase() : letter.toLowerCase(),
        )
        .join(""),
    );

test(`IVA_PLUGIN_STATS turns the count off in any spelling of "off" (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...OFF_WORDS).chain(anyCase),
      padding,
      padding,
      (word, before, after) => {
        assert.equal(
          installCountEnabled({ IVA_PLUGIN_STATS: `${before}${word}${after}` }),
          false,
        );
      },
    ),
    { seed: SEED },
  );
});

test(`the count is on unless one of the two switches says otherwise (seed ${SEED})`, () => {
  const other = fc
    .string({ maxLength: 12 })
    .filter(
      (value) =>
        !(OFF_WORDS as readonly string[]).includes(value.trim().toLowerCase()),
    );
  const untracked = fc.string({ maxLength: 6 }).filter((v) => v.trim() !== "1");
  fc.assert(
    fc.property(
      fc.option(other, { nil: undefined }),
      fc.option(untracked, { nil: undefined }),
      (stats, track) => {
        assert.equal(
          installCountEnabled({ IVA_PLUGIN_STATS: stats, DO_NOT_TRACK: track }),
          true,
        );
        // DO_NOT_TRACK=1 перекрывает любое значение своего выключателя.
        assert.equal(
          installCountEnabled({ IVA_PLUGIN_STATS: stats, DO_NOT_TRACK: " 1 " }),
          false,
        );
      },
    ),
    { seed: SEED },
  );
});
