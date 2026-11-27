import { z } from "zod";

const pid = z.number().int().positive().describe("Process ID from windows/apps.");
const windowId = z.number().int().nonnegative().describe("Window ID from windows.");
const app = z.string().min(1).describe("App name (case-insensitive) when pid/window_id are unknown; must match exactly one visible window.");
const index = z.number().int().nonnegative().describe("Element index [N] from the latest state of the target window.");
const coord = z.number().describe("Screenshot pixel coordinate of the latest image of the target window.");
const modifiers = z.array(z.enum(["cmd", "shift", "option", "alt", "ctrl", "fn"])).max(5);
const delivery = z.enum(["background", "foreground"]).describe("background (default) acts without stealing focus; foreground briefly fronts the window and is the fallback when background input is refused.");
const fromZoom = z.boolean().optional().describe("When true, pixel coordinates refer to the last desktop_driver zoom image for this pid.");

const target = { app: app.optional(), pid: pid.optional(), window_id: windowId.optional() };

const treeBudget = {
  query: z.string().min(1).max(200).optional().describe("Case-insensitive filter (`a|b` matches either); returns matching actionable rows plus ancestors. Cheapest way to find one control."),
  since: z.string().min(1).max(64).optional().describe('Diff against an earlier snapshot: "latest" or a snapshot_id returns only changed rows (+/~/-); pass "full" on desktop_act to force a full tree.'),
  max_elements: z.number().int().min(10).max(5000).optional().describe("AX node budget (default 150). Raise only when truncated and query cannot narrow it."),
  max_depth: z.number().int().min(1).max(60).optional(),
  timeout_ms: z.number().int().min(100).max(30_000).optional().describe("Tree walk budget (default 3000)."),
  screenshot: z.boolean().optional().describe("Attach a window screenshot. Default false: the element tree is usually enough."),
  max_image_dimension: z.number().int().min(256).max(4096).optional().describe("Screenshot long-edge cap (default 1280)."),
  menus: z.boolean().optional().describe("Show the app's menu bar subtree (folded by default; the menu op invokes items by path)."),
};

export const observeParameters = z.object({
  action: z.enum(["windows", "apps", "state", "screenshot", "desktop", "permissions"]).describe("windows: visible windows (pid/window_id). apps: running apps. state: element tree of one window with [N] indices for desktop_act (pass since=\"latest\" for a compact diff). screenshot: window image only. desktop: full-screen image. permissions: Accessibility/Screen Recording status."),
  ...target,
  all: z.boolean().optional().describe("windows: include windows on other Spaces and tiny/utility windows. apps: include apps that are not running."),
  ...treeBudget,
}).strict();

const jevTarget = z.string().trim().min(1).max(300).describe("JEV mode only (/desktop jev on): plain-language control description, e.g. \"Save button in the toolbar\", used instead of index.");
const at = { index: index.optional(), target: jevTarget.optional(), x: coord.optional(), y: coord.optional() };

