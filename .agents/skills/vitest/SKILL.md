---
name: vitest
description: Vitest 5 test runner, mocking, timers, snapshots, coverage, and TypeScript type testing for JS/TS projects. Use when writing, debugging, or configuring tests (*.test.ts, *.spec.ts, *.test-d.ts, vitest.config.ts), mocking with vi or MSW, testing types (expectTypeOf), or migrating from Jest.
---

Default test framework and test-writing rules for JS/TS projects. Verified against Vitest 5.x (2026-11). Repo's installed version and conventions win; check package.json/lockfile before using newer APIs.

## Rules

- Use Vitest for every JS/TS project. If touching an existing Jest suite, migrate to Vitest only when the task allows; otherwise follow the repo setup and note the Jest usage.
- Follow the repo's existing test layout, naming (`*.test.ts` vs `*.spec.ts`), `setupFiles`, and test helpers before introducing new patterns.
- Never run watch mode (`vitest` without `run`). Run focused tests with `vitest run <path> -t "name"`, then run `vitest run` for the suite.
- Test behavior through the public API, not internal implementation or private calls.
- Keep one behavior per test with a descriptive name and clear Arrange-Act-Assert structure.
- For bug fixes, write a failing regression test that reproduces the bug before applying the fix.
- Keep tests deterministic: use `vi.useFakeTimers()`, seeded inputs, and MSW for HTTP; never hit real external networks or rely on wall-clock time.
- Mock at boundaries only (network, time, filesystem, randomness), not your own modules by default.
- Type all test doubles (`vi.fn<Fn>()`, `vi.mocked(fn)`). Prefer `vi.spyOn` over manual property reassignment, and restore spies via `restoreMocks: true` or `vi.restoreAllMocks()` (`clearMocks` defaults to `true` in v5; `restoreMocks` defaults to `false`).
- Place `vi.mock`, `vi.unmock`, and `vi.hoisted` at module top level only (nested calls throw in v5).
- Always `await` async assertions (`.resolves`, `.rejects`, `expect.poll`, `toMatchFileSnapshot`); unawaited assertions fail in v5.
- Prefer explicit assertions (`toEqual`, `toStrictEqual`) over broad `.snap` files; use `toMatchInlineSnapshot()` only for small, stable output.
- Use `test.for` or `test.each` for tabular cases instead of copy-pasted tests.
- Never commit `.only` (`test.only`, `describe.only`).
- For React component rendering, accessible queries, and `user-event`, read the `react` skill.

## References

- [references/writing-tests.md](references/writing-tests.md) - read when writing or structuring unit, async, concurrent, parameterized, snapshot, or `*.test-d.ts` type tests.
- [references/mocking.md](references/mocking.md) - read when mocking modules, spies, globals, env vars, fake timers, or HTTP with MSW.
- [references/config.md](references/config.md) - read when configuring `vitest.config.ts`, `test.projects`, environments, coverage, typecheck, or CI flags.
- [references/migrating.md](references/migrating.md) - read when migrating Jest tests to Vitest or upgrading Vitest 4 suites to Vitest 5.
