import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { CuaDriverLike, DriverMetadata, ToolResult } from "@trycua/cua-driver";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const SUPPORTED_CONTRACT = "0.9.";
/** The @trycua/cua-driver SDK version this package pins. */
export const SDK_VERSION = z.string().parse(createRequire(import.meta.url)("../package.json").dependencies["@trycua/cua-driver"]);

export interface DriverImage { data: string; mimeType: string }

export interface DriverResult {
  tool: string;
  text: string;
  json?: Record<string, any>;
  images: DriverImage[];
  isError: boolean;
  errorCode?: string;
}

export class DesktopError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DesktopError";
  }
}

const MAX_SCREENSHOT_BASE64_BYTES = 1_000_000;

// Re-encode oversized screenshots with macOS's built-in sips (JPEG) so the package needs no native image runtime dependency.
async function compressScreenshot(image: DriverImage): Promise<DriverImage> {
  if (image.data.length <= MAX_SCREENSHOT_BASE64_BYTES) return image;
  const dir = await mkdtemp(join(tmpdir(), "pi-cua-"));
  try {
    const input = join(dir, "screenshot");
    await writeFile(input, Buffer.from(image.data, "base64"));
    // Re-encode without resizing: screenshots and driver click coordinates must agree.
    for (const quality of [85, 70, 55]) {
      const output = join(dir, `${quality}.jpg`);
      await execFileAsync("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), input, "--out", output]);
      const data = (await readFile(output)).toString("base64");
      if (data.length <= MAX_SCREENSHOT_BASE64_BYTES) return { data, mimeType: "image/jpeg" };
    }
  } catch {
    throw new DesktopError("screenshot_encoding_failed", "Could not compress the screenshot. Request a smaller max_image_dimension.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  throw new DesktopError("screenshot_too_large", "Screenshot exceeds the 1 MB inline image budget. Request a smaller max_image_dimension.");
}

// Fallback allowlist when listToolsJson() omits a tool's property schema. Live schemas from the daemon take precedence.
const FALLBACK_SESSION_TOOLS = new Set([
  "get_window_state", "verify_state", "click", "double_click", "right_click", "drag", "type_text",
  "press_key", "hotkey", "set_value", "scroll", "invoke_menu", "set_window_frame", "get_desktop_state",
  "zoom", "clipboard_read", "clipboard_write", "get_screen_size", "get_cursor_position", "move_cursor",
  "get_browser_state", "browser_prepare", "browser_navigate", "browser_motion_policy", "browser_click",
  "browser_type", "browser_select", "browser_dialog", "browser_set_input_files", "browser_download",
  "browser_pointer", "parse_visual_regions", "set_agent_cursor_enabled", "set_agent_cursor_motion",
  "set_agent_cursor_theme", "set_agent_cursor_badge", "get_agent_cursor_state", "start_recording",
  "stop_recording", "get_recording_state", "page", "agent_display", "run_steps", "run_script",
  "health_report", "get_guide", "get_session", "check_for_update",
]);

/** Safe read-only tools that can retry once after a daemon reconnect without risking duplicate side effects. */
const RETRYABLE_ON_RECONNECT = new Set([
  "list_windows", "list_apps", "get_window_state", "get_desktop_state", "verify_state",
  "check_permissions", "health_report", "get_screen_size", "get_cursor_position", "get_config",
  "get_session", "list_sessions", "get_guide", "get_agent_cursor_state", "get_recording_state",
]);

// Since 0.35 a get_window_state read returns only compact markdown. Snapshots need the structured `elements`
// (element tokens, values), and truncation notes need the walk diagnostics that `verbose` restores.
const STATE_DEFAULTS = { tree_format: "both", verbose: true };

// One connection to the CuaDriver.app daemon for the life of this process. The daemon binds a session label to the
// connection that started it, so reconnecting after /reload could not revive this conversation's label. Pi re-imports
// extension modules on /reload, so the connection lives on globalThis rather than in module state.
const CONNECTION = Symbol.for("pi-cua.cua-driver");
interface ConnectionHolder { [CONNECTION]?: Promise<CuaDriverLike> }
// SAFETY: only this module reads or writes the CONNECTION symbol property on globalThis.
const connections = globalThis as typeof globalThis & ConnectionHolder;

const DAEMON_START_MS = 15_000;

// The CuaDriver.app daemon owns the Accessibility/Screen Recording grants and draws the agent cursor. Start it through
// LaunchServices when it is not running, so macOS attributes it to the app; never fall back to the in-process runtime.
async function createDriver(): Promise<CuaDriverLike> {
  if (process.platform !== "darwin") throw new DesktopError("unsupported_platform", "pi-cua only supports macOS.");
  // Dynamic on purpose: the SDK's native addon ships only for supported platforms, so it loads after the platform check.
  const { CuaDriver } = await import("@trycua/cua-driver");
  const driver = CuaDriver.connect(undefined);
  if (driver.isAvailable()) return driver;
  const { promise: launch, resolve } = Promise.withResolvers<boolean>();
  execFile("/usr/bin/open", ["-n", "-g", "-a", "CuaDriver", "--args", "serve"], error => resolve(!error));
  const launched = await launch;
  if (launched) {
    for (const deadline = Date.now() + DAEMON_START_MS; Date.now() < deadline;) {
      await sleep(250);
      if (driver.isAvailable()) return driver;
    }
  }
  throw new DesktopError("driver_unavailable", launched
    ? "CuaDriver.app did not start serving within 15 s. Check `cua-driver status` and `cua-driver doctor`."
    : "CuaDriver.app is not installed. Install it with the official installer (https://cua.ai/driver/install.sh), then grant permissions with `cua-driver permissions grant`.");
}

/** A thrown daemon DriverError's own message is only its variant name; the real message is in `inner`. */
function innerMessage(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("inner" in cause)) return undefined;
  const inner = cause.inner;
  if (typeof inner !== "object" || inner === null || !("message" in inner)) return undefined;
  return typeof inner.message === "string" ? inner.message : undefined;
}

function parseJson(raw: string | undefined): Record<string, any> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  }
  catch { return undefined; }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface ToolCatalog {
  schemas: Map<string, string>;
  sessionTools: Map<string, boolean>;
}

export interface Snapshot {
  pid: number;
  windowId: number;
  snapshotId: string;
  revision?: number;
  elements: Map<number, { role?: string; label?: string; token?: string }>;
  /** Tree-walk arguments that produced this snapshot; re-walking with them keeps indices comparable. */
  walk: Record<string, unknown>;
}

export class DesktopBackend {
  #driver: CuaDriverLike | undefined;
  #sessions = new Set<string>();
  #snapshots = new Map<string, Snapshot>();
  /** The driver's newest screenshot capture per window; a click at x,y can name it when the snapshot holds no screenshot. */
  #captures = new Map<string, string>();
  #catalogPromise: Promise<ToolCatalog> | undefined;
  lastTarget: { pid: number; windowId: number } | undefined;

  async #dropConnection(dead: CuaDriverLike | undefined): Promise<void> {
    if (this.#driver === dead) this.#driver = undefined;
    this.#catalogPromise = undefined;
    const shared = connections[CONNECTION];
    if (!shared || !dead) return;
    const resolved = await shared.catch(() => undefined);
    if (resolved === dead && connections[CONNECTION] === shared) connections[CONNECTION] = undefined;
  }

  async #acquire(): Promise<CuaDriverLike> {
    if (this.#driver) {
      if (this.#driver.isAvailable()) return this.#driver;
      await this.#dropConnection(this.#driver);
    }
    if (connections[CONNECTION]) {
      const existing = await connections[CONNECTION].catch(() => undefined);
      if (existing && !existing.isAvailable()) await this.#dropConnection(existing);
    }
    connections[CONNECTION] ??= createDriver().catch(error => { connections[CONNECTION] = undefined; throw error; });
    const driver = await connections[CONNECTION];
    this.#driver = driver;
    return driver;
  }

  async #catalog(driver: CuaDriverLike): Promise<ToolCatalog> {
    if (!this.#catalogPromise) {
      this.#catalogPromise = driver.listToolsJson().then(raw => {
        const listed = JSON.parse(raw);
        const tools: { name?: string; input_schema?: Record<string, any>; inputSchema?: Record<string, any> }[] =
          Array.isArray(listed) ? listed : listed?.tools ?? [];
        const schemas = new Map<string, string>();
        const sessionTools = new Map<string, boolean>();
        for (const entry of tools) {
          if (typeof entry?.name !== "string") continue;
          const schema = entry.input_schema ?? entry.inputSchema;
          schemas.set(entry.name, JSON.stringify(schema ?? {}));
          if (schema?.properties && typeof schema.properties === "object") {
            sessionTools.set(entry.name, Object.hasOwn(schema.properties, "session"));
          }
        }
        return { schemas, sessionTools };
      }).catch(() => ({ schemas: new Map<string, string>(), sessionTools: new Map<string, boolean>() }));
    }
    return this.#catalogPromise;
  }

  async metadata(): Promise<DriverMetadata> {
    const driver = await this.#acquire();
    try { return await driver.metadata(); }
    catch (cause) {
      if (!driver.isAvailable()) {
        await this.#dropConnection(driver);
        return (await this.#acquire()).metadata();
      }
      throw cause;
    }
  }

  /** A driver tool's JSON input schema. The driver reports missing arguments one per call, so errors attach this instead. */
  async inputSchema(tool: string): Promise<string | undefined> {
    const driver = await this.#acquire();
    return (await this.#catalog(driver)).schemas.get(tool);
  }

  async call(tool: string, args: Record<string, unknown>, session: string, signal?: AbortSignal): Promise<DriverResult> {
    signal?.throwIfAborted();
    let driver = await this.#acquire();
    const catalog = await this.#catalog(driver);
    const acceptsSession = catalog.sessionTools.get(tool) ?? FALLBACK_SESSION_TOOLS.has(tool);
    const shaped = tool === "get_window_state" ? { ...STATE_DEFAULTS, ...args } : args;
    const payload = acceptsSession && shaped.session === undefined ? { ...shaped, session } : shaped;
    if (payload.session === session) this.#sessions.add(session);
    const json = JSON.stringify(payload);
    const options = signal ? { signal } : undefined;
    const invoke = (targetDriver: CuaDriverLike, name: string, body: string) => targetDriver.callTool(name, body, options).catch((cause: unknown): ToolResult => {
      const message = innerMessage(cause);
      // The daemon throws an ended session (numeric code, plain message) that the in-process runtime returned as a
      // `session_ended` result; restore that result so the revive below handles both.
      if (message?.startsWith("session has ended")) {
        return { text: message, images: [], isError: true, errorCode: "session_ended", degraded: false, rawJson: "" };
      }
      // The daemon also throws some refusals (e.g. `permissions_pending` until macOS grants land) instead of returning
      // an error result; surface their message and code.
      throw message === undefined ? cause : new DesktopError(/^([a-z_]+):/.exec(message)?.[1] ?? "driver_error", message);
    });
    let raw: ToolResult;
    try {
      raw = await invoke(driver, tool, json);
    } catch (cause) {
      if (signal?.aborted || driver.isAvailable()) throw cause;
      await this.#dropConnection(driver);
      if (!RETRYABLE_ON_RECONNECT.has(tool)) throw cause;
      driver = await this.#acquire();
      raw = await invoke(driver, tool, json);
    }
    // The driver ends a session after 300 s idle, both our label and the transport's implicit one that unlabeled
    // tools (list_windows, list_apps) use; /desktop reset ends the label. Ordinary calls never revive either.
    if (raw.errorCode === "session_ended") {
      const revive = typeof payload.session === "string" ? { session: payload.session } : {};
      const revived = await invoke(driver, "start_session", JSON.stringify(revive));
      if (!revived.isError) raw = await invoke(driver, tool, json);
    }
    const parsed = parseJson(raw.structuredJson);
    const result: DriverResult = {
      tool, text: raw.text ?? "", json: parsed, isError: raw.isError,
      images: await Promise.all(raw.images.filter(image => image.dataBase64).map(image => compressScreenshot({ data: image.dataBase64, mimeType: image.mimeType || "image/png" }))),
      ...(raw.errorCode ? { errorCode: raw.errorCode } : {}),
    };
    if (tool === "get_window_state" && parsed && !raw.isError) this.#remember(parsed, args);
    return result;
  }

  #remember(state: Record<string, any>, args: Record<string, unknown>): void {
    const pid = finiteNumber(state.pid), windowId = finiteNumber(state.window_id);
    if (pid === undefined || windowId === undefined) return;
    this.lastTarget = { pid, windowId };
    if (typeof state.capture_id === "string") this.#captures.set(`${pid}:${windowId}`, state.capture_id);
    else this.#captures.delete(`${pid}:${windowId}`);
    // A screenshot-only walk still mints a snapshot, but with no elements; keep the last tree so indices stay usable.
    if (args.include_accessibility_tree === false || typeof state.snapshot_id !== "string" || !Array.isArray(state.elements)) return;
    // A diff/no_change response omits unchanged elements; avoid clobbering the stored element map with an empty array.
    if ((state.since_status === "no_change" || state.since_status === "diff") && state.elements.length === 0) return;
    const elements = new Map<number, { role?: string; label?: string; token?: string }>();
    for (const element of state.elements) {
      if (typeof element?.element_index === "number") elements.set(element.element_index, { role: element.role, label: element.label, token: element.element_token });
    }
    const { include_screenshot: _image, max_image_dimension: _size, session: _session, since: _since, ...walk } = args;
    const revision = finiteNumber(state.ui_tree_revision);
    this.#snapshots.set(`${pid}:${windowId}`, { pid, windowId, snapshotId: state.snapshot_id, ...(revision !== undefined ? { revision } : {}), elements, walk });
  }

  snapshot(pid: number, windowId: number): Snapshot | undefined {
    return this.#snapshots.get(`${pid}:${windowId}`);
  }

  capture(pid: number, windowId: number): string | undefined {
    return this.#captures.get(`${pid}:${windowId}`);
  }

  status() {
    return { loaded: Boolean(this.#driver), sessions: [...this.#sessions], snapshots: this.#snapshots.size };
  }

  /** Ends this binding's driver sessions and forgets its snapshots. Drops a dead daemon connection so the next call reconnects. */
  async reset(): Promise<void> {
    const driver = this.#driver;
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    this.#snapshots.clear();
    this.#captures.clear();
    this.#catalogPromise = undefined;
    this.lastTarget = undefined;
    if (!driver) return;
    if (!driver.isAvailable()) {
      await this.#dropConnection(driver);
      return;
    }
    await Promise.allSettled(sessions.map(session => driver.callTool("end_session", JSON.stringify({ session }))));
  }

  /** Ends this binding's sessions and detaches it. The process keeps a live daemon connection; the daemon keeps running. */
  async shutdown(): Promise<void> {
    await this.reset();
    this.#driver = undefined;
    this.#catalogPromise = undefined;
  }
}
