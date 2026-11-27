import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Reply = Partial<{ text: string; json: unknown; isError: boolean; errorCode: string; image: string }>;
type Handler = (args: Record<string, any>) => Reply | Promise<Reply>;

const calls: { tool: string; args: Record<string, any> }[] = [];
let handlers: Record<string, Handler> = {};

let driverAvailable = true;
let driverVersion = "0.34.0";
let driverPid = 1;
let listedTools: Record<string, unknown>[] = [
  { name: "page", input_schema: { required: ["action", "pid", "window_id"], properties: { action: {}, pid: {}, window_id: {}, session: {} } } },
  { name: "list_windows", input_schema: { properties: { app: {}, pid: {}, on_screen_only: {} } } },
  { name: "list_sessions", input_schema: { properties: { cursor: {}, limit: {} } } },
  { name: "browser_select", input_schema: { properties: { target_id: {}, tab_id: {}, ref: {}, value: {}, session: {} } } },
  { name: "set_agent_cursor_enabled", input_schema: { required: ["session", "enabled"], properties: { session: {}, enabled: {} } } },
];
let connectCount = 0;

mock.module("@trycua/cua-driver", () => ({
  CuaDriver: { connect: () => {
    connectCount++;
    const versionAtConnect = driverVersion;
    const pidAtConnect = driverPid;
    return {
      isAvailable: () => driverAvailable,
      metadata: async () => ({ driverVersion: versionAtConnect, contractVersion: "0.9.0", pid: pidAtConnect }),
      listToolsJson: async () => JSON.stringify({ tools: listedTools }),
      callTool: async (tool: string, json: string) => {
        const args = JSON.parse(json);
        calls.push({ tool, args });
        const reply = (await handlers[tool]?.(args)) ?? {};
        return {
          text: reply.text ?? "", isError: reply.isError ?? false, errorCode: reply.errorCode, degraded: false, rawJson: "{}",
          structuredJson: reply.json === undefined ? undefined : JSON.stringify(reply.json),
          images: reply.image ? [{ mimeType: "image/png", dataBase64: reply.image }] : [],
        };
      },
    };
  } },
}));

const { createDesktopExtension } = await import("../src/index.ts");

// The driver is mocked, so pin the macOS guard open and let the unit suite run on any host; test/live covers real macOS.
const onMacOS = process.platform === "darwin";
Object.defineProperty(process, "platform", { value: "darwin" });
type DesktopOptions = NonNullable<Parameters<typeof createDesktopExtension>[0]>;

const window = (overrides: Record<string, unknown> = {}) => ({
  app_name: "Notes", pid: 10, window_id: 100, title: "Notes", is_on_screen: true, on_current_space: true,
  bounds: { x: 0, y: 0, width: 800, height: 600 }, ...overrides,
});

let snapshotCounter = 0;
function stateReply(elements: { role: string; label?: string; actions?: string[] }[], tree = "- [0] AXWindow \"Notes\"") {
  const snapshot_id = `s${String(++snapshotCounter).padStart(8, "0")}`;
  return {
    json: {
      app_name: "Notes", window_title: "Notes", pid: 10, window_id: 100, snapshot_id,
      returned_element_count: elements.length, total_element_count: elements.length, tree_markdown: tree,
      elements: elements.map((element, element_index) => ({ element_index, element_token: `${snapshot_id}:${element_index}`, ...element })),
    },
  };
}

function load(options?: DesktopOptions) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, Function[]>();
  const sent: unknown[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendUserMessage: (content: unknown) => sent.push(content),
    on: (event: string, handler: Function) => events.set(event, [...(events.get(event) ?? []), handler]),
  };
  createDesktopExtension(options)(pi);
  const notices: string[] = [];
  const ui = { notify: (message: string) => notices.push(message), setStatus: () => {} };
  const ctx: any = { sessionManager: { getSessionId: () => "abc-123" }, hasUI: true, ui, cwd: "/" };
  const run = async (name: string, input: unknown, signal?: AbortSignal) => {
    const result = await tools.get(name).execute("call", input, signal, undefined, ctx);
    return { ...result, text: result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") };
  };
  const emit = async (event: string, payload: unknown = {}) => {
    let last: unknown;
    for (const handler of events.get(event) ?? []) last = await handler(payload, ctx);
    return last;
  };
  const command = (args: string) => commands.get("desktop").handler(args, ctx);
  const binding = { run, emit, command, sent, notices };
  loaded.push(binding);
  return binding;
}

const loaded: { emit: (event: string) => Promise<unknown> }[] = [];

// The driver runtime is shared per process, so every binding must release it for the next test to start clean.
afterEach(async () => {
  for (const binding of loaded.splice(0)) await binding.emit("session_shutdown");
});

beforeEach(() => {
  snapshotCounter = 0;
  calls.length = 0;
  driverAvailable = true;
  driverVersion = "0.34.0";
  driverPid = 1;
  handlers = { list_windows: () => ({ json: { windows: [window()] } }) };
});

test("index-addressed steps reuse the observed snapshot, add the session label only where accepted, and stop at the first failure", async () => {
  handlers.get_window_state = () => stateReply([{ role: "AXWindow" }, { role: "AXButton", label: "Save" }]);
  handlers.click = () => ({ json: { effect: "confirmed", route: "accessibility" } });
  handlers.type_text = () => ({ isError: true, errorCode: "background_refused", text: "refused in background" });
  const { run } = load();

  await run("desktop_observe", { action: "state", app: "Notes" });
  const observedSnapshot = calls.find(call => call.tool === "get_window_state")!.args;
  const result = await run("desktop_act", { steps: [{ op: "click", index: 1 }, { op: "type", text: "hi" }, { op: "key", key: "return" }], observe: false });

  expect(calls.find(call => call.tool === "list_windows")!.args.session).toBeUndefined();
  expect(observedSnapshot.session).toBe("pi-default-abc-123");
  expect(calls.find(call => call.tool === "click")!.args).toEqual({ pid: 10, window_id: 100, element_token: "s00000001:1", session: "pi-default-abc-123" });
  expect(calls.some(call => call.tool === "press_key")).toBe(false);
  expect(result.isError).toBe(true);
  expect(result.text).toContain("1. click [1] AXButton \"Save\" → ok effect=confirmed");
  expect(result.text).toContain("failed [background_refused]");
  expect(result.text).toContain("1 step(s) skipped");
});

