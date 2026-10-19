import type { CuaDriverLike, DriverMetadata } from "@trycua/cua-driver";
import { execFile } from "node:child_process";
import sharp from "sharp";

export const SUPPORTED_CONTRACT = "0.8.";

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

async function compressScreenshot(image: DriverImage): Promise<DriverImage> {
  if (image.data.length <= MAX_SCREENSHOT_BASE64_BYTES) return image;
  const input = Buffer.from(image.data, "base64");
  try {
    // Re-encode without resizing: screenshots and driver click coordinates must agree.
    for (const quality of [85, 70, 55]) {
      const encoded = await sharp(input, { limitInputPixels: 32_000_000 })
        .webp({ quality })
        .toBuffer();
      const data = encoded.toString("base64");
      if (data.length <= MAX_SCREENSHOT_BASE64_BYTES) return { data, mimeType: "image/webp" };
    }
  } catch {
    throw new DesktopError("screenshot_encoding_failed", "Could not compress the screenshot. Request a smaller max_image_dimension.");
  }
  throw new DesktopError("screenshot_too_large", "Screenshot exceeds the 1 MB inline image budget. Request a smaller max_image_dimension.");
}

// Tools whose schema accepts a `session` label. Other tools reject unknown fields.
const SESSION_TOOLS = new Set([
  "get_window_state", "verify_state", "click", "double_click", "right_click", "drag", "type_text",
  "press_key", "hotkey", "set_value", "scroll", "invoke_menu", "set_window_frame", "get_desktop_state",
  "zoom", "clipboard_read", "clipboard_write", "get_screen_size", "get_cursor_position", "move_cursor",
  "get_browser_state", "browser_prepare", "browser_navigate", "browser_click", "browser_type",
  "browser_dialog", "browser_set_input_files", "browser_download", "browser_pointer", "parse_visual_regions",
]);

// Since 0.35 a get_window_state read returns only compact markdown. Snapshots need the structured `elements`
// (element tokens, values), and truncation notes need the walk diagnostics that `verbose` restores.
const STATE_DEFAULTS = { tree_format: "both", verbose: true };

// One connection to the CuaDriver.app daemon for the life of this process. The daemon binds a session label to the
// connection that started it, so reconnecting after /reload could not revive this conversation's label. Pi re-imports
// extension modules on /reload, so the connection lives on globalThis rather than in module state.
const CONNECTION = Symbol.for("pi-cua.cua-driver");
const connections = globalThis as { [CONNECTION]?: Promise<CuaDriverLike> };

const DAEMON_START_MS = 15_000;

// The CuaDriver.app daemon owns the Accessibility/Screen Recording grants and draws the agent cursor. Start it through
// LaunchServices when it is not running, so macOS attributes it to the app; never fall back to the in-process runtime.
async function createDriver(): Promise<CuaDriverLike> {
  if (process.platform !== "darwin") throw new DesktopError("unsupported_platform", "pi-cua only supports macOS.");
  const { CuaDriver } = await import("@trycua/cua-driver");
  const driver = CuaDriver.connect(undefined);
  if (driver.isAvailable()) return driver;
  const launched = await new Promise<boolean>(resolve => {
    execFile("/usr/bin/open", ["-n", "-g", "-a", "CuaDriver", "--args", "serve"], error => resolve(!error));
  });
  if (launched) {
    for (const deadline = Date.now() + DAEMON_START_MS; Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (driver.isAvailable()) return driver;
    }
  }
  throw new DesktopError("driver_unavailable", launched
    ? "CuaDriver.app did not start serving within 15 s. Check `cua-driver status` and `cua-driver doctor`."
    : "CuaDriver.app is not installed. Install it with the official installer (https://cua.ai/driver/install.sh), then grant permissions with `cua-driver permissions grant`.");
}

// The daemon throws some refusals (e.g. `permissions_pending` until macOS grants land) instead of returning an error
// result; the thrown DriverError's message is only its variant name, so surface the inner message and code.
function driverError(error: unknown): unknown {
  const message = (error as { inner?: { message?: unknown } })?.inner?.message;
  if (typeof message !== "string") return error;
  return new DesktopError(/^([a-z_]+):/.exec(message)?.[1] ?? "driver_error", message);
}

function parseJson(raw: string | undefined): Record<string, any> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  }
  catch { return undefined; }
}

export interface Snapshot {
  pid: number;
  windowId: number;
  snapshotId: string;
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
  #metadata: DriverMetadata | undefined;
  #inputSchemas: Map<string, string> | undefined;
  lastTarget: { pid: number; windowId: number } | undefined;

