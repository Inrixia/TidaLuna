# Writing Tests

## Structure and Assertions

- Organize with `describe` (unit/feature) and `test` or `it` (single behavior); keep Arrange, Act, Assert distinct.
- Assert public outputs, thrown errors, and side effects at boundaries. Avoid `(result as any)` casts; narrow types or assert shapes directly.
- Use `toBe` for primitives/references, `toEqual` for deep structural equality, `toStrictEqual` to catch `undefined` properties and class mismatches.
- Use `expect.soft()` inside a `test` body to report multiple non-fatal assertion failures in one run without aborting early.
- In v5, `toThrow('')` matches any error message (substring match). Assert an empty message with `toThrow(/^$/)`.

## Async Assertions

- Always `await` `.resolves`, `.rejects`, `expect.poll()`, and `toMatchFileSnapshot()`; unawaited async assertions fail the test in v5.
- `expect.poll(fn, { timeout, interval })` rejects on timeout in v5 and passes `{ signal }` (`AbortSignal`) to cancel in-flight work:

```ts
await expect.poll(async ({ signal }) => {
  const res = await fetch('/api/health', { signal })
  return res.status
}, { timeout: 1000, interval: 50 }).toBe(200)
```

## Concurrency and Ordering

- Use `test.concurrent` or `describe.concurrent` for independent I/O-bound tests.
- Destructure `{ expect }` from `TestContext` inside concurrent tests so snapshots and assertions bind to the right test:

```ts
test.concurrent('loads user', async ({ expect }) => {
  expect(await fetchUser('1')).toEqual({ id: '1' })
})
```

- Opt out of suite/file concurrency with `{ concurrent: false }` (v5 removed `test.sequential` and `describe.sequential`):

```ts
describe('shared port', { concurrent: false }, () => {
  test('starts listener', { concurrent: false }, async () => { /* ... */ })
})
```

## Parameterized Tables (`test.for` vs `test.each`)

- Prefer `test.for` when you need `TestContext` (for example `{ expect }` in concurrent tests). `test.for` passes each array row as a single parameter; `test.each` spreads array rows.
- In v5, `$key` placeholders format with `pretty-format` without wrapping strings in quotes (`case a1`, not `case 'a1'`).

```ts
test.concurrent.for([
  [1, 2, 3],
  [2, 3, 5],
])('adds %i + %i = %i', ([a, b, sum], { expect }) => {
  expect(a + b).toBe(sum)
})
```

## Snapshots

- Default to `toEqual`/`toStrictEqual` for plain objects and arrays.
- Use `toMatchInlineSnapshot()` for small, stable serialized output (formatted errors, short HTML/CLI strings) reviewed inline in diffs.
- Use `await expect(html).toMatchFileSnapshot('./fixtures/out.html')` for large generated files rather than `.snap` blobs.

## Type-Level Tests (`*.test-d.ts`)

- Put static type assertions in `*.test-d.ts` and run with `vitest run --typecheck` (or `--typecheck.only`). Vitest does not execute `*.test-d.ts` at runtime.
- Use `expectTypeOf` with `.toExtend()` (replaces deprecated `.toMatchTypeOf()`), `.toEqualTypeOf()`, or `.toMatchObjectType()` for strict plain-object checks.
- Combine `assertType<T>()` with `// @ts-expect-error` for negative cases:

```ts
import { assertType, expectTypeOf, test } from 'vitest'
import { createUser } from './user-service.js'

test('createUser types', () => {
  expectTypeOf(createUser).parameter(0).toExtend<{ name: string }>()
  expectTypeOf(createUser).returns.resolves.toMatchObjectType<{ id: string }>()
  // @ts-expect-error name must be string
  assertType(createUser({ name: 42 }))
})
```

## Benchmarks (v5)

- `bench` is a `TestContext` fixture inside `test()`, not a top-level import:

```ts
import { test } from 'vitest'

test('sort benchmark', async ({ bench }) => {
  await bench('sort', () => { [3, 1, 2].sort() }).run()
})
```