test("a stale index is retried only when a fresh walk shows the same element there", async () => {
  let fresh: { role: string; label?: string }[] = [{ role: "AXWindow" }, { role: "AXButton", label: "Save" }];
  handlers.get_window_state = () => stateReply(fresh);
  handlers.click = args => args.element_token === "s00000001:1" ? { isError: true, errorCode: "stale_element_token", text: "stale snapshot" } : { json: { effect: "confirmed" } };
  const { run } = load();
  await run("desktop_observe", { action: "state", app: "Notes" });

  const retried = await run("desktop_act", { steps: [{ op: "click", index: 1 }], observe: false });
  expect(retried.isError).toBeUndefined();
  expect(calls.filter(call => call.tool === "click").map(call => call.args.element_token)).toEqual(["s00000001:1", "s00000002:1"]);

  fresh = [{ role: "AXWindow" }, { role: "AXButton", label: "Delete" }];
  handlers.click = args => args.element_token === "s00000002:1" ? { isError: true, errorCode: "stale_element_token", text: "stale" } : { json: {} };
  const clicksBefore = calls.filter(call => call.tool === "click").length;
  const refused = await run("desktop_act", { steps: [{ op: "click", index: 1 }], observe: false });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("ui_changed");
  expect(refused.text).toContain("now AXButton \"Delete\"");
  expect(calls.filter(call => call.tool === "click").length).toBe(clicksBefore + 1);
});

test("ended driver sessions (idle expiry of the label and implicit session, or /desktop reset) are restarted and the call retried", async () => {
  const LABEL = "pi-default-abc-123";
  const ended = new Set<string>();
  const ENDED: Reply = { isError: true, errorCode: "session_ended", text: "this session has ended; call start_session explicitly to reuse its label" };
  handlers.end_session = args => { ended.add(args.session); return {}; };
  handlers.start_session = args => { ended.delete(args.session ?? "implicit"); return {}; };
  handlers.list_windows = args => ended.has(args.session ?? "implicit") ? ENDED : { json: { windows: [window()] } };
  handlers.get_window_state = args => ended.has(args.session ?? "implicit") ? ENDED : stateReply([{ role: "AXWindow" }]);
  const { run, command } = load();
  await run("desktop_observe", { action: "state", app: "Notes" });

  ended.add("implicit").add(LABEL);
  expect((await run("desktop_observe", { action: "windows" })).isError).toBeUndefined();
  expect((await run("desktop_observe", { action: "state", app: "Notes" })).text).toContain("snapshot=s00000002");
  await command("reset");
  expect((await run("desktop_observe", { action: "state", app: "Notes" })).text).toContain("snapshot=s00000003");
  expect(calls.filter(call => call.tool === "start_session").map(call => call.args)).toEqual([{}, { session: LABEL }, { session: LABEL }]);
});

test("a screenshot-only observation keeps the tree snapshot that index steps address", async () => {
  handlers.get_window_state = args => args.include_accessibility_tree === false ? stateReply([]) : stateReply([{ role: "AXWindow" }, { role: "AXButton", label: "Save" }]);
  handlers.click = () => ({ json: { effect: "confirmed" } });
  const { run } = load();
  await run("desktop_observe", { action: "state", app: "Notes" });
  await run("desktop_observe", { action: "screenshot", app: "Notes" });

  const result = await run("desktop_act", { steps: [{ op: "click", index: 1 }], observe: false });
  expect(result.text).toContain("click [1] AXButton \"Save\" → ok");
  expect(calls.find(call => call.tool === "click")!.args.element_token).toBe("s00000001:1");

  // The driver may measure the index against its newest snapshot, the empty screenshot-only one: re-walk and retry.
  await run("desktop_observe", { action: "screenshot", app: "Notes" });
  handlers.click = args => args.element_token === "s00000001:1"
    ? { isError: true, errorCode: "invalid_element_token", text: "element_token element_index 1 out of range (snapshot had 0 elements)" }
    : { json: { effect: "confirmed" } };
  const repaired = await run("desktop_act", { steps: [{ op: "click", index: 1 }], observe: false });
  expect(repaired.isError).toBeUndefined();
  expect(calls.filter(call => call.tool === "click").at(-1)!.args.element_token).toBe("s00000004:1");
});

test("a refused pixel click names the window's newest capture; pixel steps return a screenshot; driver hints name agent tools", async () => {
  const MISSING: Reply = { isError: true, errorCode: "screenshot_context_missing",
    text: "The latest snapshot for this window does not contain a screenshot owned by this session. Call get_window_state with a screenshot on the same connection before using pixels." };
  handlers.get_window_state = args => {
    const reply = stateReply([{ role: "AXWindow" }]);
    if (args.include_screenshot) Object.assign(reply.json, { capture_id: `capture-${snapshotCounter}` });
    return reply;
  };
  handlers.click = args => args.capture_id === "capture-1" ? { json: { effect: "confirmed" } } : MISSING;
  const { run } = load();
  await run("desktop_observe", { action: "state", app: "Notes", screenshot: true });

  const clicked = await run("desktop_act", { steps: [{ op: "click", x: 120, y: 40 }] });
  expect(clicked.text).toContain("click @120,40 → ok");
  expect(calls.filter(call => call.tool === "click").map(call => call.args.capture_id)).toEqual([undefined, "capture-1"]);
  expect(calls.filter(call => call.tool === "get_window_state").at(-1)!.args.include_screenshot).toBe(true);

  // A tree-only walk leaves no capture to name, so the refusal stands, worded for the agent's tools.
  await run("desktop_observe", { action: "state", app: "Notes" });
  const refused = await run("desktop_act", { steps: [{ op: "click", x: 120, y: 40 }], observe: false });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("desktop_observe action=state screenshot=true");
  expect(refused.text).not.toContain("get_window_state");
});

test("desktop calls in one conversation run one at a time", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  handlers.get_window_state = async args => {
    started.push(`state:${args.max_elements}`);
    if (args.max_elements === 10) await gate;
    return stateReply([{ role: "AXWindow" }]);
  };
  const { run } = load();
  const first = run("desktop_observe", { action: "state", pid: 10, window_id: 100, max_elements: 10 });
  const second = run("desktop_observe", { action: "state", pid: 10, window_id: 100, max_elements: 20 });
  await Bun.sleep(5);
  expect(started).toEqual(["state:10"]);
  release();
  await Promise.all([first, second]);
  expect(started).toEqual(["state:10", "state:20"]);
});

test("app targets ignore hidden helper windows and list candidates when still ambiguous", async () => {
  handlers.get_window_state = () => stateReply([{ role: "AXWindow" }]);
  handlers.list_windows = () => ({ json: { windows: [
    window(),
    window({ window_id: 101, title: "", is_on_screen: false, bounds: { x: 0, y: 940, width: 500, height: 500 } }),
    window({ window_id: 102, title: "", bounds: { x: 0, y: 0, width: 24, height: 24 } }),
  ] } });
  const { run } = load();

  const listed = await run("desktop_observe", { action: "windows" });
  expect(listed.text).toContain("1 window(s):\npid=10 window_id=100 Notes \"Notes\" 800x600+0+0");
  expect((await run("desktop_observe", { action: "state", app: "notes" })).isError).toBeUndefined();

  handlers.list_windows = () => ({ json: { windows: [window(), window({ window_id: 103, title: "Second" })] } });
  const ambiguous = await run("desktop_observe", { action: "state", app: "Notes" });
  expect(ambiguous.isError).toBe(true);
  expect(ambiguous.text).toContain("ambiguous_target");
  expect(ambiguous.text).toContain("window_id=103");
});

