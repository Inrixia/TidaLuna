# AGENTS.md

Guidance for coding agents (and humans) in repo.

Luna (TidaLuna) = client mod for TIDAL desktop app (Electron). Takes over TIDAL app entry, loads plugin system into page. pnpm workspace (`native`, `render`, `plugins/*`), TypeScript, esbuild bundling.

## Commands

- `pnpm i`: install.
- `pnpm run build`: clean build into `dist/`. `pnpm run watch` rebuilds on change.
- `pnpm exec tsc --noEmit -p .`: typecheck (few sec). master already has errors; judge only errors in touched code.
- No test suite. Verify with typecheck + build. For runtime behaviour, run TIDAL test instance ([docs/test-instances.md](docs/test-instances.md)); `.claude/skills/tidal-test-instance/` has script that sets one up in `.tidal-test/` (Windows, Linux) and drives it: page + main-process eval, console logs, live reload, TIDAL render/native source dump to grep for hooks, screenshots.
- `pnpm run format` broken (targets nonexistent `./src`). Run `pnpm exec prettier --write <file>` on files you create.

## Architecture

Three runtimes, all built by `esbuild.config.ts` into `dist/`:

- **`native/` → `injector.mjs`**, Electron main-process entry (package.json `main`). Luna `dist` installed as TIDAL `resources/app`; TIDAL `app.asar` renamed `original.asar`, which injector boots. Wraps `BrowserWindow` (adds Luna preload, forces sandbox + contextIsolation on TIDAL window), handles `https` protocol: strips TIDAL CSP, marks TIDAL module scripts `type="luna/quartz"`, serves `https://luna/*` from bundle folder (`TIDALUNA_DIST_PATH` overrides).
  - `native/NativeModule/` runs plugin native code (`__Luna.registerNative`). Files named `*.isolated.native.*` (imported from renderer code, not plugin main entry) each run in own sandboxed renderer process (`isolated/`, preload built to `nativeHost.preload.mjs`): no Node, no Electron, no network, never asked; `require` knows only modules in `isolated/syncModules.ts`. Everything else runs in main process in `vm` sandbox. Node modules outside `moduleWhitelist.ts` are asked for by category (`permissions/categories.ts`), one window per native file; answers saved in encrypted store, kept per plugin url (checked against what the url serves) or per code hash. Core plugin native code with sha256 in `luna.natives.json` beside `injector.mjs` is never asked (still sandboxed), see `coreNatives.ts`. Security boundary.
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
- `*.native.ts` run in main process, `*.isolated.native.ts` in sandboxed process without Node (use it for code that only computes). Build bundles each separately, replaces it in renderer bundle with one async IPC stub per export (channel `__LunaNative.<file>`). So export only functions (types fine); every renderer call async; args + return values must survive structured cloning. In repo, import native modules by relative path (e.g. `../../lib.native/src/index.native`).
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

## Gotchas

- **Pushing new `version` in root `package.json` to `master` or `dev` publishes release** (`.github/workflows/build.yml`): GitHub release tagged `version` (prerelease on `dev`). Already-released versions skipped, never overwritten. Version-bump commits use bare version as message, e.g. `1.22.0-beta`.
- `pnpmDeps` hashes in `nix/injection-linux.nix` + `nix/injection-darwin.nix` depend on `pnpm-lock.yaml`, differ per platform. CI (`.github/workflows/nix-hashes.yml`) recomputes + commits them after lockfile/nix changes land on `master`/`dev`; PRs needn't update them.
- Code must work on official TIDAL (Windows/macOS) and tidal-hifi (Linux). Load differs: on Linux, Luna replaces tidal-hifi preload instead of adding one, handles login in popup window. See `platformIsLinux` branches in `native/injector.ts`.
- Keep security checks intact: `NativeModule` sandbox + trust prompts, `openExternal` allowing only http(s) (`native/expose.ts`), path-traversal guard in `bundleFile` (`native/injector.ts`).