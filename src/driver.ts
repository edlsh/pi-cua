import type { CuaDriverLike, DriverMetadata } from "@trycua/cua-driver";

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

// Tools whose schema accepts a `session` label. Other tools reject unknown fields.
const SESSION_TOOLS = new Set([
  "get_window_state", "verify_state", "click", "double_click", "right_click", "drag", "type_text",
  "press_key", "hotkey", "set_value", "scroll", "invoke_menu", "set_window_frame", "get_desktop_state",
  "zoom", "clipboard_read", "clipboard_write", "get_screen_size", "get_cursor_position", "move_cursor",
  "get_browser_state", "browser_prepare", "browser_navigate", "browser_click", "browser_type",
  "browser_dialog", "browser_set_input_files", "browser_download", "browser_pointer", "parse_visual_regions",
]);

// The in-process runtime is a native dylib shared by every binding in this process.
let shared: Promise<CuaDriverLike> | undefined;
let users = 0;

async function createDriver(): Promise<CuaDriverLike> {
  if (process.platform !== "darwin") throw new DesktopError("unsupported_platform", "pi-desktop only supports macOS.");
  const { CuaDriver, DriverOptions } = await import("@trycua/cua-driver");
  return CuaDriver.create(DriverOptions.create({ claudeCodeCompatibility: false }));
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
  elements: Map<number, { role?: string; label?: string }>;
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
    shared ??= createDriver().catch(error => { shared = undefined; throw error; });
    const driver = await shared;
    if (!this.#driver) { this.#driver = driver; users++; }
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
    const payload = SESSION_TOOLS.has(tool) && args.session === undefined ? { ...args, session } : args;
    if (payload.session === session) this.#sessions.add(session);
    const json = JSON.stringify(payload);
    const options = signal ? { signal } : undefined;
    let raw = await driver.callTool(tool, json, options);
    // The driver ends a session after 300 s idle, both our label and the transport's implicit one that unlabeled
    // tools (list_windows, list_apps) use; /desktop reset ends the label. Ordinary calls never revive either.
    if (raw.errorCode === "session_ended") {
      const revive = typeof payload.session === "string" ? { session: payload.session } : {};
      const revived = await driver.callTool("start_session", JSON.stringify(revive), options);
      if (!revived.isError) raw = await driver.callTool(tool, json, options);
    }
    const parsed = parseJson(raw.structuredJson);
    const result: DriverResult = {
      tool, text: raw.text ?? "", json: parsed, isError: raw.isError,
      images: raw.images.filter(image => image.dataBase64).map(image => ({ data: image.dataBase64, mimeType: image.mimeType || "image/png" })),
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
    const elements = new Map<number, { role?: string; label?: string }>();
    for (const element of state.elements) {
      if (typeof element?.element_index === "number") elements.set(element.element_index, { role: element.role, label: element.label });
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
    return { loaded: Boolean(this.#driver), sessions: [...this.#sessions], snapshots: this.#snapshots.size, sharedUsers: users };
  }

  /** Ends this binding's driver sessions and forgets its snapshots. Keeps the shared runtime loaded. */
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

  /** Ends sessions and releases the shared runtime when no other binding uses it. */
  async shutdown(): Promise<void> {
    await this.reset();
    const driver = this.#driver;
    if (!driver) return;
    this.#driver = undefined;
    this.#metadata = undefined;
    if (--users > 0) return;
    shared = undefined;
    await driver.shutdown();
  }
}
