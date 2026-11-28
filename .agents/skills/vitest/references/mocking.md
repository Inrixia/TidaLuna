# Mocking, Timers, and MSW

## Typed Mocks and Spies

- Provide a function signature to `vi.fn<Fn>()` so arguments and returns do not leak `any`.
- Narrow mocked imports with `vi.mocked(fn)` instead of casting to `Mock`.
- Use `vi.spyOn(obj, 'method')` instead of mutating properties manually; use `using` (Explicit Resource Management) or `afterEach(() => vi.restoreAllMocks())` to clean up:

```ts
import { expect, test, vi } from 'vitest'

test('logs error', () => {
  using spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  reportFailure('disk full')
  expect(spy).toHaveBeenCalledWith('disk full')
})
```

## Cleanup Lifecycle (Vitest 5)

| Option / Helper | Default (v5) | Effect |
|-----------------|--------------|--------|
| `clearMocks` / `vi.clearAllMocks()` | `true` | Clears call history before each test; keeps implementations |
| `mockReset` / `vi.resetAllMocks()` | `false` | Clears history and resets mock implementations |
| `restoreMocks` / `vi.restoreAllMocks()` | `false` | Restores original descriptors on `vi.spyOn` spies (not automocks) |
| `unstubEnvs` / `vi.unstubAllEnvs()` | `false` | Restores `process.env` and `import.meta.env` changed by `vi.stubEnv` |
| `unstubGlobals` / `vi.unstubAllGlobals()` | `false` | Restores globals changed by `vi.stubGlobal` |

- Because `clearMocks: true` runs before every test in v5, mock calls recorded in `beforeAll` or module setup are cleared before the test body runs.
- Global `clearMocks` and `restoreMocks` affect all active mocks; avoid relying on them alongside `test.concurrent`.

## Module Mocking

- `vi.mock`, `vi.unmock`, and `vi.hoisted` are hoisted and throw in v5 if placed inside `describe`, `test`, or blocks. Keep them at module top level.
- Use `vi.hoisted()` when a `vi.mock` factory references local mock variables:

```ts
import { beforeEach, expect, test, vi } from 'vitest'
import { createUser } from './user-service.js'

const { insert } = vi.hoisted(() => ({ insert: vi.fn<(name: string) => Promise<{ id: string }>>() }))

vi.mock('./db.js', () => ({ insert }))

beforeEach(() => {
  insert.mockResolvedValue({ id: '42' })
})

test('createUser stores the user and returns its id', async () => {
  expect(await createUser('Alice')).toEqual({ id: '42', name: 'Alice' })
  expect(insert).toHaveBeenCalledWith('Alice')
})
```

- Partial module mock: `await vi.importActual<typeof import('./mod.js')>('./mod.js')` (do not forget `await`).
- Spy on real module exports without replacing them: `vi.mock('node:fs', { spy: true })`.
- Dynamic non-hoisted mocks inside a test: `vi.doMock()` / `vi.doUnmock()` followed by dynamic `await import(...)`.
- In v5, class mocks (`vi.fn(Class)`, `.mockImplementation(class ...)`) preserve the prototype chain and `instanceof`.

## Env and Globals

- Prefer `vi.stubEnv('API_URL', 'http://localhost')` and `vi.stubGlobal('innerWidth', 100)` over direct mutation so `vi.unstubAllEnvs()` / `vi.unstubAllGlobals()` (or config flags) restore originals.

## Fake Timers

- Enable fake timers per test or `beforeEach` and always call `vi.useRealTimers()` in `afterEach`.
- Advance async timer chains with `await vi.advanceTimersByTimeAsync(ms)`.
- In v5, `vi.useFakeTimers()` and `vi.setSystemTime()` also mock global `Temporal` when present; opt out with `vi.useFakeTimers({ toNotFake: ['Temporal'] })`.
- Do not include `'nextTick'` in `toFake` when using `--pool=forks` (hangs `node:child_process`).

## Network Mocking with MSW

- Mock HTTP at the network boundary with `msw/node` (`setupServer`) instead of stubbing `fetch`.
- Wire `server.listen`, `server.resetHandlers()`, and `server.close()` in `setupFiles`. In MSW v3, `onUnhandledRequest` was renamed to `onUnhandledFrame`:

```ts
// test/setup-msw.ts
import { afterAll, afterEach, beforeAll } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

export const server = setupServer(
  http.get('https://api.example.com/user', () => HttpResponse.json({ id: '1' })),
)

beforeAll(() => server.listen({ onUnhandledFrame: 'error' })) // MSW v2: onUnhandledRequest
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
```

- Override per test with `server.use(http.get(..., () => HttpResponse.json(..., { status: 500 })))`; `resetHandlers()` restores the initial handlers after each test.
