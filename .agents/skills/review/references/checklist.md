# Review checklist

Language specifics live in the `typescript`, `react`, `rust`, `vitest` skills. This list is cross-cutting. Skip categories the diff cannot affect.

## Correctness
- Every input class: empty, null/undefined, zero, negative, max size, unicode, duplicates, unsorted.
- Every state: first run, retry, concurrent callers, partial failure, cancellation, restart mid-operation.
- Error paths: what happens on each throw/reject/`Err`; is anything left half-written; are errors swallowed or downgraded.
- Off-by-one, inverted conditions, wrong operator (`||` vs `??`, `==` vs `===`), shadowed variables, stale closures.
- Async: missing `await`, unhandled rejections, races after an `await`, ordering assumptions, missing cleanup/abort.
- Resource lifetime: listeners, timers, subscriptions, file handles, connections released on every path.
- Time and locale: time zones, DST, clock skew, locale-dependent formatting/sorting.
- Data changes: migrations reversible, backwards compatible with running code, old data still readable.

## Intent
- Does the change do what the PR/issue says, all of it, and nothing unrelated?
- Behavior changes not mentioned in the description (defaults, error messages, public API, output format).
- Out-of-scope code: belongs in another change.

## Design and simplicity
- Duplication: near-copies of existing code or of each other. Share what can be shared so the difference is obvious; diverging copies need a comment saying why.
- Reinvented helpers: the codebase, stdlib or an installed dependency already does it.
- Unneeded abstraction, options, config or indirection added "for later".
- New dependency for a few lines of code.
- Names say what the thing is or returns (predicates named for their answer: `isReady()`, not `shouldSkip()`).
- Magic numbers: derive from the spec they encode, or use the smallest value tied to actual use.
- Stringly-typed errors and states where a union/enum with data belongs.

## Tests
- Would the tests fail without the change? A test that passes on the old code proves nothing.
- Behavior tested through the public surface, not internals or mocks of the unit itself.
- Edge and error cases from the Correctness list covered where they matter.
- No `.only`, no skipped tests, no weakened assertions, no sleeps (fake timers instead).
- Snapshots small and reviewed, not blanket.

## Security (trust boundaries)
- Untrusted input validated at the boundary; no `as`-casting external data.
- Injection: SQL, shell (`exec` with interpolation), HTML (`dangerouslySetInnerHTML`, `innerHTML`), path traversal, SSRF, regex DoS, prototype pollution.
- AuthN/AuthZ checked on the server for every new route/action; no trust in client-side checks or hidden fields.
- Secrets: none in code, logs, errors, URLs or client bundles. Tokens redacted in logs.
- Crypto: platform primitives only, constant-time comparison for secrets, no homemade schemes.
- Dependencies: new packages are maintained, expected, and pinned by the lockfile.

## Performance (only where it matters)
- N+1 queries/requests, work inside hot loops, unbounded fan-out or memory growth, missing pagination.
- Blocking calls on async paths/UI thread, sync I/O in request handlers.
- Do not flag micro-optimizations without a measurement.

## Diff hygiene
- No spurious changes: whitespace, reordering, moved code without reason, unrelated formatting.
- Comments explain why, are correct after the change, and do not restate code or each other. Stale comments updated or removed.
- No debug leftovers (`console.log`, `dbg!`, commented-out code, TODOs without an owner).
- Generated files, lockfiles and snapshots changed only when the change requires it.