test("verify fails the call only when the driver disproves a predicate", async () => {
  handlers.get_window_state = () => stateReply([{ role: "AXWindow" }]);
  handlers.press_key = () => ({ json: {} });
  const { run } = load();
  const act = () => run("desktop_act", { app: "Notes", steps: [{ op: "key", key: "tab" }], verify: [{ role: "AXButton", label: "Save", enabled: true }, { window_exists: true }], observe: false });

  handlers.verify_state = () => ({ json: { status: "unknown" }, text: "verify_state: unknown" });
  expect((await act()).isError).toBeUndefined();
  expect(calls.find(call => call.tool === "verify_state")!.args.expect).toEqual([
    { element: { selector: { role: "AXButton", label_contains: "Save" }, exists: true, enabled: true } },
    { window: { exists: true } },
  ]);

  handlers.verify_state = () => ({ json: { status: "unsatisfied" }, text: "verify_state: unsatisfied" });
  expect((await act()).isError).toBe(true);
});

test("a cold launch waits for the app's first window and targets it in later steps", async () => {
  let polls = 0;
  handlers.launch_app = () => ({ text: "Launched", json: { pid: 42, windows: [] } });
  handlers.list_windows = args => ++polls < 3 ? { json: { windows: [] } } : { json: { windows: [window({ pid: args.pid, window_id: 420, app_name: "Calculator" })] } };
  handlers.hotkey = () => ({ json: {} });
  const { run } = load();

  const result = await run("desktop_act", { steps: [{ op: "launch", bundle_id: "com.apple.calculator" }, { op: "hotkey", keys: ["cmd", "n"] }], observe: false });
  expect(result.text).toContain("target pid=42 window_id=420");
  expect(calls.find(call => call.tool === "hotkey")!.args).toMatchObject({ pid: 42, window_id: 420 });
});

test("rendered state hides secure field values and folds the menu bar", async () => {
  handlers.get_window_state = () => stateReply([{ role: "AXWindow" }], [
    "- [0] AXWindow \"Login\"",
    "  - [1] AXSecureTextField (Password) = \"hunter2\" [actions=[press]]",
    "- [2] AXMenuBar [actions=[cancel]]",
    "  - [3] AXMenuBarItem \"Apple\"",
    "    - [4] AXMenuItem \"Recent Items\"",
    "- [5] AXButton \"After\"",
  ].join("\n"));
  const { run } = load();

  const folded = await run("desktop_observe", { action: "state", app: "Notes" });
  expect(folded.text).not.toContain("hunter2");
  expect(folded.text).toContain("elements=1/1");
  expect(folded.text).toContain("AXSecureTextField (Password) = \"••••\" [actions=[press]]");
  expect(folded.text).toContain("- [2] AXMenuBar [actions=[cancel]] (2 menu rows hidden");
  expect(folded.text).not.toContain("Recent Items");
  expect(folded.text).toContain("[5] AXButton \"After\"");
  expect((await run("desktop_observe", { action: "state", app: "Notes", menus: true })).text).toContain("Recent Items");

  // A walk cut at its node budget counts only what it reached, so it must not read as complete.
  handlers.get_window_state = () => {
    const reply = stateReply([{ role: "AXWindow" }]);
    Object.assign(reply.json, { truncated: true, truncation_reason: "node_budget", nodes_pending: 7 });
    return reply;
  };
  const cut = await run("desktop_observe", { action: "state", app: "Notes" });
  expect(cut.text).toContain("elements=1 (partial)");
  expect(cut.text).toContain("7+ nodes not walked");
});

test("context pruning keeps the two newest desktop screenshots and leaves other messages untouched", async () => {
  const { emit } = load();
  const image = (toolName: string) => ({ role: "toolResult", toolName, content: [{ type: "text", text: "t" }, { type: "image", data: "x", mimeType: "image/png" }] });
  const messages = [image("desktop_observe"), image("browser"), image("desktop_act"), image("desktop_observe")];

  const result = await emit("context", { messages }) as { messages: any[] };
  expect(result.messages[0].content[1]).toEqual({ type: "text", text: expect.stringContaining("removed") });
  expect(result.messages.slice(1)).toEqual(messages.slice(1));
  expect(await emit("context", { messages: messages.slice(1) })).toBeUndefined();
});

test("the prompt nudge joins Pi's turn guidelines, and /desktop never turns stray words into prompts or toggles", async () => {
  const { emit, command, sent, notices } = load();
  // Pi renders a string prompt from per-turn options: the nudge joins its guidelines and nothing replaces the prompt.
  const nudged = async () => {
    const turn = { systemPrompt: "base", systemPromptOptions: { promptGuidelines: ["existing"] } };
    expect(await emit("before_agent_start", turn)).toBeUndefined();
    return turn.systemPromptOptions.promptGuidelines;
  };

  expect(await nudged()).toEqual(["existing", expect.stringContaining("desktop_observe")]);
  for (const stray of ["off", "stauts", "Rename the Finder window's selected file to notes.txt", "jev"]) {
    await command(stray);
    expect(notices.at(-1)).toContain("Usage: /desktop");
  }
  expect(sent).toEqual([]);
  expect(await nudged()).toHaveLength(2);
});

test("a step reports the windows it opened, which the returned state does not show", async () => {
  handlers.get_window_state = () => stateReply([{ role: "AXWindow" }, { role: "AXButton", label: "Export" }]);
  handlers.click = () => ({ json: { effect: "unverifiable", route: "accessibility", new_windows: [{ window_id: 207, pid: 10, title: "Export As" }] } });
  const { run } = load();
  await run("desktop_observe", { action: "state", app: "Notes" });
  const result = await run("desktop_act", { steps: [{ op: "click", index: 1 }], observe: false });
  expect(result.text).toContain('→ ok effect=unverifiable route=accessibility opened=[pid=10 window_id=207 "Export As"]');
});

test("/desktop warns when the installed daemon is older than the SDK these tools use", async () => {
  handlers.check_permissions = () => ({ text: "Accessibility: granted" });
  const { command, notices } = load();
  await command("status");
  // The mocked daemon reports 0.34.0.
  expect(notices.at(-1)).toMatch(/cua-driver 0\.34\.0 \(older than the \d+\.\d+\.\d+ SDK these tools use; update with `cua-driver update --apply`\)/);
});

