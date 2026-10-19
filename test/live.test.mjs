import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { root, withSession } from "./pi-harness.mjs";

const exec = promisify(execFile);
const actEnabled = process.env.SMOKE_ACT === "1";
const indexOf = (text, role, label) => {
  const line = text.split(/\n(?=\s*- )/).find(line => /^\s*- \[\d+\]/.test(line) && line.includes(role) && line.includes(label));
  const index = line?.match(/\[(\d+)\]/)?.[1];
  assert.ok(index, `Missing ${role} ${label}:\n${text}`);
  return Number(index);
};
const ok = result => { assert.equal(result.isError, false, result.text); return result; };

test("live pi desktop: isolated native window, observations, images, actions, reset, and reload", { timeout: 120000 }, async () => {
  assert.equal(process.platform, "darwin", "The live suite requires macOS");
  await withSession(async ({ session, run, dir }) => {
    const app = join(homedir(), "Applications", `DesktopFixture-${dir.split("/").at(-1)}.app`);
    const executable = join(app, "Contents/MacOS/DesktopFixture");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await writeFile(join(app, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleExecutable</key><string>DesktopFixture</string>
      <key>CFBundleIdentifier</key><string>dev.pi.desktop-fixture</string>
      <key>CFBundleName</key><string>DesktopFixture</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleVersion</key><string>1.0.0</string>
      <key>CFBundleShortVersionString</key><string>1.0.0</string>
      <key>NSPrincipalClass</key><string>NSApplication</string>
      </dict></plist>`);
    await exec("swiftc", [join(root, "test/fixtures/DesktopFixture.swift"), "-o", executable], { timeout: 60000 });
    const registrar = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    await exec(registrar, ["-f", app]);
    const child = spawn(executable, [], { stdio: "ignore" });
    try {
      const permissions = ok(await run("desktop_observe", { action: "permissions" }));
      assert.match(permissions.text, /Accessibility: granted/);
      assert.match(permissions.text, /Screen Recording: granted/);
      let windows;
      for (let attempt = 0; attempt < 30; attempt++) {
        windows = ok(await run("desktop_observe", { action: "windows", pid: child.pid, all: true }));
        if (windows.text.includes("pi-cua Test Fixture")) break;
        await sleep(100);
      }
      const windowId = Number(windows.text.split("\n").find(line => line.includes("pi-cua Test Fixture"))?.match(/window_id=(\d+)/)?.[1]);
      assert.ok(Number.isFinite(windowId), windows.text);
      const target = { pid: child.pid, window_id: windowId };
      assert.match(ok(await run("desktop_observe", { action: "apps" })).text, /DesktopFixture/);
      let state;
      for (let attempt = 0; attempt < 30; attempt++) {
        state = ok(await run("desktop_observe", { action: "state", ...target, max_elements: 120 }));
        if (state.text.includes("Count 0")) break;
        await sleep(100);
      }
      assert.match(state.text, /Count 0/);
      assert.doesNotMatch(state.text, /fixture-placeholder/);
      const queried = ok(await run("desktop_observe", { action: "state", ...target, query: "Increment" }));
      assert.match(queried.text, /Increment/);
      // Screenshot-only walks must not erase the query's actionable snapshot.
      const screenshot = ok(await run("desktop_observe", { action: "screenshot", ...target, max_image_dimension: 800 }));
      const image = screenshot.content.find(part => part.type === "image");
      assert.ok(image, screenshot.text);
      assert.equal(Buffer.from(image.data, "base64").subarray(1, 4).toString(), "PNG");
      assert.ok(Buffer.from(image.data, "base64").readUInt32BE(16) <= 800);
      if (!actEnabled) return;

      state = ok(await run("desktop_act", { ...target, steps: [{ op: "click", index: indexOf(queried.text, "AXButton", "Increment") }],
        verify: [{ role: "AXStaticText", value: "Count 1" }] }));
      assert.match(state.text, /Count 1/);
      state = ok(await run("desktop_act", { ...target, steps: [{ op: "set_value", index: indexOf(state.text, "AXTextField", "Test input"), value: "pi ✓ 日本語" }] }));
      assert.match(state.text, /pi ✓ 日本語/);
      state = ok(await run("desktop_act", { ...target, steps: [
        { op: "type", index: indexOf(state.text, "AXTextField", "Test input"), text: "discard" },
        { op: "hotkey", keys: ["cmd", "a"], index: indexOf(state.text, "AXTextField", "Test input"), delivery: "foreground" }, { op: "wait", ms: 100 }, { op: "type", text: "typed ✓" }, { op: "key", key: "tab", delivery: "foreground" },
      ] }));
      assert.match(state.text, /AXTextField = "typed ✓" \(Test input\)/);
      state = ok(await run("desktop_act", { ...target, steps: [{ op: "scroll", index: indexOf(state.text, "AXTextArea", "Test rows"), direction: "down", amount: 3, by: "line" }] }));
      state = ok(await run("desktop_act", { ...target, steps: [{ op: "focus" }, { op: "wait", ms: 100 }, { op: "menu", path: ["File", "Reset"] }, { op: "wait", ms: 250 }], verify: [{ role: "AXStaticText", value: "Count 0" }] }));
      assert.match(state.text, /Count 0/);
      state = ok(await run("desktop_observe", { action: "state", ...target, screenshot: true, max_image_dimension: 800 }));
      const scale = Buffer.from(state.content.find(part => part.type === "image").data, "base64").readUInt32BE(16) / 660;
      state = ok(await run("desktop_act", { ...target, steps: [{ op: "click", x: 84 * scale, y: 66 * scale }] }));
      assert.match(state.text, /Count 1/);
      assert.ok(state.content.some(part => part.type === "image"), "Pixel actions must return a current screenshot");
      state = ok(await run("desktop_act", { ...target, steps: [{ op: "double_click", index: indexOf(state.text, "AXButton", "Increment"), delivery: "foreground" }, { op: "wait", ms: 200 }] }));
      assert.ok(Number(state.text.match(/Count (\d+)/)?.[1]) > 1, state.text);
      state = ok(await run("desktop_act", { ...target, steps: [{ op: "right_click", index: indexOf(state.text, "AXTextField", "Test input"), delivery: "foreground" }, { op: "wait", ms: 100 }, { op: "key", key: "escape", delivery: "foreground" }] }));
      const countAfterClicks = state.text.match(/Count (\d+)/)?.[0];
      // Drag the slider knob as an agent would: from the window's bounds and a screenshot, with default delivery.
      const sliderValue = text => Number(text.match(/AXSlider \(Test slider\) = "([\d.]+)"/)?.[1]);
      assert.equal(sliderValue(state.text), 2, state.text);
      const bounds = ok(await run("desktop_observe", { action: "windows", pid: child.pid, all: true })).text.split("\n")
        .find(line => line.includes("pi-cua Test Fixture")).match(/(\d+)x(\d+)\+/).slice(1).map(Number);
      const shot = await run("desktop_observe", { action: "screenshot", ...target, max_image_dimension: 800 });
      const pixels = Buffer.from(shot.content.find(part => part.type === "image").data, "base64").readUInt32BE(16) / bounds[0];
      const sliderY = (bounds[1] - 294) * pixels; // the slider's center sits 294pt above the window's bottom edge
      state = ok(await run("desktop_act", { ...target, steps: [{ op: "drag", from: [104 * pixels, sliderY], to: [344 * pixels, sliderY], duration_ms: 300 }, { op: "wait", ms: 200 }] }));
      assert.ok(sliderValue(state.text) > 6, state.text);
      state = ok(await run("desktop_act", { ...target, steps: [{ op: "resize", x: 200, y: 200, width: 700, height: 550 }, { op: "wait", ms: 500 }] }));
      const resized = ok(await run("desktop_observe", { action: "windows", pid: child.pid, all: true })).text.split("\n").find(line => line.includes("pi-cua Test Fixture"));
      const dimensions = resized.match(/(\d+)x(\d+)\+(\d+)\+(\d+)/);
      assert.ok(dimensions, resized);
      assert.ok([700, 550, 200, 200].every((value, index) => Math.abs(Number(dimensions[index + 1]) - value) <= 2), resized);
      const launched = ok(await run("desktop_act", { steps: [{ op: "launch", bundle_id: "dev.pi.desktop-fixture" }], observe: false }));
      assert.ok(launched.text.includes(`window_id=${windowId}`), launched.text);
      await session.prompt("/desktop reset");
      const stale = await run("desktop_act", { ...target, steps: [{ op: "click", index: 1 }], observe: false });
      assert.equal(stale.isError, true);
      assert.match(stale.text, /no_snapshot/);
      state = ok(await run("desktop_observe", { action: "state", ...target }));
      assert.ok(state.text.includes(countAfterClicks), state.text);
      await session.reload();
      state = ok(await run("desktop_observe", { action: "state", ...target }));
      assert.ok(state.text.includes(countAfterClicks), state.text);
      const screen = ok(await run("desktop_driver", { tool: "get_screen_size" }));
      assert.match(screen.text, /\d+x\d+ points/);
    } finally {
      child.kill("SIGTERM");
      await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", resolve); });
      await exec(registrar, ["-u", app]);
      await rm(app, { recursive: true, force: true });
    }
  });
});