  async #acquire(): Promise<CuaDriverLike> {
    if (this.#driver) return this.#driver;
    connections[CONNECTION] ??= createDriver().catch(error => { connections[CONNECTION] = undefined; throw error; });
    const driver = await connections[CONNECTION];
    this.#driver ??= driver;
    return driver;
  }

  async metadata(): Promise<DriverMetadata> {
    this.#metadata ??= await (await this.#acquire()).metadata();
    return this.#metadata;
  }

  /** A driver tool's JSON input schema. The driver reports missing arguments one per call, so errors attach this instead. */
  async inputSchema(tool: string): Promise<string | undefined> {
    if (!this.#inputSchemas) {
      const listed = JSON.parse(await (await this.#acquire()).listToolsJson());
      const tools: { name?: string; inputSchema?: Record<string, any> }[] = Array.isArray(listed) ? listed : listed?.tools ?? [];
      this.#inputSchemas = new Map(tools.flatMap(entry => typeof entry?.name === "string" ? [[entry.name, JSON.stringify(entry.inputSchema ?? {})] as const] : []));
    }
    return this.#inputSchemas.get(tool);
  }

  async call(tool: string, args: Record<string, unknown>, session: string, signal?: AbortSignal): Promise<DriverResult> {
    signal?.throwIfAborted();
    const driver = await this.#acquire();
    const shaped = tool === "get_window_state" ? { ...STATE_DEFAULTS, ...args } : args;
    const payload = SESSION_TOOLS.has(tool) && shaped.session === undefined ? { ...shaped, session } : shaped;
    if (payload.session === session) this.#sessions.add(session);
    const json = JSON.stringify(payload);
    const options = signal ? { signal } : undefined;
    const callTool = (name: string, body: string) => driver.callTool(name, body, options).catch(error => {
      // The daemon throws an ended session (numeric code, plain message) that the in-process runtime returned as a
      // `session_ended` result; restore that result so the revive below handles both.
      const message = (error as { inner?: { message?: unknown } })?.inner?.message;
      if (typeof message === "string" && message.startsWith("session has ended")) {
        return { text: message, isError: true, errorCode: "session_ended", images: [] } as unknown as Awaited<ReturnType<CuaDriverLike["callTool"]>>;
      }
      throw driverError(error);
    });
    let raw = await callTool(tool, json);
    // The driver ends a session after 300 s idle, both our label and the transport's implicit one that unlabeled
    // tools (list_windows, list_apps) use; /desktop reset ends the label. Ordinary calls never revive either.
    if (raw.errorCode === "session_ended") {
      const revive = typeof payload.session === "string" ? { session: payload.session } : {};
      const revived = await callTool("start_session", JSON.stringify(revive));
      if (!revived.isError) raw = await callTool(tool, json);
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
    const pid = Number(state.pid), windowId = Number(state.window_id);
    if (!Number.isFinite(pid) || !Number.isFinite(windowId)) return;
    this.lastTarget = { pid, windowId };
    if (typeof state.capture_id === "string") this.#captures.set(`${pid}:${windowId}`, state.capture_id);
    else this.#captures.delete(`${pid}:${windowId}`);
    // A screenshot-only walk still mints a snapshot, but with no elements; keep the last tree so indices stay usable.
    if (args.include_accessibility_tree === false || typeof state.snapshot_id !== "string" || !Array.isArray(state.elements)) return;
    const elements = new Map<number, { role?: string; label?: string; token?: string }>();
    for (const element of state.elements) {
      if (typeof element?.element_index === "number") elements.set(element.element_index, { role: element.role, label: element.label, token: element.element_token });
    }
    const { include_screenshot: _image, max_image_dimension: _size, session: _session, ...walk } = args;
    this.#snapshots.set(`${pid}:${windowId}`, { pid, windowId, snapshotId: state.snapshot_id, elements, walk });
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

  /** Ends this binding's driver sessions and forgets its snapshots. Keeps the shared connection. */
  async reset(): Promise<void> {
    const driver = this.#driver;
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    this.#snapshots.clear();
    this.#captures.clear();
    this.lastTarget = undefined;
    if (!driver) return;
    await Promise.allSettled(sessions.map(session => driver.callTool("end_session", JSON.stringify({ session }))));
  }

  /** Ends this binding's sessions and detaches it. The process keeps its daemon connection; the daemon keeps running. */
  async shutdown(): Promise<void> {
    await this.reset();
    this.#driver = undefined;
    this.#metadata = undefined;
  }
}