test("JEV acts on a confident pick and declines an uncertain one, sending labels but not typed values", async () => {
  const tree = [
    "- [0] AXWindow \"Notes\"",
    "  - [1] AXButton (Save) [actions=[press]]",
    "  - [2] AXTextField (Title) = \"private draft\" [actions=[confirm]]",
  ].join("\n");
  handlers.get_window_state = () => stateReply([{ role: "AXWindow" }, { role: "AXButton", label: "Save", actions: ["AXPress"] }, { role: "AXTextField", label: "Title", actions: ["AXConfirm"] }], tree);
  handlers.click = () => ({ json: { effect: "confirmed" } });
  let answer: { choice: string; confidence: number; probabilities: Record<string, number> } = { choice: "1", confidence: 0.93, probabilities: { "1": 0.93 } };
  const bodies: any[] = [];
  const realFetch = globalThis.fetch;
  let status = 200;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return status === 200 ? new Response(JSON.stringify({ answers: { target: { type: "choice", ...answer } } })) : new Response(null, { status });
  }) as typeof fetch;
  try {
    // The key comes from the loader's resolver, as the local profile shim supplies it.
    const { run, command } = load({ jevApiKey: async () => "test-key" });
    await command("jev on");
    const acted = await run("desktop_act", { app: "Notes", steps: [{ op: "click", target: "the save button" }], observe: false });
    expect(acted.isError).toBeUndefined();
    expect(calls.find(call => call.tool === "click")!.args).toMatchObject({ element_token: "s00000001:1" });
    expect(JSON.stringify(bodies[0])).toContain("AXTextField (Title)");
    expect(JSON.stringify(bodies[0])).not.toContain("private draft");

    answer = { choice: "2", confidence: 0.3, probabilities: { "1": 0.25, "2": 0.3 } };
    const clicks = calls.filter(call => call.tool === "click").length;
    const declined = await run("desktop_act", { app: "Notes", steps: [{ op: "click", target: "that thing" }], observe: false });
    expect(declined.isError).toBe(true);
    expect(declined.text).toContain("jev_uncertain");
    expect(declined.text).toContain("[2] AXTextField (Title) p=0.30");
    expect(calls.filter(call => call.tool === "click").length).toBe(clicks);

    // An out-of-credit gateway fails every later target too, so JEV turns itself off and says why.
    status = 402;
    const refused = await run("desktop_act", { app: "Notes", steps: [{ op: "click", target: "the save button" }], observe: false });
    expect(refused.text).toContain("jev_unavailable");
    expect(refused.text).toContain("402");
    expect((await run("desktop_act", { app: "Notes", steps: [{ op: "click", target: "the save button" }], observe: false })).text).toContain("jev_off");
  }
  finally {
    globalThis.fetch = realFetch;
  }
});

test("desktop_driver argument errors carry the tool's input schema so one retry can fix every field", async () => {
  handlers.page = () => ({ isError: true, text: "Missing required parameter: action" });
  const { run } = load();
  const result = await run("desktop_driver", { tool: "page", args: {} });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("Missing required parameter: action");
  expect(result.text).toContain('input schema for page: {"required":["action","pid","window_id"]');
});

test("desktop_driver refuses host-configuration tools without reaching the driver", async () => {
  const { run } = load();
  const result = await run("desktop_driver", { tool: "set_config", args: { key: "max_image_dimension", value: 0 } });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("blocked_tool");
  expect(calls.some(call => call.tool === "set_config")).toBe(false);
});

test("session shutdown ends this conversation's driver session", async () => {
  handlers.get_window_state = () => stateReply([{ role: "AXWindow" }]);
  const { run, emit } = load();
  await run("desktop_observe", { action: "state", app: "Notes" });

  await emit("session_shutdown");
  expect(calls.filter(call => call.tool === "end_session").map(call => call.args)).toEqual([{ session: "pi-default-abc-123" }]);
});


test("cancellation interrupts waits and prevents queued work from starting", async () => {
  const { run } = load();
  for (const queued of [false, true]) {
    const controller = new AbortController();
    const first = queued ? run("desktop_act", { steps: [{ op: "wait", ms: 30 }], observe: false }) : Promise.resolve();
    const started = performance.now();
    const waiting = run("desktop_act", { steps: [{ op: "wait", ms: 1000 }], observe: false }, controller.signal);
    if (!queued) await Bun.sleep(10);
    controller.abort();
    const result = await waiting;
    await first;
    expect(result.isError).toBe(true);
    expect(result.text).toContain("cancelled");
    expect(performance.now() - started).toBeLessThan(250);
  }
});

test("shutdown waits for admitted desktop work before ending sessions", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let admitted: () => void = () => {};
  const started = new Promise<void>(resolve => { admitted = resolve; });
  handlers.get_window_state = async () => { admitted(); await gate; return stateReply([{ role: "AXWindow" }]); };
  const { run, emit } = load();
  const observing = run("desktop_observe", { action: "state", pid: 10, window_id: 100 });
  await started;
  const shutdown = emit("session_shutdown");
  try {
    await Bun.sleep(10);
    expect(calls.some(call => call.tool === "end_session")).toBe(false);
  } finally { release(); await Promise.all([observing, shutdown]); }
  expect(calls.filter(call => call.tool === "end_session")).toHaveLength(1);
});

test("invalid targeting and verification are rejected before any batch effects", async () => {
  const { run } = load();
  const invalid = [
    { steps: [{ op: "click", index: 1, x: 20, y: 30 }] },
    { steps: [{ op: "type", text: "x", y: 30 }] },
    { steps: [{ op: "launch" }] },
    { steps: [{ op: "launch", name: "Notes", bundle_id: "com.apple.Notes" }] },
    { steps: [{ op: "set_value", value: "x" }] },
    { steps: [{ op: "key", key: "tab" }], verify: [{ enabled: true }] },
  ];
  for (const params of invalid) {
    const result = await run("desktop_act", { pid: 10, window_id: 100, ...params,
      steps: [{ op: "clipboard", text: "must not be written" }, ...params.steps], observe: false });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  }
});

test("desktop_driver cannot redirect an action to another conversation session", async () => {
  const { run } = load();
  const result = await run("desktop_driver", { tool: "clipboard_write", args: { text: "x", session: "another-conversation" } });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("session");
  expect(calls).toEqual([]);
});


