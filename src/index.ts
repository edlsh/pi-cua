import { createDesktopCore, formatSessionLabel, type DesktopHostAdapter, type DesktopOptions } from "@edlsh/cua-core";
import type { DesktopAPI, PromptEvent } from "./host.ts";

export { DesktopBackend, JEV_PROMPT, pruneScreenshots, redactTree, type DesktopOptions } from "@edlsh/cua-core";

export const DESKTOP_PROMPT = "For native macOS apps and windows, use desktop_observe and desktop_act (pi-cua), not AppleScript or shell UI scripting. Loop: desktop_observe action=state (use query to find a control) → desktop_act by [N] index, batching steps → read the returned state. Request screenshots only when the element tree is not enough.";

export function sessionLabel(sessionId: string, profile = process.env.PI_PROFILE || "default"): string {
  return formatSessionLabel("pi", sessionId, profile);
}

const ADAPTER: DesktopHostAdapter = {
  packageName: "pi-cua",
  sessionPrefix: "pi",
  profileEnvVar: "PI_PROFILE",
  defaultAgentDirHost: "pi",
  connectionSymbol: "pi-cua.cua-driver",
  desktopPrompt: DESKTOP_PROMPT,
  appendSystemPrompt(event: PromptEvent, lines: string[]): undefined {
    event.systemPromptOptions?.promptGuidelines.push(...lines);
    return undefined;
  },
  hasSessionSwitch: false,
};

export function createDesktopExtension(options: DesktopOptions = {}): (pi: DesktopAPI) => void {
  return createDesktopCore(ADAPTER, options);
}

export default createDesktopExtension();
