/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isDisabledToolSentinel } from "eve/tools";

// Гейт обязан стоять на КАЖДОМ узле графа агентов, а не только на корне.
// Объявленный субагент не наследует авторские слоты родителя: отсутствующий
// слот падает на дефолт фреймворка, не на версию корня
// (документация eve про субагентов, «The isolation boundary»), а
// resolve-agent-graph.js подмешивает framework-тулы каждому узлу и вычитает
// только авторские тулы ТОГО ЖЕ узла. Значит узел без своего web_fetch получает
// штатный — страница едет в модель мимо санитайзера.
//
// Тест обходит корень и все объявленные субагенты (включая вложенные) и требует
// от каждого узла по каждому web-тулу одно из двух: слот закрыт `disableTool()`
// или тул проходит через `agent/lib/web-gate.ts`. Новый субагент без такого
// файла роняет тест, а не открывает дыру молча.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WEB_TOOL_NAMES = ["web_fetch", "web_search"] as const;
const GATE_MODULE = "lib/web-gate.ts";

// Каталоги узлов графа: корень плюс дерево agent/subagents/**.
function agentNodeDirectories(): string[] {
  const nodes = ["agent"];

  function visit(nodeDirectory: string): void {
    const subagents = posix.join(nodeDirectory, "subagents");
    if (!existsSync(join(ROOT, subagents))) return;
    for (const entry of readdirSync(join(ROOT, subagents), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const child = posix.join(subagents, entry.name);
      nodes.push(child);
      visit(child);
    }
  }

  visit("agent");
  return nodes;
}

test("каждый узел графа агентов либо гейтит web-тул, либо выключает его", async () => {
  const nodes = agentNodeDirectories();
  assert.ok(nodes.includes("agent"), "корневой узел обязан быть в обходе");

  for (const node of nodes) {
    for (const name of WEB_TOOL_NAMES) {
      const relativePath = posix.join(node, "tools", `${name}.ts`);
      assert.ok(
        existsSync(join(ROOT, relativePath)),
        `${relativePath} отсутствует: узел получит штатный ${name} без гейта`,
      );

      const source = readFileSync(join(ROOT, relativePath), "utf8");
      const { default: authored } = (await import(
        join(ROOT, relativePath)
      )) as { default: unknown };

      if (isDisabledToolSentinel(authored)) continue;

      assert.match(
        source,
        new RegExp(GATE_MODULE.replace(/[/.]/gu, "\\$&"), "u"),
        `${relativePath} не выключен и не ссылается на ${GATE_MODULE}: web-контент пойдёт мимо санитайзера`,
      );
    }
  }
});
