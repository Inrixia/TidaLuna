---
name: tidal-test-instance
description: Launch a side-by-side TIDAL test instance running this repo's Luna build (dist/), then inspect it over CDP (evaluate JS, take screenshots) to verify a change in the real client. Use when asked to run, start or test Luna or TIDAL, to check that plugins load, to reproduce a runtime bug, or to screenshot the UI. Windows and Linux (tidal-hifi).
---
# TIDAL test instance

Separate TIDAL client: own install copy, own profile, this repo's `dist/` as Luna. Runs beside user's daily client, lives in `.tidal-test/<n>/` (gitignored). Drive with:

```sh
node .claude/skills/tidal-test-instance/tidal.mjs [--instance <n>] <command>
```

| Command                 | Does                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup [installDir]`    | Copies TIDAL install (default: newest `%LOCALAPPDATA%\TIDAL\app-*` on Windows, `/opt/tidal-hifi` on Linux), links its `resources/app` to `dist/`. Copies several hundred MB: ask user first. |
| `start`                 | Launches instance if not running, waits for Luna load. Logged out: copies daily client login (its `Local Storage`), restarts, so instance logged in as user.                                 |
| `eval "<expression>"`   | Evaluates in page, awaits promises, prints result as JSON (return plain data, not DOM nodes).                                                                                                |
| `screenshot <file.png>` | Saves screenshot. Write to scratchpad, Read it to see UI.                                                                                                                                    |
| `stop`                  | Kills only this instance's processes.                                                                                                                                                        |

Instance `n` uses CDP port `9230 + n` (default instance 1, port 9231).

## Workflow

1. Run `setup` if `.tidal-test/1/app` missing (ask first).
2. Build with `pnpm exec tsx ./esbuild.config.ts`. Same as `pnpm run build` minus deleting `dist/` first — matters because dev's daily client often runs from this `dist/` too. Every build reaches daily client on next load: revert and rebuild when done with test change.
3. Run `start`.
4. After rebuilding core plugin, reload in place: `eval 'luna.core.LunaPlugin.getByName("@luna/ui").reload()'`. Changes to `native/` or `render/` need `stop` then `start`.
5. Check result with `eval` and `screenshot`, then `stop`.

Useful expressions:

- Plugins and load errors: `Object.values(luna.core.LunaPlugin.plugins).map((p) => ({ name: p.name, enabled: p.enabled, loadError: p.loadError._ }))`
- Open Luna Settings: `luna.ui.settingsPage.open()`, pick tab with `luna.ui.SettingsTabs.open("Themes")`.

Main-process (`native/`) logs reach page console with `[Luna.native]` prefix.

## Don't

- Start playback: instance uses user's account (login copied from daily client), so playback pauses their daily client. Only TIDAL login copied, not Luna plugins or settings.
- Move or resize test window: window position shared with daily client.
- Keep retrying frozen instance: plugin native code may have opened "Security Warning" dialog in main process. Ask user to answer it.