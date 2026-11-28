# tsconfig and tooling

The repo's tsconfig and lint setup win. Never loosen a flag, add `skipLibCheck`-style escapes or suppressions to get a check green; fix the code or ask.

## Baseline (new projects)

Shared by every shape:

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "skipLibCheck": true,
    "target": "esnext", // or the oldest runtime you ship to
    "lib": ["esnext"] // add "dom", "dom.iterable" for browser code
  }
}
```

Then pick one shape:

| Shape | Add |
|-------|-----|
| Bundled app (Vite, esbuild, framework) | `"module": "preserve"`, `"moduleResolution": "bundler"`, `"noEmit": true` |
| Node library/app compiled by tsc | `"module": "nodenext"`, `"outDir": "dist"`, libraries: `"declaration": true`, `"declarationMap": true`, `"isolatedDeclarations": true` |
| Runs directly in Node (type stripping) | `"module": "nodenext"`, `"noEmit": true`, `"erasableSyntaxOnly": true`, `"rewriteRelativeImportExtensions": true` (import `./x.ts`) |

Optional strictness: `exactOptionalPropertyTypes` (catches `undefined` vs missing, noisy with some libraries), `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`.

## Current TypeScript notes (7.0, verified 2026-11)

- Native (Go) compiler: much faster `tsc`. Classic programmatic API not available until 7.1; tools that import `typescript` as a library may need TS 6 side by side.
- Defaults: `strict: true`, `module: esnext`, `types: []` (list needed globals: `"types": ["node"]`, `["vite/client"]`).
- Removed: `target: es5`, `baseUrl`, `moduleResolution: node`/`node10`/`classic`, `module: amd/umd/system`. `esModuleInterop` is always on.
- Path aliases: `paths` without `baseUrl` (relative to the tsconfig), or package.json `imports` (`#alias`, preferred: Node and bundlers resolve it natively).

## Node type stripping

- Current Node runs `.ts` directly (no flag). Only erasable syntax: no `enum`, `namespace`, parameter properties, `import x = require()`. Enforce with `erasableSyntaxOnly`.
- Node does not read tsconfig `paths` and does not type-check: run `tsc --noEmit` in CI.
- Type-only imports must use `import type` (`verbatimModuleSyntax` enforces it).

## Monorepos

- Project references (`composite: true`, `references`) for incremental builds; `tsc -b`.
- One base config (`tsconfig.base.json`) extended per package; per-package `include`.
- Workspace protocol deps (`workspace:*`) over path hacks.

## Linting

- Use the repo's linter. Do not switch or add a linter unasked.
- Type-aware rules that matter: `no-floating-promises`, `no-misused-promises`, `await-thenable`, `switch-exhaustiveness-check`, `no-unnecessary-condition`, `restrict-template-expressions`. They need type information (typescript-eslint `projectService: true`).
- typescript-eslint on TS 7: classic backend needs TS 6 installed; an experimental tsgo backend exists (`projectService.EXPERIMENTAL_backend: "tsgo"`). Check the repo before changing.
- oxlint (fast, ESLint-compatible rule subset, type-aware via tsgolint) and Biome (formatter + linter) are alternatives or complements, not drop-in replacements.
- Suppressions: `// eslint-disable-next-line <rule> -- <reason>`, never file-wide, never to hide a real bug.

## Slow type-checking

`tsc --extendedDiagnostics` / `--generateTrace`; usual culprits are huge unions, deep recursive conditional types, and missing return types on exported functions in big modules. Split with project references.
