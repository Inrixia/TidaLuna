---
name: tidal-test-instance
description: Launch a side-by-side TIDAL test instance running this repo's Luna build (dist/), then drive it over CDP: evaluate JS in the page or the main process, read console logs, live reload, dump TIDAL's render and native sources, take screenshots, make raw DevTools Protocol calls (click/type, navigate, profile, debug). Use when asked to run, start or test Luna or TIDAL, to check that plugins load, to reproduce or debug a runtime bug, to find TIDAL internals to hook, or to screenshot the UI. Windows and Linux (tidal-hifi).
---

# TIDAL test instance

Separate TIDAL client: own profile, this repo's `dist/` as Luna. Runs beside user's daily client. Lives in `.tidal-test/` (gitignored): `.app/` is a copy of the TIDAL install (several hundred MB) shared by this worktree's instances, `<name>/` one instance (profile, `main.log`). Drive with:

```sh
node .agents/skills/tidal-test-instance/tidal.mjs [--instance <name>] <command>
```

| Command                                         | Does                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start [--no-login]`                            | No `--instance`: creates new instance with random name, prints it. With `--instance <name>`: starts that one (creates it if new). Waits for Luna load. Logged out: copies daily client login (its `Local Storage`, replacing the instance's own one), restarts. `--no-login`: skips that copy, stays logged out.                   |
| `remove --instance <name>`                      | Stops the instance, then deletes its folder: profile and the copied login. Don't remove instances you didn't start, like `stop`.                                                                                                                                                                                                   |
| `list`                                          | This worktree's instances: running, busy (starting or being removed) or stopped.                                                                                                                                                                                                                                                   |
| `reload`                                        | Reloads page, waits for Luna. Picks up rebuilt `luna.mjs` (`render/`), `preload.mjs`, all plugins.                                                                                                                                                                                                                                 |
| `eval "<expression>"`                           | Evaluates in page (renderer), awaits promises, prints result as compact JSON, cut at 20k chars (return plain data, not DOM nodes).                                                                                                                                                                                                 |
| `native "<expression>"`                         | Same in Electron main process (Node inspector). `require` available.                                                                                                                                                                                                                                                               |
| `wait "<expression>" [seconds]`                 | Re-evaluates in page until truthy (default 30s), prints value. Use instead of sleep loops.                                                                                                                                                                                                                                         |
| `logs [seconds] [--since <n>]`                  | Page console since TIDAL started (incl. forwarded `[Luna.native]` logs, exceptions, across reloads), then follows for `seconds`. Last line `(next: --since <n>)`: pass it next time to get only new lines.                                                                                                                         |
| `repl [--native]`                               | Many steps in one call: one stdin line each, expression or `:command`, see below. **Prefer it** over separate commands.                                                                                                                                                                                                            |
| `dump [dir]`                                    | Writes TIDAL's loaded web modules to `<dir>/render`, main-process sources (`original.asar`, no `node_modules`) to `<dir>/native`. Default `.tidal-test/<name>/sources`.                                                                                                                                                            |
| `screenshot <file.png>`                         | Saves screenshot. Write to scratchpad, Read it to see UI.                                                                                                                                                                                                                                                                          |
| `cdp [--native] <method> ['<params json>'] ...` | Raw DevTools Protocol calls on page (or main process with `--native`), in order on one session, prints each result. See below.                                                                                                                                                                                                     |
| `stop [--all]`                                  | Kills only this instance's processes. Folder (profile, login) stays: `start --instance <name>` resumes it. `--all` (no `--instance`): stops every running instance of this worktree, also ones still starting (a start waiting for a lock or the install copy then doesn't launch), other agents' too, so only when the user asks. |
| `setup [installDir]`                            | Sets up `.tidal-test/.app` from install (default: newest `%LOCALAPPDATA%\TIDAL\app-*` on Windows, `/opt/tidal-hifi` on Linux). `start` does it itself with default install. Copies the install (several hundred MB, a while on a slow disk).                                                                                       |

Ports picked by OS per launch, never collide; `start` prints them (CDP, main process inspector). Each running instance has host process (`tidal.mjs __host`) owning TIDAL, so instance outlives command that started it; host keeps page console for `logs`. Main-process stdout/stderr go to `.tidal-test/<name>/main.log`: live native console (all native logs incl. before window exists, crashes).

**Every agent (and every subagent) gets its own instance.** Run `start` with no `--instance`, note printed name, pass `--instance <name>` to every later command. Names are random, so parallel agents never collide. Never `stop` or use instance you didn't start, unless user names it.

Login:

- Default, `start` without flags: a logged out instance gets the daily client's login, so it behaves like the real client. Use this.
- `start --no-login`: stays logged out, only to test logged out behaviour. It works on an instance that has no login yet: use a fresh instance. One that already has a login keeps it, and a plain `start` of a running logged out instance restarts it with the copied login, so pass `--no-login` again every time.
- The copied login is a real refresh token in the instance's profile: when finished, run `remove --instance <name>` so it doesn't linger. A start killed hard (shell or tool-call timeout) skips its own cleanup and can leave the login behind, so `remove` also after a start that didn't end normally. Stopped instances otherwise stay, `start --instance <name>` resumes them.

Failure to start: `start` error includes tail of `main.log`, and it stops the instance it launched. Read the log before retrying. `start` of an instance already starting waits for that start. `stop --all` clears instances left running.

TIDAL window opens behind other windows and never takes focus (user keeps working); nothing else shows a window.

## repl: batch steps in one call

Each command run costs a tool call plus startup. Put a whole check into one `repl` heredoc instead:

```sh
node .agents/skills/tidal-test-instance/tidal.mjs --instance <name> repl <<'EOF'
Object.keys(luna.core.modules).length
:native process.pid
:reload
:wait 10 document.readyState === 'complete' && 'ready'
:logs
:screenshot <scratchpad>/ui.png
EOF
```

PowerShell has no heredoc: `@'` newline, lines, newline `'@ | node .agents/skills/tidal-test-instance/tidal.mjs --instance <name> repl`.

Output: each line echoed as `> line`, then its result (compact JSON, errors as one `Error: ...` line; batch continues after errors). Line = page expression (main process with `repl --native`), or:

- `:eval <expr>`, `:native <expr>`: page / main process.
- `:wait [seconds] <expr>`: until truthy (default 30s).
- `:logs`: page console lines since repl start or last `:logs`.
- `:reload`, `:screenshot <file.png>`.
- `:cdp <Method> [params json]`: raw DevTools Protocol call on page; one session for whole repl, so `<Domain>.enable` applies to later lines.

One expression per line: wrap multi-statement code in `(() => { ...; return x })()` or `(async () => ...)()`. Interactive: run `repl` in a terminal kept open (background process, write lines to its stdin) and send lines as needed.

## DevTools Protocol

All Chrome DevTools does goes over these ports. Full schema (types, descriptions, every domain/method/event): `curl http://127.0.0.1:<CDP port>/json/protocol` (page), `<inspector port>/json/protocol` (main process, Node's subset: Runtime, Debugger, Profiler, HeapProfiler…), ports from `start`. `cdp` calls any of it; put `<Domain>.enable` first when method needs it. Examples:

- Click/type in UI: `cdp Input.dispatchMouseEvent '{"type":"mousePressed","x":100,"y":200,"button":"left","clickCount":1}' Input.dispatchMouseEvent '{"type":"mouseReleased","x":100,"y":200,"button":"left","clickCount":1}'`, `cdp Input.insertText '{"text":"query"}'`. Get coordinates from `eval` (`getBoundingClientRect()`) or screenshot.
- Navigate in app: `eval 'luna.lib.redux.actions["router/PUSH"]({ pathname: "/my-collection/albums", search: "", replace: false })'`. (`cdp Page.navigate` does full page load, like `reload`.)
- Metrics/memory: `cdp Performance.enable Performance.getMetrics`, `cdp --native Runtime.getHeapUsage`.
- Calls needing open session across other steps (profiling across user actions): `repl` `:cdp` lines share one session. Event streams and pausing breakpoints don't fit: write short Node script reusing `connect` from `tidal.mjs`, or use `eval`/`native` (e.g. wrap function to log calls).

User can attach real Chrome DevTools too (live consoles, sources with Luna sourcemaps, breakpoints, profiler): `chrome://inspect` → Configure → add `127.0.0.1:<CDP port>` and `127.0.0.1:<inspector port>`. F12 or Ctrl+Shift+I in window opens its page DevTools.

## Workflow

1. Build with `pnpm exec tsx ./esbuild.config.ts` (add `--watch`, run in background to rebuild on change). Same as `pnpm run build`/`watch` minus deleting `dist/` first — matters since dev's daily client often runs from this `dist/` too. Every build reaches daily client on next load: revert and rebuild when done with test change.
2. Run `start` (no `--instance`), note printed name.
3. Apply changes, fastest first:
   - Plugins: `eval 'Object.values(luna.core.LunaPlugin.plugins).forEach((p) => (p.liveReload = true))'` once (saved in test profile); with `--watch` running, each plugin reloads ~1s after rebuild, native code included. Or reload one: `eval 'luna.core.LunaPlugin.getByName("@luna/ui").reload()'`.
   - `render/`, `native/preload.ts`: `reload`.
   - Rest of `native/` (main process): `stop` then `start --instance <name>`.
4. Check result in one `repl` batch (`:wait`, `:logs`, `:screenshot`, expressions), then `stop`.

## Hooks into the client

- Page: global `luna` console variable (`window.luna` / `globalThis.luna`) exposes all core functionality for debugging: `luna.core` (`@luna/core`: `LunaPlugin`, `modules`, `tidalModules`, `reduxStore` …), `luna.lib` (`@luna/lib`), `luna.ui` (`@luna/ui`), `luna.dev` (`@luna/dev`), `luna.native` (`@luna/lib.native`), and every loaded plugin's exports in `luna.core.modules[<package name>]`. Call any export directly, e.g. Redux state `luna.lib.redux.store.getState()`.
- Main process: global `luna` holds Luna's exposed native functions and `luna.modules[<file>]`, every plugin's loaded `*.native.ts` exports (call directly). `require("electron")` for windows, sessions, app. Electron's `fs` reads inside asars: `require("fs").readdirSync(process.resourcesPath + "/original.asar")`.
- Find TIDAL code to hook: `dump`, then grep `.tidal-test/<name>/sources`. Only modules TIDAL loaded so far get dumped: navigate (or trigger feature) first for lazy ones. Luna's own bundles (with sourcemaps) in `dist/`.
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
  - `luna.dev.startNativeDebugging()` starts main-process inspector in client launched without `--inspect`, e.g. user's daily client. Test instance already has one (port printed by `start`).

## Don't

- Start playback: instance uses user's account (login copied from daily client), so playback pauses their daily client. Only TIDAL login copied, not Luna plugins or settings.
- Move or resize test window: window position shared with daily client.
- Keep retrying frozen instance: plugin native code may have opened "Security Warning" dialog in main process. Ask user to answer it.
