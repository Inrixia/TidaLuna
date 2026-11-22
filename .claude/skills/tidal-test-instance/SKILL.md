---
name: tidal-test-instance
description: Launch a side-by-side TIDAL test instance running this repo's Luna build (dist/), then drive it over CDP: evaluate JS in the page or the main process, read console logs, live reload, dump TIDAL's render and native sources, take screenshots, make raw DevTools Protocol calls (click/type, navigate, profile, debug). Use when asked to run, start or test Luna or TIDAL, to check that plugins load, to reproduce or debug a runtime bug, to find TIDAL internals to hook, or to screenshot the UI. Windows and Linux (tidal-hifi).
---

# TIDAL test instance

Separate TIDAL client: own install copy, own profile, this repo's `dist/` as Luna. Runs beside user's daily client, lives in `.tidal-test/<n>/` (gitignored). Drive with:

```sh
node .claude/skills/tidal-test-instance/tidal.mjs [--instance <n>] <command>
```

| Command                                         | Does                                                                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup [installDir]`                            | Copies TIDAL install (default: newest `%LOCALAPPDATA%\TIDAL\app-*` on Windows, `/opt/tidal-hifi` on Linux), links its `resources/app` to `dist/`. Copies several hundred MB: ask user first. |
| `start`                                         | Launches instance if not running, waits for Luna load. Logged out: copies daily client login (its `Local Storage`), restarts, so instance logged in as user.                                 |
| `reload`                                        | Reloads page, waits for Luna. Picks up rebuilt `luna.mjs` (`render/`), `preload.mjs`, all plugins.                                                                                           |
| `eval "<expression>"`                           | Evaluates in page (renderer), awaits promises, prints result as JSON (return plain data, not DOM nodes).                                                                                     |
| `native "<expression>"`                         | Same in Electron main process (Node inspector). `require` available.                                                                                                                         |
| `logs [seconds]`                                | Prints page console so far (incl. forwarded `[Luna.native]` logs, exceptions), then follows for `seconds` (default 0). Pipe through `grep`/`tail`.                                           |
| `dump [dir]`                                    | Writes TIDAL's loaded web modules to `<dir>/render`, main-process sources (`original.asar`, no `node_modules`) to `<dir>/native`. Default `.tidal-test/<n>/sources`.                         |
| `screenshot <file.png>`                         | Saves screenshot. Write to scratchpad, Read it to see UI.                                                                                                                                    |
| `cdp [--native] <method> ['<params json>'] ...` | Raw DevTools Protocol calls on page (or main process with `--native`), in order on one session, prints each result. See below.                                                               |
| `stop`                                          | Kills only this instance's processes.                                                                                                                                                        |

Instance `n` uses CDP port `9230 + n`, main-process inspector port `9330 + n` (instance 1: 9231, 9331). Main-process stdout/stderr go to `.tidal-test/<n>/main.log`: live native console (all native logs incl. before window exists, crashes), follow with `tail -f`. Page `logs` also shows native logs forwarded once window exists.

Agents may use seperate instances if needed, prefer shared.

## DevTools Protocol

All Chrome DevTools does goes over these ports. Full schema (types, descriptions, every domain/method/event): `curl http://127.0.0.1:9231/json/protocol` (page), `:9331/json/protocol` (main process, Node's subset: Runtime, Debugger, Profiler, HeapProfiler…). `cdp` calls any of it; put `<Domain>.enable` first when method needs it. Examples:

- Click/type in UI: `cdp Input.dispatchMouseEvent '{"type":"mousePressed","x":100,"y":200,"button":"left","clickCount":1}' Input.dispatchMouseEvent '{"type":"mouseReleased","x":100,"y":200,"button":"left","clickCount":1}'`, `cdp Input.insertText '{"text":"query"}'`. Get coordinates from `eval` (`getBoundingClientRect()`) or screenshot.
- Navigate in app: `eval 'luna.lib.redux.actions["router/PUSH"]({ pathname: "/my-collection/albums", search: "", replace: false })'`. (`cdp Page.navigate` does full page load, like `reload`.)
- Metrics/memory: `cdp Performance.enable Performance.getMetrics`, `cdp --native Runtime.getHeapUsage`.
- Calls needing open session (pausing breakpoints, profiling across user actions, event streams) don't fit one-shot `cdp`: write short Node script reusing `connect` from `tidal.mjs`, or use `eval`/`native` (e.g. wrap function to log calls).

User can attach real Chrome DevTools too (live consoles, sources with Luna sourcemaps, breakpoints, profiler): `chrome://inspect` → Configure → add `127.0.0.1:9231` and `127.0.0.1:9331`. F12 or Ctrl+Shift+I in window opens its page DevTools.

## Workflow