test("pixel drags run in the background unless foreground is asked for, and a refused drag carries the driver's next step", async () => {
  handlers.get_window_state = () => stateReply([{ role: "AXWindow" }]);
  // As the driver does for a drag that starts a drag-and-drop session, which macOS tracks with the real pointer.
  handlers.drag = args => args.delivery_mode === "foreground" ? { json: { effect: "unverifiable" } } : {
    isError: true, errorCode: "background_unavailable", text: "No drop landed.\nNext: retry in the foreground",
    json: { code: "background_unavailable", reason: "drag_and_drop_session", hint: "No drop landed: macOS drag-and-drop needs the real pointer. Retry with delivery_mode:\"foreground\" only if the user allows the window to come forward." },
  };
  const { run } = load();
  const refused = await run("desktop_act", { pid: 10, window_id: 100, steps: [{ op: "drag", from: [1, 2], to: [3, 4] }], observe: false });
  expect(calls.find(call => call.tool === "drag")!.args.delivery_mode).toBeUndefined();
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("failed [background_unavailable]: No drop landed. Next: No drop landed: macOS drag-and-drop needs the real pointer. Retry with delivery=\"foreground\" only if");
  const fronted = await run("desktop_act", { pid: 10, window_id: 100, steps: [{ op: "drag", from: [1, 2], to: [3, 4], delivery: "foreground" }], observe: false });
  expect(fronted.isError).toBeUndefined();
  expect(calls.filter(call => call.tool === "drag").at(-1)!.args.delivery_mode).toBe("foreground");
});

test("rendered state shows slider values the tree omits, so drags can be checked", async () => {
  handlers.get_window_state = () => stateReply([{ role: "AXWindow" }, { role: "AXSlider", label: "Volume" }],
    "- [0] AXWindow \"Mixer\"\n  - [1] AXSlider (Volume) [actions=[increment,decrement]]");
  const original = handlers.get_window_state;
  handlers.get_window_state = args => { const reply = original(args) as { json: any }; reply.json.elements[1].value = "8.330789465653268"; return reply; };
  const { run } = load();
  const state = await run("desktop_observe", { action: "state", pid: 10, window_id: 100 });
  expect(state.text).toContain("- [1] AXSlider (Volume) = \"8.33\" [actions=[increment,decrement]]");
});

test("launch targets a unique visible window rather than a returned helper window", async () => {
  handlers.launch_app = () => ({ json: { pid: 42, windows: [{ pid: 42, window_id: 421 }] } });
  handlers.list_windows = () => ({ json: { windows: [
    window({ pid: 42, window_id: 421, is_on_screen: false }),
    window({ pid: 42, window_id: 420 }),
  ] } });
  const { run } = load();
  const result = await run("desktop_act", { steps: [{ op: "launch", name: "Notes" }, { op: "hotkey", keys: ["cmd", "n"] }], observe: false });
  expect(result.isError).toBeUndefined();
  expect(calls.find(call => call.tool === "hotkey")!.args.window_id).toBe(420);
});

// Re-encoding shells out to /usr/bin/sips, so this one needs a real Mac.
test.skipIf(!onMacOS)("large screenshots fit the inline byte budget without changing pixel coordinates", async () => {
  const { default: sharp } = await import("sharp");
  const input = await sharp({ create: { width: 1000, height: 600, channels: 3, background: "#406080" } })
    .png({ compressionLevel: 0 }).toBuffer();
  expect(input.toString("base64").length).toBeGreaterThan(1_000_000);
  handlers.get_window_state = () => ({ ...stateReply([]), image: input.toString("base64") });
  const { run } = load();
  const result = await run("desktop_observe", { action: "screenshot", pid: 10, window_id: 100 });
  expect(result.isError).toBeUndefined();
  const image = result.content.find((part: any) => part.type === "image");
  expect(image.mimeType).toBe("image/jpeg");
  expect(image.data.length).toBeLessThanOrEqual(1_000_000);
  const decoded = sharp(Buffer.from(image.data, "base64"));
  const metadata = await decoded.metadata();
  expect([metadata.width, metadata.height]).toEqual([1000, 600]);
  const { data } = await decoded.raw().toBuffer({ resolveWithObject: true });
  for (const [index, expected] of [64, 96, 128].entries()) expect(Math.abs(data[index] - expected)).toBeLessThan(8);

  const small = (await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer()).toString("base64");
  handlers.get_window_state = () => ({ ...stateReply([]), image: small });
  const unchanged = await run("desktop_observe", { action: "screenshot", pid: 10, window_id: 100 });
  expect(unchanged.content.find((part: any) => part.type === "image").data).toBe(small);
});

test("unencodable oversized screenshots fail visibly instead of forwarding an oversized image", async () => {
  handlers.get_window_state = () => ({ ...stateReply([]), image: "A".repeat(1_000_004) });
  const { run } = load();
  const result = await run("desktop_observe", { action: "screenshot", pid: 10, window_id: 100 });
  expect(result.isError).toBe(true);
  expect(result.text).toContain("screenshot_encoding_failed");
  expect(result.text).toContain("max_image_dimension");
});

