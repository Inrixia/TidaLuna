# Errors and async

## Errors

- `catch (e)` binds `unknown` under `strict`. Do not annotate `any`.
- Add context by wrapping, unconditionally. `cause` accepts `unknown`, so no type check is needed:

```ts
try {
  return await readFile(path, "utf8");
} catch (e) {
  throw new Error(`load config ${path}`, { cause: e });
}
```

- Narrow only to use a property, and narrow on what you need:

```ts
catch (e) {
  // isRecord: guard from types.md
  if (isRecord(e) && e.code === "ENOENT") return defaults; // expected case handled
  throw e; // everything else propagates untouched
}
```

- Is it an `Error` at all (e.g. to log `.message`)? `Error.isError(e)` works across realms (iframes, vm, workers) where `instanceof` fails; needs a runtime with it and `lib` including `esnext`. Fallback `e instanceof Error`. For display: `Error.isError(e) ? e.message : String(e)`.
- Do not catch just to rethrow unchanged, or to log and rethrow (double reporting). Catch where you recover, translate (domain error, HTTP status), or add context.
- Never swallow: no empty `catch`, no `catch { return null }` that makes failure look like an empty result. Intentional ignore gets a comment naming why.
- Throw only `Error` or subclasses (`.stack`, `.message`, `cause`).
- Subclasses: forward options, set `name`, add typed fields. Discriminate on a literal field rather than `instanceof` chains when errors cross package or realm boundaries.

```ts
class HttpError extends Error {
  override readonly name = "HttpError";
  readonly status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}
```

- Expected domain failures the caller must handle (validation, not-found, conflict): return a result union instead of throwing.

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

function parsePort(raw: string): Result<number, "not-a-number" | "out-of-range"> {
  const n = Number(raw);
  if (!Number.isInteger(n)) return { ok: false, error: "not-a-number" };
  if (n < 1 || n > 65_535) return { ok: false, error: "out-of-range" };
  return { ok: true, value: n };
}
```

Use a Result library (neverthrow, Effect) only if the repo already does. Do not mix styles within one module.
- Multiple failures: `AggregateError` (or `Promise.any` rejection) carries `.errors`.
- Process level: unhandled rejections crash Node by default; keep it that way. Log and exit in `process.on("uncaughtException")` only at the entry point.

## Async

| Do | Instead of | Note |
|----|-----------|------|
| `await Promise.all([a(), b()])` | sequential awaits of independent work | parallel |
| `Promise.allSettled` + check `.status` | `Promise.all` when partial failure is fine | never rejects |
| `Promise.any` | manual fallback chains | first success, `AggregateError` if all fail |
| `fetch(url, { signal: AbortSignal.timeout(ms) })` | `setTimeout` + manual controller | rejects with `TimeoutError` |
| `AbortSignal.any([userSignal, AbortSignal.timeout(ms)])` | racing signals by hand | combined cancellation |
| `for await (const x of stream)` | manual `.next()` loop | calls `return()` on early exit |
| `await using conn = await pool.connect()` | try/finally cleanup | `Symbol.asyncDispose` |
| sync executor `new Promise((resolve, reject) => ...)` | `new Promise(async ...)` | async executor loses throws |
| `return await p` inside `try` | `return p` inside `try` | otherwise the rejection skips your catch |
| bounded concurrency (`p-limit` or chunking) | `Promise.all` over 10k items | resource exhaustion |

- Accept an `AbortSignal` in long-running APIs (`{ signal }` option), pass it down to `fetch`/streams/timers (`setTimeout` from `node:timers/promises` takes `{ signal }`), and check `signal.throwIfAborted()` between steps.
- Floating promises: every promise is awaited, returned, or has `.catch(handler)`. Event handlers that must be sync: `onClick={() => void save().catch(report)}`.
- `async` without `await` misleads; drop it unless the function must return a promise.
- Do not `await` non-thenables.
- Order in one turn: sync code, then `process.nextTick` queue, then promise microtasks (`.then`, `queueMicrotask`), then macrotasks (timers, I/O, `setImmediate`).
- Top-level `await` only in ESM; it blocks importers until resolved.
- Races: re-check state after every `await` when it can change (stale responses, unmounted components). Use a request id or abort the previous request.
