# pi-cua

Native macOS desktop control for [Pi](https://github.com/earendil-works/pi) agents, backed by the [cua-driver](https://github.com/trycua/cua) `CuaDriver.app` daemon through its SDK (`@trycua/cua-driver` 0.64.2). Input goes to the target window in the background, so the agent does not take over your mouse or focus.

This package was renamed from `pi-desktop` and is published on npm as `@edlsh/pi-cua`. The tools, the `/desktop` command, the `desktop` skill, and the exported `createDesktopExtension` are unchanged.

## Tools

- `desktop_observe`: `windows`, `apps`, `state` (element tree with `[N]` indices), `screenshot`, `desktop`, `permissions`.
- `desktop_act`: up to 20 batched steps (`click`, `type`, `set_value`, `key`, `hotkey`, `scroll`, `drag`, `menu`, `launch`, `focus`, `resize`, `clipboard`, `wait`), optional `verify` predicates, and a fresh state afterwards.
- `desktop_driver`: direct access to other cua-driver tools such as `zoom`, `page`, and `browser_*`. The session label is set by pi-cua; `args.session` is refused.
- `/desktop`: status only, never a toggle: driver version, permissions, this conversation's session, and JEV. Anything other than the subcommands below shows usage; it is never sent to the agent as a prompt.
- `/desktop jev on|off`: JEV targeting for this conversation, off by default. While on, `desktop_act` click/double_click/right_click/type/set_value/scroll steps accept `target: "Save button in the toolbar"` instead of `index`. The `typesafe-ai/jev` model (Vercel AI Gateway) or `typesafe/jev-1.14.0` (Cloudflare Workers AI) picks the control from a fresh walk and acts only at confidence ≥ 0.5; otherwise the step fails with the top candidates while keeping the walk's indices intact. Controls whose label looks destructive (delete, send, buy, …) are never clicked by target; the agent must pass the index. Credentials resolve from env (`AI_GATEWAY_API_KEY`, or `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_KEY` with optional `CUA_JEV_CLASSIFIER=workers-ai`), `<agentDir>/cua.json` using `"!command"` resolvers (`jevApiKey`, `cloudflareAccountId`, `cloudflareApiKey`, `jevClassifier`), or `createDesktopExtension` options. If the classifier service refuses for billing or key reasons (HTTP 402, 401, or 403), the step fails with `jev_unavailable` and JEV turns itself off with a notice. Privacy: control labels and visible row text of the target window are sent to the configured JEV provider; the menu bar, secure/password fields, disabled controls, and typed text-field values (including multi-line text areas) are not.
- `/desktop reset`: ends this conversation's driver sessions and clears element indices.

While the extension is enabled, a one-line nudge in the turn's prompt guidelines steers native-app work to these tools; there is no separate switch for it. Turn the whole extension off with `pi config` or an `extensions` filter in Pi's `settings.json`.

Efficiency defaults: trees are capped at 150 nodes with a 3 s walk budget, menu bars are folded, screenshots are opt-in, and only the two newest desktop screenshots stay in context. A walk cut at its node budget reports `elements=N (partial)` and how many nodes it did not reach. The extension maps `[N]` indices to opaque driver-issued element tokens; it never constructs tokens from indices. A stale `[N]` index, including one the driver measures against a newer screenshot-only snapshot, is retried once, and only when a fresh walk shows the same element at that index. Screenshot-only observations keep the last element tree, so its indices stay usable. A pixel click refused with `screenshot_context_missing` is retried once with the window's newest screenshot capture, and `desktop_act` returns a screenshot with its state after pixel steps. Sliders and other range controls show their value in the state (`AXSlider (Volume) = "8.33"`), so a drag can be checked. `drag` runs in the background like every other step; a drag that starts a drag-and-drop session (reordering a list, moving a file) is refused with `background_unavailable`, because macOS only tracks those with the real pointer, and needs `delivery="foreground"`. A `hotkey` step accepts `index` (or `x`,`y`) to focus that control first, so editing chords such as cmd+a land in the intended field. Desktop calls within one conversation run one at a time; a cancelled call stops before its next step, and `/desktop reset` or session shutdown waits for the call in progress.

State text keeps one row per element. AppKit custom actions, which the driver reports as unresolved selector dumps, show as their names (`[actions=[read,delete]]`). Multi-line values stay on their row as `\n`. Values longer than 300 characters and rows longer than 500 are cut with a count of the hidden characters; a `query` for that control returns them in full. A `query` searches only the nodes the walk reached, so when the default 150-node walk is cut before any match, the extension searches once more up to 1,500 nodes and says so; an explicit `max_elements` is never raised.

Screenshots larger than 1,000,000 base64 bytes are re-encoded as lossy JPEG with macOS's built-in `sips` (quality 85, then 70 or 55 only if needed) without changing pixel dimensions, so click coordinates stay valid. Smaller images are unchanged. If encoding fails or the image still exceeds the budget, the tool reports an error asking for a smaller `max_image_dimension` rather than forwarding oversized image data. Reload the extension after updating; existing session images are not rewritten.

cua-driver ends sessions after 5 idle minutes (this conversation's label and the transport's implicit session behind `windows`/`apps`), and `/desktop reset` ends the label immediately; the next desktop call restarts the ended session and retries, so a paused conversation keeps working without restarting Pi. A session switch or `/reload` replaces Pi's extension runtime, so `session_shutdown` ends this conversation's sessions, and the next runtime revives them. The Pi process keeps one daemon connection throughout, because the daemon only lets the connection that started a session label restart it.

## Setup

Requires Pi 1.x on Node 22.19 or newer, and `CuaDriver.app` 0.64 in `/Applications` (installer: `/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"`; update an installed one with `cua-driver update --apply`). The first desktop call starts the daemon (`open -n -g -a CuaDriver --args serve`) when it is not running, and fails with `driver_unavailable` rather than falling back to an in-process runtime. Accessibility and Screen Recording are granted to `CuaDriver.app`, not to the app that launches Pi: run `cua-driver permissions grant` once and approve both. Until then calls fail with `permissions_pending`. Check with `desktop_observe action=permissions` or `/desktop`.

The SDK's Node addon connects to the daemon's socket. Load the extension one way, never both (duplicate tools):

- From npm: `pi install npm:@edlsh/pi-cua`. Reads JEV credentials from env vars or `~/.pi/agent/cua.json` (with `"!command"` resolvers; literal secret strings are refused).
- From a checkout, after `bun install`: `pi install /path/to/pi-cua` (or `pi -e /path/to/pi-cua` for one run); or a local loader in `~/.pi/agent/extensions/` that imports `createDesktopExtension` from the checkout's `src/index.ts` and calls it with Pi's API, for example to pass a `jevApiKey` or `cloudflare` resolver backed by your configured secrets manager. No cast is needed: `src/host.ts` is the host contract, and `bun run typecheck` verifies Pi's `ExtensionAPI` against it.

Driver sessions are labeled `pi-<profile>-<session>`, where the profile comes from `PI_PROFILE` (default `default`).

The package bundles the `desktop` agent skill in `skills/desktop`, declared under `pi.skills`. With a local loader, install the package with its extensions filtered out (`"extensions": []` in the package entry of Pi's `settings.json`) to load only the skill.

## Development

```sh
bun run check                     # typecheck (including Pi host contract), tests, and package verification
bun run test                      # unit tests, then Pi load, schema-validation, and agent-turn tests
bun run test:live                 # macOS: a real Pi session observes a compiled fixture window
SMOKE_ACT=1 bun run test:live     # also clicks, types, drags, scrolls, resizes, and uses menus in the fixture
```
