import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, validateToolArguments } from "@earendil-works/pi-ai";
import { root, withLoader, withSession } from "./pi-harness.mjs";

test("pi discovers the package and its tools without a local loader", async () => {
  await withLoader([root], async loader => {
    const { extensions, errors } = loader.getExtensions();
    assert.deepEqual(errors, []);
    assert.equal(extensions.flatMap(extension => [...extension.tools.keys()]).filter(name => name === "desktop_observe").length, 1);
  });
});

test("pi's validator enforces drag coordinates and exact tuple length", async () => {
  await withLoader([join(root, "src/index.ts")], async loader => {
    assert.deepEqual(loader.getExtensions().errors, []);
    const tool = loader.getExtensions().extensions.find(extension => extension.tools.has("desktop_act")).tools.get("desktop_act").definition;
    const validate = from => validateToolArguments(tool, { id: "drag", name: tool.name, arguments: { steps: [{ op: "drag", from, to: [3, 4] }] } });
    assert.deepEqual(validate([1, 2]).steps[0].from, [1, 2]);
    for (const invalid of [[], [1], [1, 2, 3], ["bad", 2]]) assert.throws(() => validate(invalid));
  });
});

test("real pi turns execute desktop tools, preserve error flags, and compose prompt guidelines", async () => {
  await withLoader([join(root, "src/index.ts")], async (resourceLoader, dir, settingsManager) => {
    const errors = [];
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader, settingsManager,
      sessionManager: SessionManager.inMemory(dir), noTools: true });
    try {
      await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
      await session.setModel(session.modelRuntime.getModel("desktop-fixture", "fixture"));
      await session.prompt(JSON.stringify([
        { name: "desktop_act", args: { steps: [{ op: "wait", ms: 1 }], observe: false } },
        { name: "desktop_driver", args: { tool: "set_config", args: {} } },
        { name: "desktop_observe", args: { action: "not-an-action" } },
      ]));
      const results = session.messages.filter(message => message.role === "toolResult");
      assert.equal(results.length, 3);
      assert.equal(results[0].isError, false);
      assert.match(results[0].content[0].text, /wait 1ms.*ok/);
      assert.equal(results[1].isError, true);
      assert.match(results[1].content[0].text, /blocked_tool/);
      assert.equal(results[2].isError, true);
      assert.match(getCurrentSystemPrompt(session.messages), /native macOS apps and windows/);
      assert.deepEqual(errors, []);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
  });
});
