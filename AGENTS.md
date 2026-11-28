# AGENTS.md

Guidance for coding agents (and humans) in repo.

Luna (TidaLuna) = client mod for TIDAL desktop app (Electron). Takes over TIDAL app entry, loads plugin system into page. pnpm workspace (`native`, `render`, `plugins/*`), TypeScript, esbuild bundling.

## Commands

- `pnpm i`: install.
- `pnpm run build`: clean build into `dist/`. `pnpm run watch` rebuilds on change.
- `pnpm exec tsc --noEmit -p .`: typecheck (few sec). master already has errors; judge only errors in touched code.
- `pnpm test`: unit tests (vitest). `native/**` + `build/**` run in the node project, `render/**`, `plugins/**` + `test/**` in happy-dom. `pnpm run coverage` adds a v8 report and enforces the floors in `test/coverageThresholds.ts`. Tests sit next to the code as `*.test.ts`.
- Tests import `@luna/core` as usual but get `test/harness/core.ts` instead: it re-exports the real `requestCache`, `unloadSet`, `ReactiveStore`, `findModule` helpers, `buildActions`, `interceptors` and `Tracer`, and fakes only `reduxStore` (a real redux store shaped like TIDAL's, `test/harness/tidalStore.ts`), `LunaPlugin` and `modules`. `render/src/index.ts` boots TIDAL (top-level `await` on its scripts) so it can never be imported in a test. Anything importing `render/src/LunaPlugin.ts` (`SettingsTransfer`, `applySeedSettings`) must be `vi.mock`ed.
- Verify with typecheck + tests + build. For runtime behaviour, run TIDAL test instance ([docs/test-instances.md](docs/test-instances.md)); `.claude/skills/tidal-test-instance/` has script that sets one up in `.tidal-test/` (Windows, Linux) and drives it: page + main-process eval, console logs, live reload, TIDAL render/native source dump to grep for hooks, screenshots. Writing tests is documented in [docs/testing.md](docs/testing.md).
- Test instance: `node .claude/skills/tidal-test-instance/tidal.mjs start` (no `--instance`) creates your own instance and prints its name; pass `--instance <name>` to every later command. Never share one with other agents.
- `pnpm run format` broken (targets nonexistent `./src`). Run `pnpm exec prettier --write <file>` on files you create.

## Architecture

Three runtimes, all built by `esbuild.config.ts` into `dist/`:

- **`native/` → `injector.mjs`**, Electron main-process entry (package.json `main`). Luna `dist` installed as TIDAL `resources/app`; TIDAL `app.asar` renamed `original.asar`, which injector boots. Wraps `BrowserWindow` (adds Luna preload, forces sandbox + contextIsolation on TIDAL window), handles `https` protocol: strips TIDAL CSP, marks TIDAL module scripts `type="luna/quartz"`, serves `https://luna/*` from bundle folder (`TIDALUNA_DIST_PATH` overrides).
  - `native/NativeModule/` runs plugin native code (`__Luna.registerNative`) in `vm` sandbox. Before any of a file's code runs, user is asked once whether it may run in main process (`vm` limits honest code, not hostile code, so answer is for whole file; Node modules are not asked for one by one). Window lists modules the source names outside `moduleWhitelist.ts`, grouped by `permissions/categories.ts`, for information only. Answers saved in encrypted store per plugin: per plugin url (checked against what the url serves), or per url named + code hash while it can't be checked. Never shared between plugins, even for identical code. Core plugin native code with sha256 in `luna.natives.json` beside `injector.mjs` is never asked (still sandboxed), see `coreNatives.ts`. Security boundary.
- **`native/preload.ts` → `preload.mjs`** exposes `__ipcRenderer`, `__platform` to page, imports `luna.mjs`.
- **`render/` → `luna.mjs`** = `@luna/core`:
  - `exposeTidalInternals*.ts` re-runs TIDAL module scripts through `@uwu/quartz` to capture modules, Redux store, action creators. Breaks on TIDAL updates.
  - `modules.ts` = runtime module registry (`luna.core.modules`) plugins import `@luna/*`, react, oby from.
  - `LunaPlugin.ts` = plugin lifecycle: fetch `<url>.json` + `<url>.mjs`, import code from blob, track `unloads` + dependants, live reload. At runtime install/enable/disable/reload plugins and edit plugin stores through it (`luna.core.LunaPlugin`), not by fetching plugin urls by hand; see tidal-test-instance skill.
  - `ReactiveStore.ts` persists reactive (oby) stores to IndexedDB. `trace/` holds loggers.
  - `window.core.ts` exposes `luna` as a global console variable on `window`/`globalThis` for debugging, giving direct access to all core functionality (`luna.core`, `luna.lib`, `luna.ui`, `luna.dev`, `luna.native`, and any loaded plugin via `luna.core.modules[<pkg>]`). In the main process, `globalThis.luna` (`native/NativeModule/index.ts`) similarly exposes `luna.modules[<file>]`, `sendToRender`, and `native/expose.ts` helpers.
- **`plugins/*`** = core plugins:
  - `lib`: Redux intercepts + actions with typed payloads, classes like `MediaItem`, `PlayState`, `TidalApi`, helpers.
  - `lib.native`: main-process helpers.
  - `ui`: settings page, MUI components.
  - `dev`: dev tools.
  - `linux`: tidal-hifi bridge, Linux only.

  Served from `https://luna/luna.<name>`, loaded in order set in `render/src/index.ts`, can't disable in UI.

- **`build/`** = esbuild tooling. Also exported as `luna/build` + `luna/buildPlugins` for third-party plugin repos, so changes here change external plugin builds.
  - `pluginBuildOptions` builds plugin entry to `dist/<name>.mjs` (`@luna/lib` → `luna.lib.mjs`). Keeps `@luna/*`, react, react-dom/client, react/jsx-runtime, oby, electron external; `dynamicExternals` resolves them at runtime from `luna.core.modules`, registers importing plugin as dependant.
  - `writeBundlePlugin` writes each bundle + `<name>.json` (plugin package.json with `hash`; loader refetches code on hash change).
  - `lunaNativePlugin` handles `*.native.*` imports (see below).
  - `fileUrl` makes `import css from "file://styles.css?minify"` give file contents as string (`?base64`; `?minify` works for .css, .html).
  - `buildPlugins.ts` builds every folder in `./plugins`, writes `dist/store.json`. For Luna own build also writes `dist/luna.natives.json` (sha256 of core plugin native code).
- **`nix/` and `flake.nix`** package Luna for tidal-hifi (Linux) + TIDAL.app (macOS).

Plugin changes (native too) apply on plugin reload or live reload; `render/` + `native/preload.ts` on page reload; rest of `native/` needs client restart.

## Plugin conventions

- Plugin entry exports `unloads` (`Set<LunaUnload>`), optionally `errSignal`, `Settings` (React component in Luna Settings), `onUnload`. See `LunaPlugin.loadExports`.
- Everything plugin registers takes its `unloads` set so disable/reload cleans up: `redux.intercept(...)`, `new StyleTag(...)`, `safeTimeout(...)`, `ipcRenderer.on(...)` etc. Never register anything without it.
- `index.safe.ts` holds `unloads` + plugin `Tracer`. Import from it, not `index.ts`, to avoid cycles.
- `*.native.ts` run in main process. Build bundles each separately, replaces it in renderer bundle with one async IPC stub per export (channel `__LunaNative.<file>`). So export only functions (types fine); every renderer call async; args + return values must survive structured cloning. In repo, import native modules by relative path (e.g. `../../lib.native/src/index.native`).
- Redux: `redux.intercept(type, unloads, cb)` runs `cb` on action creation; return `true` to cancel. `redux.actions[type](payload)` dispatches. `redux.interceptActionResp` waits for success/fail action. Action + store types in `plugins/lib/src/redux/types`.
- Log via `Tracer`: `trace.log/warn/err`; `trace.msg.*` also shows message in TIDAL. `.withContext(...)` adds context, `.throw` rethrows. If plugin exports `errSignal`, `trace.err` errors show on its card in Luna Settings.
- Persist plugin settings with `ReactiveStore.getPluginStorage(name, defaults)`.
- `plugins/lib/src/{classes,helpers,redux}` and `plugins/ui/src/{components,components/settings,helpers}` have barrel `index.ts`: export new files from them.
- Path aliases (`@luna/core`, `@luna/lib`, `@luna/ui` etc) in root `tsconfig.json`.

## Reuse before writing

- Before writing function, search for existing one: `@luna/core` exports (`render/src/index.ts`), every core plugin barrel (`plugins/*/src`), `native/`, `@inrixia/helpers`. Use it like surrounding code does. If almost fits, extend it; don't write near-duplicate or work around it.
- Don't hand-roll mechanics with shared owner, e.g. finding TIDAL modules/functions, DOM watching, hooking Redux/TIDAL state, timers + listeners tied to `unloads`, styles, IPC, TIDAL API, media data. Check for helper first.
- Write generically reusable code in owning layer, exported from its barrel: renderer helpers in `lib`, main-process helpers in `lib.native`, components in `ui`, loader-level code in `render/` or `native/`. Keep only plugin-specific logic in plugin.

## Style

- Prettier: tabs, `printWidth` 145, semicolons. Many files not Prettier-clean; match surrounding code, don't reformat files you only edit.

## Tests

- Fixes + features come with a test: vitest, in `<file>.test.ts` beside the code it tests. Layout, the `@luna/core` harness and the coverage rules are in [docs/testing.md](docs/testing.md).
- Run `pnpm test` before PR; CI runs it on every PR (`.github/workflows/test.yml`).
- Coverage floors live in `test/coverageThresholds.ts` and only ever go up. When your PR raises coverage, `pnpm run coverage:thresholds` lifts them to just under what the suite now measures; CI runs the same thing on every push to `master`/`dev` and commits the result, so the file stays current without anyone remembering to bump it. Never lower a floor to make a build pass — add the test instead.

## Gotchas

- **Pushing new `version` in root `package.json` to `master` or `dev` publishes release** (`.github/workflows/build.yml`): GitHub release tagged `version` (prerelease on `dev`). Already-released versions skipped, never overwritten. Version-bump commits use bare version as message, e.g. `1.22.0-beta`.
- `pnpmDeps` hashes in `nix/injection-linux.nix` + `nix/injection-darwin.nix` depend on `pnpm-lock.yaml`, differ per platform. CI (`.github/workflows/nix-hashes.yml`) recomputes + commits them after lockfile/nix changes land on `master`/`dev`; PRs needn't update them.
- Code must work on official TIDAL (Windows/macOS) and tidal-hifi (Linux). Load differs: on Linux, Luna replaces tidal-hifi preload instead of adding one, handles login in popup window. See `platformIsLinux` branches in `native/injector.ts`.
- Keep security checks intact: `NativeModule` sandbox + trust prompts, `openExternal` allowing only http(s) (`native/expose.ts`), path-traversal guard in `bundleFile` (`native/injector.ts`).
