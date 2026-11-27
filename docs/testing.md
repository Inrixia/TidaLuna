# Unit testing

Luna's unit tests are `*.test.ts` files next to the code, run by [vitest](https://vitest.dev). They cover the logic that can be exercised without TIDAL: redux interception, media data, TIDAL api calls, the native sandbox and permission store, the esbuild plugin tooling.

They do **not** replace the TIDAL test instance ([test-instances.md](test-instances.md)). TIDAL's DOM, React fiber tree, minified module graph and Electron boot are only real in the app, so behaviour that depends on them is verified by driving a test instance, not here.

## Commands

```sh
pnpm test             # all projects
pnpm test:watch       # watch mode
pnpm run coverage     # v8 report in ./coverage + thresholds from vitest.config.ts
pnpm run coverage:ci  # as CI runs it, also writing coverage/test-results.json
pnpm run coverage:badge  # regenerate .github/badges/*.json from the last coverage run
```

Run one file or one project:

```sh
pnpm exec vitest run --project dom plugins/lib/src/classes/Playlist.test.ts
pnpm exec vitest run --project node native/OfflineResponses/OfflineResponses.test.ts
```

Two projects, because the code runs in two places:

| Project | Environment                                            | Includes                                      |
| ------- | ------------------------------------------------------ | --------------------------------------------- |
| `node`  | node, `electron` aliased to `test/harness/electron.ts` | `cache/**`, `native/**`, `build/**`           |
| `dom`   | happy-dom, fake-indexeddb                              | `render/**`, `plugins/**`, `test/**`          |

## The `@luna/core` stand-in

`render/src/index.ts` boots TIDAL: it re-exports `exposeTidalInternals.ts`, which awaits TIDAL's scripts at module scope and touches `document`. Importing it in a test throws `window is not defined`, and with a DOM it would hang on the top-level await. Almost every `plugins/lib` module value-imports it, so tests get `test/harness/core.ts` instead:

- **Real:** `Cache` (and `cache/` exports), `sharedRequests`, `unloadSet`, `ReactiveStore`, `findModuleProperty`/`findModuleByProperty`/`recursiveSearch`, `buildActions`, `interceptors`, `tidalModules`, `ftch`, and a `Tracer` with the real logger shape.
- **Faked:** `reduxStore` (a real redux store shaped like TIDAL's, `test/harness/tidalStore.ts`), `LunaPlugin`, `modules`.

`SettingsTransfer` is deliberately not in the stand-in: it imports `render/src/LunaPlugin.ts`, which loads boot code (`nativeScrollbars.ts`). Its test `vi.mock`s that import, and so must anything else that needs it.

`test/harness/core.test.ts` asserts the stand-in still exports everything `render/src/index.ts` does, so a new core export fails a test instead of failing a module import later. `test/harness/imports.test.ts` asserts the library modules import without TIDAL.

## Writing a test

- Import `@luna/core` normally in the source; in the test use `test/harness/tidalStore.ts` (`setTidalState`, `reduxStore`) to shape TIDAL's state, and `test/harness/actions.ts` (`mockAction`) to observe or override a dispatched action.
- `buildActions` is copied into `redux/actions.ts` **once, at import**, so action builders have to be seeded before that module loads — `test/setup-dom.ts` does it for the actions Luna dispatches. `setup-dom`/`setup-node` also provide `__ipcRenderer`, `__platform`, `luna`, and (dom) fake-indexeddb and a `MediaSession` stub.
- Native modules import `electron` at module scope; the node project aliases it to `test/harness/electron.ts`. Caches that write to `userData` point it at a scratch directory with `setUserDataDir(await mkdtemp(...))` (import that file by relative path, it is the same module instance the alias resolves to).
- Module-level state (playlist change queues, `sharedRequests`, `TidalApi` memoization, `ContentBase`'s instance cache) lasts for the whole file: give each test its own ids, or `vi.resetModules()` plus a dynamic import.
- Determinism: no network, no real sleeps (`vi.useFakeTimers`), temp directories under `os.tmpdir()`, unique indexeddb store names.
- Assert the real behaviour. When the code does something surprising, pin it with a comment and report it rather than encoding the behaviour you expected.

## Coverage

`vitest.config.ts` lists what is meant to be unit tested and excludes boot code, Electron entry points, plugin barrels, type-only modules, and the `lib.native`/`linux`/`dev` plugins, which need a real app or CDN. Thresholds are floors a little under what the suite measures; **raise them as tests are added, never lower them to make a build pass**.

The floors live in [test/coverageThresholds.ts](../test/coverageThresholds.ts), and they only go up. `pnpm run coverage:thresholds` lifts them to just under the current measurement; CI runs it on every push to `master`/`dev` and commits the result, so a PR that adds tests doesn't have to touch the file and the number can't go stale.

## Badges

The badges at the top of the README are [shields.io endpoint](https://shields.io/badges/endpoint-badge) badges. They read JSON committed under `.github/badges/`, because shields fetches it over raw.githubusercontent.com — so the values are as fresh as the last commit to `master`/`dev`.

`pnpm run coverage:badge` writes them from `coverage/coverage-summary.json` (and `coverage/test-results.json`, when `coverage:ci` produced it). CI runs `coverage:ci` then `coverage:badge` on every build and commits the result when it changed; nothing to regenerate by hand unless you want the badge to reflect a local run.

Known gaps, best value first:

1. `plugins/lib/src/classes/MediaItem/MediaItem.ts` and `MediaItem.tags.ts` — the largest untested library file.
2. `render/src/LunaPlugin.ts` — plugin lifecycle; needs fetch, blob module imports and IPC faked.
3. `native/NativeModule/trust.ts` and `permissions/window.ts` — the permission prompts (the window needs more of the `BrowserWindow` fake).
4. `build/index.ts` — `pluginBuildOptions`/`makeBuildOpts`, the public API third-party plugin repos build against.
5. `plugins/lib/src/classes/{Album,Artist,Shortcut,ImageOverrides,ContextMenu}.ts` and the remaining `helpers/*`.
6. MUI components in `plugins/ui` — they need `react` installed, which Luna otherwise takes from TIDAL at runtime.
