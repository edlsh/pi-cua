import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

export const root = fileURLToPath(new URL("../", import.meta.url));
export async function withLoader(paths, work) {
  const dir = await mkdtemp(join(tmpdir(), "pi-desktop-"));
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [...paths, join(root, "test/fixtures/pi-provider.mjs")] });
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    await work(loader, dir, settingsManager);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function withSession(work) {
  await withLoader([root], async (resourceLoader, dir, settingsManager) => {
    const errors = [];
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader, settingsManager,
      sessionManager: SessionManager.inMemory(dir), noTools: true });
    try {
      await session.bindExtensions({ mode: "json", onError: error => errors.push(error) });
      const model = session.modelRuntime.getModel("desktop-fixture", "fixture");
      assert.ok(model, "Fixture provider must register before prompting");
      await session.setModel(model);
      const run = async (name, args) => {
        const before = session.messages.filter(message => message.role === "toolResult").length;
        await session.prompt(JSON.stringify([{ name, args }]));
        const result = session.messages.filter(message => message.role === "toolResult")[before];
        assert.ok(result, `No result for ${name}`);
        return { ...result, text: result.content.filter(part => part.type === "text").map(part => part.text).join("\n") };
      };
      await work({ session, run, dir });
      assert.deepEqual(errors, []);
    } finally {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
  });
}
