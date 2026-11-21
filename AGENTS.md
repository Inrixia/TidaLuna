# AGENTS.md

Guidance for coding agents (and humans) in this repo.

Luna (TidaLuna) = client mod for TIDAL desktop app (Electron). Takes over TIDAL's app entry, loads plugin system into page. pnpm workspace (`native`, `render`, `plugins/*`), TypeScript, bundled with esbuild.

## Commands

- `pnpm i`: install.
- `pnpm run build`: clean build into `dist/`. `pnpm run watch` rebuilds on change.
- `pnpm exec tsc --noEmit -p .`: typecheck (few seconds). master already has errors; judge only errors in code you touched.
- No test suite. Verify with typecheck + build. For runtime behaviour, run TIDAL test instance ([docs/test-instances.md](docs/test-instances.md)) and inspect over CDP; `.claude/skills/tidal-test-instance/` has script that sets up, starts, inspects one in `.tidal-test/` (Windows and Linux).
- `pnpm run format` broken (targets `./src`, doesn't exist). Run `pnpm exec prettier --write <file>` on files you create.

## Architecture

Three runtimes, all built by `esbuild.config.ts` into `dist/`:

- **`native/` → `injector.mjs`**, Electron main-process entry (package.json `main`). Luna's `dist` installed as TIDAL's `resources/app`; TIDAL's own `app.asar` renamed `original.asar`, which injector boots. Wraps `BrowserWindow` (adds Luna's preload, forces sandbox + contextIsolation on TIDAL's window) and handles `https` protocol: strips TIDAL's CSP, marks TIDAL's module scripts `type="luna/quartz"`, serves `https://luna/*` from bundle folder (`TIDALUNA_DIST_PATH` overrides folder).
  - `native/NativeModule/` runs plugin native code (`__Luna.registerNative`) in `vm` sandbox. Node modules outside `moduleWhitelist.ts` prompt user; answers saved in encrypted trust store. Security boundary.
- **`native/preload.ts` → `preload.mjs`** exposes `__ipcRenderer` and `__platform` to page, imports `luna.mjs`.
- **`render/` → `luna.mjs`** is `@luna/core`:
  - `exposeTidalInternals*.ts` re-runs TIDAL's module scripts through `@uwu/quartz` to capture its modules, Redux store, action creators. This layer breaks when TIDAL updates.
  - `modules.ts` = runtime module registry (`luna.core.modules`) plugins import `@luna/*`, react, oby from.
  - `LunaPlugin.ts` = plugin lifecycle: fetch `<url>.json` and `<url>.mjs`, import code from blob, track `unloads` and dependants, live reload.
  - `ReactiveStore.ts` persists reactive (oby) stores to IndexedDB. `trace/` holds loggers.
- **`plugins/*`** = core plugins:
  - `lib`: Redux intercepts and actions with typed payloads, classes like `MediaItem`, `PlayState`, `TidalApi`, and helpers.
  - `lib.native`: main-process helpers.
  - `ui`: settings page and MUI components.
  - `dev`: dev tools.
  - `linux`: tidal-hifi bridge, loaded on Linux only.

  Served from `https://luna/luna.<name>`, loaded in order set in `render/src/index.ts`, can't be disabled in UI.

- **`build/`** = esbuild tooling. Also exported as `luna/build` and `luna/buildPlugins` for third-party plugin repos, so changes here change how external plugins build.
  - `pluginBuildOptions` builds plugin entry to `dist/<name>.mjs` (`@luna/lib` → `luna.lib.mjs`). Keeps `@luna/*`, react, react-dom/client, react/jsx-runtime, oby, electron external; `dynamicExternals` resolves them at runtime from `luna.core.modules` and registers importing plugin as dependant.
  - `writeBundlePlugin` writes each bundle plus `<name>.json` (plugin's package.json with `hash`; loader refetches code when hash changes).
  - `lunaNativePlugin` handles `*.native.*` imports (see below).
  - `fileUrl` makes `import css from "file://styles.css?minify"` give file contents as string (`?base64`; `?minify` works for .css and .html).
  - `buildPlugins.ts` builds every folder in `./plugins`, writes `dist/store.json`.
- **`nix/` and `flake.nix`** package Luna for tidal-hifi (Linux) and TIDAL.app (macOS).

Reload core plugin changes from Luna Settings; changes to `native/` or `render/` need client restart.

## Plugin conventions

- Plugin entry exports `unloads` (`Set<LunaUnload>`), optionally `errSignal`, `Settings` (React component shown in Luna Settings), `onUnload`. See `LunaPlugin.loadExports`.
- Anything plugin registers takes its `unloads` set, so disable/reload cleans it up: `redux.intercept(...)`, `new StyleTag(...)`, `safeTimeout(...)`, `ipcRenderer.on(...)` etc. Don't register anything without it.
- `index.safe.ts` holds `unloads` and plugin's `Tracer`. Other modules import from it, not `index.ts`, to avoid import cycles.
- `*.native.ts` files run in main process. Build bundles each separately, replaces it in renderer bundle with one async IPC stub per export (channel `__LunaNative.<file>`). So export only functions (types fine); every renderer call is async; args and return values must survive structured cloning. Inside repo, import native modules by relative path (e.g. `../../lib.native/src/index.native`).
- Redux: `redux.intercept(type, unloads, cb)` runs `cb` when action created; return `true` to cancel. `redux.actions[type](payload)` dispatches. `redux.interceptActionResp` waits for success or fail action. Action and store types in `plugins/lib/src/redux/types`.
- Log through `Tracer`: `trace.log/warn/err`; `trace.msg.*` also shows message in TIDAL. `.withContext(...)` adds context, `.throw` rethrows. When plugin exports `errSignal`, errors logged with `trace.err` show on its card in Luna Settings.
- Persist plugin settings with `ReactiveStore.getPluginStorage(name, defaults)`.
- `plugins/lib/src/{classes,helpers,redux}` and `plugins/ui/src/{components,components/settings,helpers}` have barrel `index.ts` files: export new files from them.
- Path aliases (`@luna/core`, `@luna/lib`, `@luna/ui` etc) defined in root `tsconfig.json`.

## Style

- Prettier: tabs, `printWidth` 145, semicolons. Many files not Prettier-clean; match surrounding code, don't reformat files you only edit.

## Gotchas

- **Pushing a new `version` in root `package.json` to `master` or `dev` publishes release** (`.github/workflows/build.yml`): GitHub release tagged with `version` (prerelease on `dev`). Versions already released are skipped, never overwritten. Version-bump commits use bare version as message, e.g. `1.22.0-beta`.
- `pnpmDeps` hashes in `nix/injection-linux.nix` and `nix/injection-darwin.nix` depend on `pnpm-lock.yaml` and differ per platform. CI (`.github/workflows/nix-hashes.yml`) recomputes and commits them after lockfile/nix changes land on `master`/`dev`; PRs don't need to update them.
- Code must work on official TIDAL (Windows/macOS) and tidal-hifi (Linux). They load differently: on Linux, Luna replaces tidal-hifi's preload instead of adding one, and handles login in popup window. See `platformIsLinux` branches in `native/injector.ts`.
- Keep security checks intact: `NativeModule` sandbox and trust prompts, `openExternal` allowing only http(s) (`native/expose.ts`), path-traversal guard in `bundleFile` (`native/injector.ts`).