test("rendered state keeps one row per element: custom actions collapse, long values are capped unless queried", async () => {
  const rows = Array.from({ length: 60 }, (_, row) => `Row ${row + 1}`).join("\n");
  const tree = `- [0] AXWindow "Mail"\n  - [1] AXRow [actions=[name:read\ntarget:0x0\nselector:(null),name:delete\ntarget:0x0\nselector:(null)]]\n  - [2] AXTextArea = "${rows}" (Body) [actions=[showmenu]]\n  - [3] AXButton "Send" [actions=[press]]\n  - [4] AXStaticText (${"Event notes ".repeat(80)}) [actions=[showmenu]]`;
  handlers.get_window_state = () => stateReply([{ role: "AXWindow" }, { role: "AXRow" }, { role: "AXTextArea", label: "Body" }, { role: "AXButton", label: "Send" }, { role: "AXStaticText" }], tree);
  const { run } = load();
  const state = await run("desktop_observe", { action: "state", pid: 10, window_id: 100 });
  expect(state.text).toContain("- [1] AXRow [actions=[read,delete]]");
  expect(state.text).not.toContain("target:0x0");
  expect(state.text).toMatch(/- \[2\] AXTextArea = "Row 1\\nRow 2\\n.*…" \(\+\d+ chars; query this control for the full value\) \(Body\)/);
  expect(state.text).toContain("\n  - [3] AXButton \"Send\"");
  expect(state.text).toMatch(/- \[4\] AXStaticText \(Event notes .*… \(\+\d+ chars; query this control for all of it\) \[actions=\[showmenu\]\]$/m);
  expect(state.text.split("\n").every((line: string) => line.length < 700)).toBe(true);
  const queried = await run("desktop_observe", { action: "state", pid: 10, window_id: 100, query: "Body" });
  expect(queried.text).toContain("Row 60\" (Body)");
});

test("hotkey can focus an element first, so editing chords land in that field", async () => {
  handlers.get_window_state = () => stateReply([{ role: "AXWindow" }, { role: "AXTextField", label: "Name" }]);
  const { run } = load();
  await run("desktop_observe", { action: "state", pid: 10, window_id: 100 });
  const result = await run("desktop_act", { steps: [{ op: "hotkey", keys: ["cmd", "a"], index: 1, delivery: "foreground" }], observe: false });
  expect(result.isError).toBeUndefined();
  const hotkey = calls.find(call => call.tool === "hotkey")!.args;
  expect(hotkey.element_token).toMatch(/:1$/);
  expect(hotkey.delivery_mode).toBe("foreground");
});

test("a query cut off by the default walk budget searches deeper once and says so", async () => {
  handlers.get_window_state = args => {
    const reply = args.max_elements > 150
      ? stateReply([{ role: "AXWindow" }, { role: "AXButton", label: "Archive" }], "- [0] AXWindow \"Mail\"\n  - [1] AXButton \"Archive\"")
      : stateReply([], "");
    return { json: { ...reply.json, truncated: args.max_elements <= 150, returned_element_count: args.max_elements > 150 ? 2 : 0 } };
  };
  const { run } = load();
  const found = await run("desktop_observe", { action: "state", pid: 10, window_id: 100, query: "Archive" });
  expect(found.text).toContain("[1] AXButton \"Archive\"");
  expect(found.text).toContain("searched up to 1500");
  expect(calls.filter(call => call.tool === "get_window_state").map(call => call.args.max_elements)).toEqual([150, 1500]);
  // An explicit budget is the agent's choice: no second walk.
  calls.length = 0;
  await run("desktop_observe", { action: "state", pid: 10, window_id: 100, query: "Archive", max_elements: 100 });
  expect(calls.filter(call => call.tool === "get_window_state")).toHaveLength(1);
});

test("session injection follows the daemon's live tool schemas, and install_extension is blocked", async () => {
  handlers.browser_select = () => ({ json: { ok: true } });
  handlers.set_agent_cursor_enabled = () => ({ json: { ok: true } });
  handlers.list_sessions = () => ({ json: { sessions: [] } });
  const { run } = load();
  await run("desktop_driver", { tool: "browser_select", args: { target_id: "t", tab_id: "tab", ref: "p1:1", value: "a" } });
  await run("desktop_driver", { tool: "set_agent_cursor_enabled", args: { enabled: false } });
  await run("desktop_driver", { tool: "list_sessions", args: {} });
  expect(calls.find(c => c.tool === "browser_select")!.args.session).toBe("pi-default-abc-123");
  expect(calls.find(c => c.tool === "set_agent_cursor_enabled")!.args.session).toBe("pi-default-abc-123");
  expect(calls.find(c => c.tool === "list_sessions")!.args.session).toBeUndefined();

  const blocked = await run("desktop_driver", { tool: "install_extension", args: { name: "perception", confirm: true } });
  expect(blocked.isError).toBe(true);
  expect(blocked.text).toContain("blocked_tool");
  expect(calls.some(c => c.tool === "install_extension")).toBe(false);
});

test("JEV strips multi-line text-area values and password inputs, preserves indices after refusal, and ranks low-confidence multi-chunk none", async () => {
  const manyElements = Array.from({ length: 170 }, (_, i) =>
    i === 0 ? { role: "AXWindow" }
      : i === 1 ? { role: "AXTextArea", label: "Notes", actions: ["AXConfirm"] }
      : i === 2 ? { role: "AXTextField", label: "PIN", is_password: true, actions: ["AXConfirm"] }
      : i === 160 ? { role: "AXButton", label: "Delete Account", actions: ["AXPress"] }
      : { role: "AXButton", label: `Item ${i}`, actions: ["AXPress"] },
  );
  const tree = [
    "- [0] AXWindow \"Mail\"",
    "  - [1] AXTextArea (Notes) = \"first secret line\nsecond secret line\" [actions=[name:edit\ntarget:0x0\nselector:(null)]]",
    "  - [2] AXTextField (PIN) = \"9999\" [actions=[confirm]]",
    ...Array.from({ length: 167 }, (_, offset) => {
      const idx = offset + 3;
      return `  - [${idx}] AXButton (${idx === 160 ? "Delete Account" : `Item ${idx}`}) [actions=[press]]`;
    }),
  ].join("\n");
  handlers.get_window_state = args => {
    const cap = args.max_elements ?? 150;
    const sliced = manyElements.slice(0, cap);
    return stateReply(sliced as any, cap >= 170 ? tree : tree.split("\n").slice(0, 10).join("\n"));
  };
  handlers.click = () => ({ json: { effect: "confirmed" } });

  const bodies: string[] = [];
  const realFetch = globalThis.fetch;
  let mode: "destructive" | "uncertain_none" = "destructive";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = String(init.body);
    bodies.push(body);
    const parsed = JSON.parse(body);
    const keys = Object.keys(parsed.questions.target.criteria);
    if (mode === "destructive") {
      if (keys.includes("160")) {
        return new Response(JSON.stringify({ answers: { target: { type: "choice", choice: "160", confidence: 0.92, probabilities: { "160": 0.92 } } } }));
      }
      return new Response(JSON.stringify({ answers: { target: { type: "choice", choice: "none", confidence: 0.95, probabilities: { none: 0.95 } } } }));
    }
    const firstRef = keys.find(k => k !== "none")!;
    return new Response(JSON.stringify({ answers: { target: { type: "choice", choice: "none", confidence: 0.35, probabilities: { none: 0.35, [firstRef]: 0.3 } } } }));
  }) as typeof fetch;

  try {
    const { run, command } = load({ jevApiKey: async () => "test-key" });
    await command("jev on");
    const refused = await run("desktop_act", { app: "Notes", steps: [{ op: "click", target: "delete account" }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("jev_needs_index");
    expect(refused.text).toContain("index 160");
    const sentPayload = bodies.join("\n");
    expect(sentPayload).not.toContain("first secret line");
    expect(sentPayload).not.toContain("second secret line");
    expect(sentPayload).not.toContain("target:0x0");
    expect(sentPayload).not.toContain("PIN");
    const confirmed = await run("desktop_act", { app: "Notes", steps: [{ op: "click", index: 160 }], observe: false });
    expect(confirmed.isError).toBeUndefined();
    expect(calls.filter(c => c.tool === "click").at(-1)!.args.element_token).toMatch(/:160$/);

    mode = "uncertain_none";
    const uncertain = await run("desktop_act", { app: "Notes", steps: [{ op: "click", target: "ambiguous button" }] });
    expect(uncertain.isError).toBe(true);
    expect(uncertain.text).toContain("jev_uncertain");
    expect(uncertain.text).toMatch(/p=0\.30/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("renderState redacts password elements without swallowing trailing quotes, ignores null slider values, and renders tree_diff", async () => {
  handlers.get_window_state = args => {
    if (args.since) {
      return {
        json: {
          app_name: "Notes", window_title: "Notes", pid: 10, window_id: 100, snapshot_id: "s00000002",
          since: "latest", since_status: "diff",
          tree_diff: 'since s00000001: 0 added, 1 changed, 0 removed.\n~ [2] AXStaticText = "Count 1"',
          elements: [],
        },
      };
    }
    const reply = stateReply(
      [
        { role: "AXWindow" },
        { role: "AXSecureTextField", label: 'Enter "pass"' },
        { role: "AXTextField", label: "Web Password", is_password: true } as any,
        { role: "AXProgressIndicator", label: "Loading" },
      ],
      [
        '- [0] AXWindow "Login"',
        '  - [1] AXSecureTextField = "hunter2" (Enter "pass") [actions=[press]]',
        '  - [2] AXTextField (Web Password) = "websecret" [actions=[confirm]]',
        '  - [3] AXProgressIndicator (Loading)',
      ].join("\n"),
    );
    (reply.json.elements[3] as any).value = null;
    return reply;
  };
  const { run } = load();
  const state = await run("desktop_observe", { action: "state", pid: 10, window_id: 100 });
  expect(state.text).not.toContain("hunter2");
  expect(state.text).not.toContain("websecret");
  expect(state.text).toContain('(Enter "pass")');
  expect(state.text).not.toContain('AXProgressIndicator (Loading) = "0"');

  const diff = await run("desktop_driver", { tool: "get_window_state", args: { pid: 10, window_id: 100, since: "latest" } });
  expect(diff.text).toContain('~ [2] AXStaticText = "Count 1"');
  expect(diff.text).not.toContain("(no accessibility tree)");
});

test("daemon restart clears stale metadata and reconnects on the next call", async () => {
  handlers.check_permissions = () => ({ text: "Accessibility: granted" });
  const { command, notices } = load();
  await command("status");
  expect(notices.at(-1)).toContain("cua-driver 0.34.0");
  expect(notices.at(-1)).toContain("pid 1");

  const beforeConnects = connectCount;
  driverAvailable = false;
  await command("reset");
  driverVersion = "0.64.2";
  driverPid = 999;
  driverAvailable = true;
  await command("status");
  expect(connectCount).toBeGreaterThan(beforeConnects);
  expect(notices.at(-1)).toContain("cua-driver 0.64.2");
  expect(notices.at(-1)).toContain("pid 999");
});

test("JEV supports Cloudflare Workers AI and turns itself off on Cloudflare billing/auth refusals", async () => {
  handlers.get_window_state = () => stateReply(
    [{ role: "AXWindow" }, { role: "AXPopUpButton", label: "Country", actions: ["AXPress"] }],
    '- [0] AXWindow "Form"\n  - [1] AXPopUpButton (Country) [actions=[press]]',
  );
  handlers.set_value = () => ({ json: { effect: "confirmed" } });
  const realFetch = globalThis.fetch;
  let status = 200;
  let requestedUrl = "";
  globalThis.fetch = (async (url: string) => {
    requestedUrl = String(url);
    if (status !== 200) return new Response(JSON.stringify({ success: false, errors: [{ code: 2021 }] }), { status });
    return new Response(JSON.stringify({
      success: true,
      result: { state: "Completed", result: { answers: { target: { type: "choice", choice: "1", confidence: 0.91, probabilities: { "1": 0.91 } } } } },
    }));
  }) as typeof fetch;
  try {
    const { run, command } = load({
      jevClassifier: "workers-ai",
      cloudflare: async () => ({ accountId: "acct-123", apiKey: "cf-token" }),
    });
    await command("jev on");
    const acted = await run("desktop_act", { app: "Notes", steps: [{ op: "set_value", target: "country dropdown", value: "US" }], observe: false });
    expect(acted.isError).toBeUndefined();
    expect(requestedUrl).toContain("/accounts/acct-123/ai/run");
    expect(calls.find(c => c.tool === "set_value")!.args).toMatchObject({ element_token: "s00000001:1", value: "US" });

    status = 402;
    const refused = await run("desktop_act", { app: "Notes", steps: [{ op: "set_value", target: "country dropdown", value: "CA" }], observe: false });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("jev_unavailable");
    expect((await run("desktop_act", { app: "Notes", steps: [{ op: "set_value", target: "country dropdown", value: "CA" }], observe: false })).text).toContain("jev_off");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("desktop_act auto-diffs against the last full snapshot, updates element tokens across diffs, and re-reads full on reindexed diffs", async () => {
  let diffKind: "diff" | "reindexed" = "diff";
  handlers.get_window_state = args => {
    if (args.since === "latest") {
      const snapshot_id = `s${String(++snapshotCounter).padStart(8, "0")}`;
      return {
        json: {
          app_name: "Notes", window_title: "Notes", pid: 10, window_id: 100, snapshot_id,
          ui_tree_revision: 42, since: "latest", since_status: "diff",
          tree_diff: diffKind === "reindexed"
            ? "since s00000002: 1 added, 0 changed, 0 removed.\nreindexed: 1->2\n+ [1] AXButton \"New\""
            : 'since s00000001: 0 added, 1 changed, 0 removed.\n~ [2] AXStaticText = "Count 1"',
          elements: [],
        },
      };
    }
    const reply = stateReply([
      { role: "AXWindow" },
      { role: "AXButton", label: "Increment" },
      { role: "AXStaticText", label: "Count" },
    ], '- [0] AXWindow "Notes"\n  - [1] AXButton "Increment"\n  - [2] AXStaticText = "Count 0"');
    (reply.json as any).ui_tree_revision = 41;
    return reply;
  };
  handlers.click = () => ({ json: { effect: "confirmed" } });
  const { run } = load();

  await run("desktop_observe", { action: "state", pid: 10, window_id: 100 });
  const firstAct = await run("desktop_act", { pid: 10, window_id: 100, check_unchanged: true, steps: [{ op: "click", index: 1 }] });
  expect(firstAct.isError).toBeUndefined();
  expect(firstAct.text).toContain("diff=diff");
  expect(firstAct.text).toContain('~ [2] AXStaticText = "Count 1"');
  expect(calls.find(c => c.tool === "click")!.args).toMatchObject({ element_token: "s00000001:1", ui_tree_revision: 41 });

  diffKind = "reindexed";
  const secondAct = await run("desktop_act", { pid: 10, window_id: 100, check_unchanged: true, steps: [{ op: "click", index: 1 }] });
  expect(secondAct.isError).toBeUndefined();
  expect(calls.filter(c => c.tool === "click").at(-1)!.args).toMatchObject({ element_token: "s00000002:1", ui_tree_revision: 42 });
  expect(secondAct.text).toContain("elements=3/3");

  // A drag step skips auto-diff so slider/range values (which tree_diff omits) remain observable.
  handlers.drag = () => ({ json: { effect: "unverifiable" } });
  await run("desktop_act", { pid: 10, window_id: 100, steps: [{ op: "drag", from: [1, 2], to: [3, 4] }] });
  expect(calls.filter(c => c.tool === "get_window_state").at(-1)!.args.since).toBeUndefined();
});

test("newer driver step fields (menu delivery, from_zoom, drag button/steps, key x/y, launch isolation, clipboard file_path) and /desktop health_report work", async () => {
  handlers.invoke_menu = () => ({ json: { effect: "confirmed" } });
  handlers.click = () => ({ json: { effect: "confirmed" } });
  handlers.drag = () => ({ json: { effect: "unverifiable" } });
  handlers.press_key = () => ({ json: {} });
  handlers.clipboard_write = () => ({ json: {} });
  handlers.launch_app = () => ({ json: { pid: 10, windows: [{ pid: 10, window_id: 100 }] } });
  handlers.health_report = () => ({
    json: {
      schema_version: "1", overall: "ok", driver_version: "0.64.2",
      checks: [
        { name: "tcc_accessibility", status: "pass", message: "Accessibility is granted." },
        { name: "tcc_screen_recording", status: "pass", message: "Screen Recording is granted." },
      ],
    },
  });
  const { run, command, notices } = load();
  const acted = await run("desktop_act", {
    pid: 10, window_id: 100, observe: false,
    steps: [
      { op: "menu", path: ["File", "Save"], delivery: "foreground" },
      { op: "click", x: 10, y: 20, from_zoom: true },
      { op: "drag", from: [1, 2], to: [3, 4], button: "right", steps: 12, from_zoom: true },
      { op: "key", key: "return", x: 50, y: 60 },
      { op: "clipboard", file_path: "/tmp/demo.txt" },
      { op: "launch", bundle_id: "com.apple.Notes", creates_new_application_instance: true, additional_arguments: ["--clean"] },
    ],
  });
  expect(acted.isError).toBeUndefined();
  expect(calls.find(c => c.tool === "invoke_menu")!.args).toMatchObject({ path: ["File", "Save"], delivery_mode: "foreground" });
  expect(calls.find(c => c.tool === "click")!.args).toMatchObject({ x: 10, y: 20, from_zoom: true });
  expect(calls.find(c => c.tool === "drag")!.args).toMatchObject({ button: "right", steps: 12, from_zoom: true });
  expect(calls.find(c => c.tool === "press_key")!.args).toMatchObject({ key: "return", x: 50, y: 60 });
  expect(calls.find(c => c.tool === "clipboard_write")!.args).toEqual({ file_path: "/tmp/demo.txt", session: "pi-default-abc-123" });
  expect(calls.find(c => c.tool === "launch_app")!.args).toMatchObject({ bundle_id: "com.apple.Notes", creates_new_application_instance: true, additional_arguments: ["--clean"] });

  await command("status");
  expect(notices.at(-1)).toContain("health ok — Accessibility is granted. Screen Recording is granted.");
});

test("cua.json resolves !command credentials, refuses literal keys and malformed JSON without echoing secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cua-cfg-"));
  const savedEnv = { key: process.env.AI_GATEWAY_API_KEY, cfAcct: process.env.CLOUDFLARE_ACCOUNT_ID, cfKey: process.env.CLOUDFLARE_API_KEY, cls: process.env.CUA_JEV_CLASSIFIER };
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_KEY;
  delete process.env.CUA_JEV_CLASSIFIER;
  const realFetch = globalThis.fetch;
  let authHeader = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    authHeader = String((init.headers as Record<string, string>)?.Authorization ?? "");
    return new Response(JSON.stringify({ answers: { target: { type: "choice", choice: "1", confidence: 0.9, probabilities: { "1": 0.9 } } } }));
  }) as typeof fetch;
  try {
    handlers.get_window_state = () => stateReply(
      [{ role: "AXWindow" }, { role: "AXButton", label: "Save", actions: ["AXPress"] }],
      '- [0] AXWindow "Notes"\n  - [1] AXButton (Save) [actions=[press]]',
    );
    handlers.click = () => ({ json: { effect: "confirmed" } });
    await writeFile(join(dir, "cua.json"), JSON.stringify({ jevApiKey: "!printf synthetic-file-key" }));
    const { run, command } = load({ agentDir: dir });
    await command("jev on");
    const acted = await run("desktop_act", { app: "Notes", steps: [{ op: "click", target: "Save" }], observe: false });
    expect(acted.isError).toBeUndefined();
    expect(authHeader).toBe("Bearer synthetic-file-key");

    await writeFile(join(dir, "cua.json"), JSON.stringify({ jevApiKey: "literal-secret-value" }));
    const literal = await run("desktop_act", { app: "Notes", steps: [{ op: "click", target: "Save" }], observe: false });
    expect(literal.isError).toBe(true);
    expect(literal.text).toContain("jev_config_error");
    expect(literal.text).toContain("!command");
    expect(literal.text).not.toContain("literal-secret-value");

    await writeFile(join(dir, "cua.json"), "{broken-secret-json");
    const malformed = await run("desktop_act", { app: "Notes", steps: [{ op: "click", target: "Save" }], observe: false });
    expect(malformed.isError).toBe(true);
    expect(malformed.text).toContain("Invalid JSON");
    expect(malformed.text).not.toContain("broken-secret-json");
  } finally {
    globalThis.fetch = realFetch;
    if (savedEnv.key !== undefined) process.env.AI_GATEWAY_API_KEY = savedEnv.key;
    if (savedEnv.cfAcct !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = savedEnv.cfAcct;
    if (savedEnv.cfKey !== undefined) process.env.CLOUDFLARE_API_KEY = savedEnv.cfKey;
    if (savedEnv.cls !== undefined) process.env.CUA_JEV_CLASSIFIER = savedEnv.cls;
    await rm(dir, { recursive: true, force: true });
  }
});

test("desktop_observe renders apps, desktop screenshots, and permissions", async () => {
  handlers.list_apps = () => ({ json: { apps: [{ pid: 10, name: "Notes", bundle_id: "com.apple.Notes", running: true, active: true }, { name: "Preview", running: false }] } });
  handlers.get_desktop_state = () => ({ json: { screenshot_width: 1280, screenshot_height: 800 }, image: "AAAA" });
  handlers.check_permissions = () => ({ text: "Accessibility: granted" });
  const { run } = load();
  const running = await run("desktop_observe", { action: "apps" });
  expect(running.text).toContain("1 app(s):");
  expect(running.text).toContain("pid=10 Notes com.apple.Notes [active]");
  const allApps = await run("desktop_observe", { action: "apps", all: true });
  expect(allApps.text).toContain("not-running Preview");
  const desktop = await run("desktop_observe", { action: "desktop" });
  expect(desktop.text).toContain("desktop screenshot 1280x800");
  expect(desktop.content.some((p: any) => p.type === "image")).toBe(true);
  const perms = await run("desktop_observe", { action: "permissions" });
  expect(perms.text).toContain("Accessibility: granted");
});
