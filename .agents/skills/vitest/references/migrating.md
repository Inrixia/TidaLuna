# Migrating to Vitest 5

## Jest to Vitest Mapping

Only migrate an existing Jest suite when the task allows it.

| Jest | Vitest | Notes |
|------|--------|-------|
| `jest.fn()` | `vi.fn()` | Add generic type `vi.fn<Fn>()` |
| `jest.spyOn()` | `vi.spyOn()` | Supports `using` cleanup |
| `jest.mock(path, () => val)` | `vi.mock(path, () => ({ default: val }))` | Factory must return explicit exports object |
| `jest.requireActual(path)` | `await vi.importActual(path)` | Async in Vitest; always `await` |
| `jest.unmock()` / `jest.doMock()` | `vi.unmock()` / `vi.doMock()` | `vi.unmock` must be top-level in v5 |
| `jest.useFakeTimers()` | `vi.useFakeTimers()` | Also mocks `Temporal` in v5 |
| `jest.advanceTimersByTime(ms)` | `await vi.advanceTimersByTimeAsync(ms)` | Prefer async helper for Promise-based timers |
| `jest.setSystemTime(d)` | `vi.setSystemTime(d)` | Also sets `Temporal.Now` in v5 |
| `jest.clearAllMocks()` | `vi.clearAllMocks()` | Runs automatically before each test in v5 |
| `jest.resetAllMocks()` | `vi.resetAllMocks()` | Resets implementations and history |
| `jest.restoreAllMocks()` | `vi.restoreAllMocks()` | Restores `vi.spyOn` spies (or `restoreMocks: true`) |
| `jest.setTimeout(ms)` | `vi.setConfig({ testTimeout: ms })` | Or pass `{ timeout: ms }` per test |
| `test('x', (done) => ...)` | `test('x', async () => ...)` | Callback `done` unsupported; use `async` or `new Promise` |
| `jest.Matchers` augmentation | `vitest.Matchers<R, T>` | Vitest 5 ignores Jest global matcher types |
| `jest.config.ts` / `ts-jest` | `vitest.config.ts` (`defineConfig`) | Reuses Vite pipeline; no Babel or `ts-jest` |

## Vitest 4 to Vitest 5 Breaking Changes

- **Runtime**: Node >= 22.12 and Vite >= 6.4 required; `vite` is a peer dependency (install explicitly if using Yarn).
- **`clearMocks` defaults to `true`**: Call history clears before every test while implementations stay. Calls recorded at module top level or in `beforeAll` are cleared before tests run.
- **Top-level hoisting enforced**: `vi.mock`, `vi.unmock`, and `vi.hoisted` inside blocks, `describe`, or `test` now throw instead of warning. Use `vi.doMock` for dynamic mocking.
- **Unawaited async assertions fail**: `.resolves`, `.rejects`, and `toMatchFileSnapshot` fail the test when not awaited.
- **`expect.poll` fails on timeout**: Rejects if the callback or assertion exceeds `timeout`; callback receives `{ signal }`.
- **Sequential option removed**: `test.sequential`, `describe.sequential`, and `{ sequential: true }` were removed; use `{ concurrent: false }`.
- **`bench` fixture**: Top-level `bench` import removed; destructure `{ bench }` from `test('name', async ({ bench }) => await bench(...).run())`.
- **`-t` / `testNamePattern` separator**: Matches `' > '`-joined names (`'math > adds'`), not space-joined (`'math adds'`).
- **Inline `test.projects` inheritance**: `extends` defaults to `true` and `sharedViteServer` defaults to `true`; set `extends: false` to isolate.
- **`.vitest/` artifacts**: `json` and `junit` reporters write to `.vitest/json/output.json` and `.vitest/junit/output.xml` instead of stdout; pass `{ stdout: true }` if piping.
- **`toMatchTypeOf` deprecated**: Replaced by `toExtend` (or `toMatchObjectType` for strict plain objects) in `expectTypeOf`.
- **Fake timers mock `Temporal`**: `vi.useFakeTimers()` and `vi.setSystemTime()` mock `Temporal`; opt out with `toNotFake: ['Temporal']`.
- **`toThrow('')`**: Empty string matches any error message; assert empty messages with `toThrow(/^$/)`.
- **Coverage patterns and `perFile`**: `coverage.include`/`exclude` match relative to root (no `contains`); glob thresholds no longer inherit top-level `perFile`.
- **Type parameters on `Assertion`**: `Assertion<R, T>` takes return type `R` first (`void` or `Promise<void>`).
- **1-based worker IDs**: `VITEST_WORKER_ID` and `VITEST_POOL_ID` start at `1` instead of `0`.
- **No parent config lookup**: Config files are no longer discovered in parent directories; pass `--config` explicitly.