const step = z.discriminatedUnion("op", [
  z.object({ op: z.literal("click"), ...at, button: z.enum(["left", "right", "middle"]).optional(), count: z.number().int().min(1).max(3).optional(), modifiers: modifiers.optional(), ax_action: z.string().min(1).max(40).optional().describe("AX action instead of a press, e.g. show_menu, pick, confirm, cancel, open, show_alternate_ui."), from_zoom: fromZoom, delivery: delivery.optional() }).strict(),
  z.object({ op: z.literal("double_click"), ...at, delivery: delivery.optional() }).strict(),
  z.object({ op: z.literal("right_click"), ...at, modifiers: modifiers.optional(), delivery: delivery.optional() }).strict(),
  z.object({ op: z.literal("type"), text: z.string().max(20_000), ...at, delivery: delivery.optional() }).strict().describe("Insert text at the focused control, or at index / x,y."),
  z.object({ op: z.literal("set_value"), index: index.optional(), target: jevTarget.optional(), value: z.string().max(20_000) }).strict().describe("Set a text field, dropdown/popup button, slider, or stepper value directly through AX. Fastest for form controls."),
  z.object({ op: z.literal("key"), key: z.string().min(1).max(30).describe("return, tab, escape, up, down, delete, space, a, f5, ..."), modifiers: modifiers.optional(), index: index.optional(), x: coord.optional(), y: coord.optional(), delivery: delivery.optional() }).strict(),
  z.object({ op: z.literal("hotkey"), keys: z.array(z.string().min(1).max(30)).min(2).max(6).describe("Modifiers then one key, e.g. [\"cmd\",\"s\"]."), index: index.optional().describe("Focus this element first, so an editing chord (cmd+a, cmd+z) lands in it."), x: coord.optional(), y: coord.optional(), delivery: delivery.optional() }).strict(),
  z.object({ op: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]), amount: z.number().int().min(1).max(50).optional(), by: z.enum(["line", "page"]).optional(), ...at, delivery: delivery.optional() }).strict(),
  z.object({ op: z.literal("drag"), from: z.array(coord).length(2), to: z.array(coord).length(2), button: z.enum(["left", "right", "middle"]).optional(), steps: z.number().int().min(1).max(200).optional(), duration_ms: z.number().int().min(0).max(10_000).optional(), modifiers: modifiers.optional(), from_zoom: fromZoom, delivery: delivery.optional() }).strict().describe("Drag between screenshot pixels, e.g. a slider knob. A drag that starts a drag-and-drop session (reordering a list, moving a file) cannot drop in the background and is refused with background_unavailable; retry it with delivery=\"foreground\"."),
  z.object({ op: z.literal("menu"), path: z.array(z.string().min(1).max(200)).min(1).max(16).describe("Menu bar path, e.g. [\"File\",\"Export…\"]."), delivery: delivery.optional() }).strict(),
  z.object({ op: z.literal("launch"), bundle_id: z.string().min(1).optional(), name: z.string().min(1).optional(), urls: z.array(z.string().min(1)).max(20).optional(), creates_new_application_instance: z.boolean().optional().describe("Force a new app instance even if already running (open -n) for multi-agent isolation."), additional_arguments: z.array(z.string().min(1)).max(30).optional() }).strict().describe("Launch or activate an app; the launched window becomes the target for later steps."),
  z.object({ op: z.literal("focus") }).strict().describe("Bring the target window to the front."),
  z.object({ op: z.literal("resize"), x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).strict(),
  z.object({ op: z.literal("clipboard"), text: z.string().max(100_000).optional(), image_path: z.string().min(1).optional().describe("Absolute local path to an image file."), file_path: z.string().min(1).optional().describe("Absolute local path to a file URL.") }).strict().describe("Write plain text, an image path, or a file path to the clipboard."),
  z.object({ op: z.literal("wait"), ms: z.number().int().min(1).max(10_000) }).strict(),
])
.superRefine((value, ctx) => {
  const hasIndex = "index" in value && value.index !== undefined;
  const hasTarget = "target" in value && value.target !== undefined;
  const hasX = "x" in value && value.x !== undefined;
  const hasY = "y" in value && value.y !== undefined;
  if (value.op !== "resize" && hasX !== hasY) ctx.addIssue({ code: "custom", message: "Pass both x and y." });
  if (value.op !== "resize" && Number(hasIndex) + Number(hasTarget) + Number(hasX || hasY) > 1) {
    ctx.addIssue({ code: "custom", message: "Pass only one of index, target, or x,y." });
  }
  if (["click", "double_click", "right_click", "set_value"].includes(value.op) && !hasIndex && !hasTarget && !hasX) {
    ctx.addIssue({ code: "custom", message: "This step needs index, target, or x,y." });
  }
  if (value.op === "launch" && Number(Boolean(value.name)) + Number(Boolean(value.bundle_id)) !== 1) {
    ctx.addIssue({ code: "custom", message: "launch needs exactly one of bundle_id or name." });
  }
  if (value.op === "clipboard" && Number(value.text !== undefined) + Number(value.image_path !== undefined) + Number(value.file_path !== undefined) !== 1) {
    ctx.addIssue({ code: "custom", message: "clipboard needs exactly one of text, image_path, or file_path." });
  }
});

const expectation = z.object({
  role: z.string().min(1).optional().describe("AX role, e.g. AXButton."),
  label: z.string().min(1).optional().describe("Label substring."),
  value: z.string().optional().describe("Exact value."),
  enabled: z.boolean().optional(),
  selected: z.boolean().optional(),
  window_exists: z.boolean().optional().describe("Assert the target window exists (true) or has closed (false)."),
}).strict();

export const actParameters = z.object({
  ...target,
  steps: z.array(step).min(1).max(20).describe("Executed in order; stops at the first failure. All [N] indices refer to the state observed before this call."),
  verify: z.array(expectation).min(1).max(8).optional().describe("Postconditions polled until stable (up to verify_timeout_ms). Cheaper than a full re-observe."),
  verify_timeout_ms: z.number().int().min(0).max(10_000).optional(),
  check_unchanged: z.boolean().optional().describe("Pass the last observed ui_tree_revision to actions so they refuse with stale_revision if the window changed before input."),
  observe: z.boolean().optional().describe("Return a fresh state of the target window afterwards (default true; diffs against the last full read unless since=\"full\"). Set false for blind multi-call sequences."),
  ...treeBudget,
}).strict();

export const driverParameters = z.object({
  tool: z.string().min(1).max(64).describe("cua-driver tool name, e.g. zoom, run_steps, run_script, agent_display, health_report, get_guide, page, get_browser_state, browser_navigate, clipboard_read, move_cursor."),
  args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments in the driver's snake_case JSON shape. The session label is added automatically."),
}).strict();

export type ObserveParams = z.infer<typeof observeParameters>;
export type ActParams = z.infer<typeof actParameters>;
export type Step = z.infer<typeof step>;
export type Expectation = z.infer<typeof expectation>;
export type DriverParams = z.infer<typeof driverParameters>;