1. Run `setup` if `.tidal-test/1/app` missing (ask first).
2. Build with `pnpm exec tsx ./esbuild.config.ts` (add `--watch`, run in background to rebuild on change). Same as `pnpm run build`/`watch` minus deleting `dist/` first — matters since dev's daily client often runs from this `dist/` too. Every build reaches daily client on next load: revert and rebuild when done with test change.
3. Run `start`.
4. Apply changes, fastest first:
   - Plugins: `eval 'Object.values(luna.core.LunaPlugin.plugins).forEach((p) => (p.liveReload = true))'` once (saved in test profile); with `--watch` running, each plugin reloads ~1s after rebuild, native code included. Or reload one: `eval 'luna.core.LunaPlugin.getByName("@luna/ui").reload()'`.
   - `render/`, `native/preload.ts`: `reload`.
   - Rest of `native/` (main process): `stop` then `start`.
5. Check result with `eval`, `native`, `logs`, `screenshot`, then `stop`.

## Hooks into the client

- Page: global `luna` console variable (`window.luna` / `globalThis.luna`) exposes all core functionality for debugging: `luna.core` (`@luna/core`: `LunaPlugin`, `modules`, `tidalModules`, `reduxStore` …), `luna.lib` (`@luna/lib`), `luna.ui` (`@luna/ui`), `luna.dev` (`@luna/dev`), `luna.native` (`@luna/lib.native`), and every loaded plugin's exports in `luna.core.modules[<package name>]`. Call any export directly, e.g. Redux state `luna.lib.redux.store.getState()`.
- Main process: global `luna` holds Luna's exposed native functions and `luna.modules[<file>]`, every plugin's loaded `*.native.ts` exports (call directly). `require("electron")` for windows, sessions, app. Electron's `fs` reads inside asars: `require("fs").readdirSync(process.resourcesPath + "/original.asar")`.
- Find TIDAL code to hook: `dump`, then grep `.tidal-test/<n>/sources`. Only modules TIDAL loaded so far get dumped: navigate (or trigger feature) first for lazy ones. Luna's own bundles (with sourcemaps) in `dist/`.
- Plugins and load errors: `Object.values(luna.core.LunaPlugin.plugins).map((p) => ({ name: p.name, enabled: p.enabled, loadError: p.loadError._ }))`
- Manage plugins through `luna.core.LunaPlugin`, the same API Luna Settings uses. Don't curl plugin urls or write IndexedDB by hand:
  - `const p = await luna.core.LunaPlugin.fromStorage({ url: "<base url, no .mjs/.json>" })` loads one (fetches `<url>.json`), then `p.install()` (persists, enables, swaps out other installed versions of same name), `p.enable()`/`p.disable()`, `p.reload()`, `p.uninstall()`. Existing: `LunaPlugin.getByName(name)`, `LunaPlugin.plugins` (by url), `LunaPlugin.reloadAll()`, `LunaPlugin.dumpStorage()`.
  - Plugin stores (Plugin Store tab): `const urls = await luna.core.ReactiveStore.getStore("@luna/pluginStores").getReactive("storeUrls")`, an array without `/store.json`; `push`/`splice` it (persists, tab updates). Store contents: fetch `<storeUrl>/store.json`.
  - Plugin settings: `await luna.core.ReactiveStore.getPluginStorage(name)`, live reactive object the plugin reads.
- Open Luna Settings: `luna.ui.settingsPage.open()`, pick tab with `luna.ui.SettingsTabs.open("Themes")`.
- Redux: every TIDAL action type is key of `luna.core.buildActions`; dispatch with `luna.lib.redux.actions[type](payload)`, state via `luna.lib.redux.store.getState()`.
- `@luna/dev` (`luna.dev`) exists for this; read `plugins/dev/src` for current exports. Main ones:
  - Logging, saved in `luna.dev.storage` (persists, applied on plugin load; set then `luna.core.LunaPlugin.getByName("@luna/dev").reload()`): `logReduxEvents` (every Redux action with payload, filtered by regex `logInterceptsRegex`), `logIPCFromNative` (Native → Render IPC), `logIPCFromRender` (Render → Native IPC). IPC logs also toggle directly: `luna.dev.startNativeIPCLog()`/`stopNativeIPCLog()`, `startRenderIpcLog()`/`stopRenderIpcLog()`. Read with `logs`/`main.log`; turn off when done.
  - TIDAL IPC channel names: `luna.dev.getNativeIPCEvents()`, `luna.dev.getRenderIPCEvents()`.
  - `luna.dev.startNativeDebugging()` starts main-process inspector in client launched without `--inspect`, e.g. user's daily client. Test instance already has one on 9331.

## Don't

- Start playback: instance uses user's account (login copied from daily client), so playback pauses their daily client. Only TIDAL login copied, not Luna plugins or settings.
- Move or resize test window: window position shared with daily client.
- Keep retrying frozen instance: plugin native code may have opened "Security Warning" dialog in main process. Ask user to answer it.
