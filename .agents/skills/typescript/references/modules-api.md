# Modules and public API

## Modules

| Do | Instead of | Note |
|----|-----------|------|
| `import type { Foo }` / `import { a, type Foo }` | value import for types | required under `verbatimModuleSyntax` |
| `export type { Foo }` | `export { Foo }` for a type | required under `isolatedModules` |
| `import "./x.js"` under `nodenext` | `"./x"` | Node ESM needs the output extension (TS maps `.js` to `.ts`) |
| `import "./x.ts"` + `rewriteRelativeImportExtensions` | mixing styles | when the repo runs `.ts` directly or emits with rewriting |
| `moduleResolution: "bundler"` | `node`/`node10` | Vite/esbuild/bundled apps; extensionless imports OK |
| `.mts` / `.cts` | relying on `type` for one file | force a file's format |
| `import.meta.dirname` / `import.meta.filename` | `__dirname` in ESM | CJS globals do not exist in ESM |
| `node:fs/promises` | `fs` | builtin prefix |
| package.json `imports` (`"#lib/*": "./src/lib/*"`) | deep `../../..` or `paths` + `baseUrl` | works at runtime in Node and bundlers |
| direct imports from the defining file | `index.ts` barrels | barrels cause cycles, slow tests, defeat tree-shaking |

- New packages: ESM (`"type": "module"`). CJS consumers on current Node can `require()` ESM unless it uses top-level await.
- Default-import CJS packages (`import express from "express"`); `esModuleInterop` is always on in current TS.
- Avoid side effects at module top level (I/O, global mutation, timers): it makes import order matter and breaks tests.
- Circular imports: break them by moving the shared piece to its own module, not by lazy `require`.

## package.json for libraries

```json
{
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "sideEffects": false
}
```

- `types` first in every condition. Every public entry point listed; anything not listed is private.
- Dual ESM/CJS only if consumers need it; then separate `.d.ts`/`.d.cts` per format.
- Types consumers need (`@types/*` used in public signatures) go in `dependencies`.
- Run `publint` and `@arethetypeswrong/cli` when `exports` or build output changes.

## Public API design

- Named exports only; no `export default` at library entry points.
- Explicit return types on exported functions (required by `isolatedDeclarations`, which speeds `.d.ts` emit for libraries).
- Options object for 2+ optional parameters; positional only for 1-2 required, obvious params.
- Overloads when argument combinations change the return type; union params otherwise.
- Generic defaults when callers usually omit the type (`T = unknown`); `NoInfer<T>` on fallbacks.
- Accept wide, return narrow: params `readonly T[]`/`Iterable<T>`, return concrete types.
- No `enum`/`const enum` in public types: `as const` object plus value union.
- Errors: document what throws; export error classes or a discriminant (`code`) consumers can check.
- TSDoc (`/** ... */`, `@param name - desc`, `@deprecated` with replacement) on public symbols; no JSDoc `{type}` annotations in TS.

## Semver for types

Breaking: adding a required property to an input type; removing/renaming an export or property; widening a mutable property type; narrowing a parameter type; changing `interface` to `type` or back (merging behavior changes); raising the minimum TS or Node version.
Non-breaking: adding optional input properties; adding exports; narrowing a `readonly` output property; widening a parameter type.
Deprecate (`@deprecated`) in a minor, remove in the next major.
