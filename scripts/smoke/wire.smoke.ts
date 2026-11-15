import assert from "node:assert/strict";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createHarness,
  message,
  OWNER,
  smokeParameters,
  waitFor,
} from "./harness.ts";

void test(
  "S-wire-out: schemas, widget fallback and outbound Gate",
  { timeout: 120_000 },
  async (t) => {
    const { seed } = smokeParameters();
    // Deliberately lacks a vendor prefix: only the installation inventory knows it.
    const secret = `smoke-private-value-${seed}-Q7mP4xN8zR2v`;
    const caption = "WIRE_WIDGET_CAPTION";
    const h = await createHarness(
      t,
      [
        {
          kind: "text",
          text: `WIRE_TEXT ${secret}\n\n\`\`\`tg-widget ${caption} ${secret}\n<html><body><p>WIRE_HTML ${secret}</p></body></html>\n\`\`\``,
        },
      ],
      async (app, env) => {
        env.OLLAMA_API_KEY = secret;
        await appendFile(
          join(app, ".env"),
          `OLLAMA_API_KEY=${secret}\nTELEGRAM_WIDGETS=auto\n`,
        );
      },
    );
    h.telegram.rejectNext("sendWidget", 400);
    const topic = 73;
    const update = message(401, "show the wire widget");
    h.telegram.push({
      ...update,
      message: { ...update.message, message_thread_id: topic },
    });
    await waitFor(() =>
      h.telegram.requests.some(
        (r) =>
          r.method === "sendMessage" && String(r.body.text).includes(caption),
      ),
    );

    // Inspect recorded HTTP bytes, after the installed serializer and middleware.
    assert.equal(h.provider.wireRequests.length, 1);
    const sent = JSON.parse(h.provider.wireRequests[0].raw) as {
      tools: {
        type: string;
        function: { name: string; parameters: Record<string, unknown> };
      }[];
    };
    const authored = (await readdir(join(h.app, "agent/tools")))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => name.slice(0, -3));
    assert.ok(authored.length >= 12);
    const names = sent.tools.map((tool) => tool.function.name);
    for (const name of [
      "todo",
      "load_skill",
      "ask_question",
      "connection_search",
      ...authored,
    ])
      assert.ok(names.includes(name), `full tool set includes ${name}`);
    assert.equal(new Set(names).size, names.length);
    for (const tool of sent.tools) {
      assert.equal(tool.type, "function");
      const schema = tool.function.parameters;
      assert.equal(schema.type, "object", tool.function.name);
      assert.ok(
        schema.properties &&
          typeof schema.properties === "object" &&
          !Array.isArray(schema.properties),
        tool.function.name,
      );
      for (const key of ["oneOf", "anyOf", "allOf"])
        assert.ok(
          !Object.hasOwn(schema, key),
          `${tool.function.name}: root ${key}`,
        );
    }

    const widgets = h.telegram.requests.filter(
      (r) => r.method === "sendWidget",
    );
    assert.equal(
      widgets.length,
      1,
      "the actual Widget request reached the refusing Bot API",
    );
    assert.match(String(widgets[0].body.html), /WIRE_HTML/u);
    for (const request of h.telegram.requests)
      assert.ok(
        !request.raw.includes(secret),
        `secret absent from ${request.method} HTTP bytes`,
      );
    assert.match(String(widgets[0].body.html), /REDACTED/u);
    const fallback = h.telegram.requests.filter(
      (r) =>
        r.method === "sendMessage" && String(r.body.text).includes(caption),
    );
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].topic, topic);
    assert.equal(String(fallback[0].chat), String(OWNER));
    assert.equal(widgets[0].topic, topic);
    assert.equal(String(widgets[0].chat), String(OWNER));
    assert.ok(
      h.telegram.requests.indexOf(fallback[0]) >
        h.telegram.requests.indexOf(widgets[0]),
    );
    assert.match(
      await readFile(join(h.root, "process.log"), "utf8"),
      /sendWidget.*400/u,
    );
    assert.ok((await readFile(join(h.app, ".env"), "utf8")).includes(secret));
    assert.ok(
      JSON.stringify(h.provider.requests[0]).includes("show the wire widget"),
    );
    await h.saveEvidence("wire");
    h.pass();
  },
);
