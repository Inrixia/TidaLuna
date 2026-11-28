---
name: typescript
description: TypeScript design and review beyond the house rules - type-level patterns, errors, async, modules/packaging, runtime validation, tsconfig. Use when writing or reviewing non-trivial .ts/.tsx, designing types or public APIs, handling errors/async, validating external data, or touching tsconfig/package.json exports.
---

# TypeScript

Verified against TypeScript 7.0 (2026-11). Repo's installed version, tsconfig, lint config and conventions win; check them before using newer syntax. House rules (`type` by default, no `any`/`enum`/`!`, error wrapping) live in the TypeScript rules file and always apply.

## Rules

- Model states as discriminated unions (`kind`/`status` literal), not bags of optional fields. Make illegal states unrepresentable.
- Parse, don't validate: functions take `unknown` at trust boundaries (JSON, env, network, IPC, user input) and return a typed value. Derive types from schemas (`z.infer`), never a parallel hand-written type.
- `satisfies` to check a literal against a type while keeping its narrow type; annotate when consumers need the wide type.
- Generics: constrain to the narrowest bound; no type parameter used only once (use the bound); `NoInfer<T>` on secondary positions; `<const T extends readonly unknown[]>` for literal tuples.
- Branded types for validated scalars (`UserId`, `Email`); the single cast lives in the validating function.
- Errors: throw for bugs and unexpected failures; return a result union only for expected domain failures the caller must branch on. Handle at boundaries (request handler, CLI entry, UI error boundary), not at every call.
- Inside `try`, `return await` so rejections are caught there. Never `new Promise(async ...)`.
- Concurrency: `Promise.all` for independent work, `allSettled` when partial failure is acceptable, bound fan-out for large lists.
- Prefer platform APIs over helpers/deps: `structuredClone`, `Object.groupBy`, `Array.prototype.toSorted/at/findLast`, `AbortSignal.timeout/any`, `using`/`await using`.
- Casts (`as`) are a last resort with a one-line why; never `as unknown as T` to silence a real mismatch.
- Libraries: named exports only, `exports` map with `types` first, options object for 2+ optional params, explicit return types on exports.
- Type-check with the repo's script (e.g. `tsc --noEmit`) after edits; never loosen tsconfig or add suppressions to pass.

## References

- `references/types.md`: read when writing generics, conditional/mapped types, guards, exhaustiveness, brands or utility recipes.
- `references/errors-async.md`: read when designing error flow, custom errors, result types, promises, cancellation or disposal.
- `references/modules-api.md`: read when touching imports/exports, ESM/CJS, package.json `exports`, or a library's public API and semver.
- `references/validation.md`: read when handling external data, env vars, or choosing a schema library.
- `references/tsconfig.md`: read when creating or changing tsconfig, lint setup, or running TS directly in Node.
