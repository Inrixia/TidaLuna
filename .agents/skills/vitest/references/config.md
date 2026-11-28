# Configuration and CLI

## Requirements and Config Resolution

- Vitest 5 requires Node >= 22.12 and Vite >= 6.4 (`vite` is a required peer dependency).
- Configure in `vitest.config.ts` using `defineConfig` from `vitest/config` (or merge with Vite config).
- Vitest 5 does not search parent directories for config files. When running from a subdirectory, pass `--config ../vitest.config.ts`.

## Environments and Setup

- `test.environment`: `'node'` (default), `'jsdom'`, `'happy-dom'`, or `'edge-runtime'`. Override per file with `// @vitest-environment jsdom` at top of file.
- `test.setupFiles`: runs before each test file (extend matchers, start MSW server, register global cleanup).
- `test.globalSetup`: runs once per test run (databases, test containers).
- `test.globals` defaults to `false`; prefer explicit imports from `'vitest'` unless a repo relies on globals.

## Projects (`test.projects`)

- `test.projects` replaced `workspace`.
- In Vitest 5, inline projects inherit the root config by default (`extends: true`) and share one Vite server (`sharedViteServer: true`):
  - Arrays like `setupFiles` concatenate with root values; `tags` replace inherited tags.
  - `name`, `projects`, and root `globalSetup` are not inherited.
  - Set `extends: false` on an inline project to opt out of root inheritance.
- Referenced config files or directories do not inherit the root config and can define nested `projects`.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    restoreMocks: true,
    setupFiles: ['./test/setup.ts'],
    projects: [
      { test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'dom', include: ['src/**/*.dom.test.tsx'], environment: 'jsdom' } },
    ],
  },
})
```

## Coverage

- Default provider is `'v8'` (`@vitest/coverage-v8`).
- By default, coverage only tracks imported files. Set `coverage.include` (for example `['src']` or `['src/**/*.ts']`) to include untested source files.
- In v5, `coverage.include` and `coverage.exclude` match relative to project root without `contains` matching (`'src'` matches `'src/**'`).
- In v5, glob thresholds under `coverage.thresholds` do not inherit top-level `perFile: true`; set `perFile: true` per glob if needed.

## Typecheck and Reporters

- Enable type tests (`*.test-d.ts`) via `typecheck: { enabled: true }` or CLI flags `--typecheck` / `--typecheck.only`. Specify a custom tsconfig with `typecheck.tsconfig`.
- Vitest 5 stores generated artifacts under `.vitest/` (add `.vitest/` to `.gitignore`):
  - `json` and `junit` reporters write to `.vitest/json/output.json` and `.vitest/junit/output.xml` by default.
  - To print JSON to stdout (for piping), configure `reporters: [['json', { stdout: true }]]`.

## Agent and CI Commands

Always pass `run` so Vitest exits instead of entering watch mode:

| Goal | Command |
|------|---------|
| Full suite | `vitest run` |
| Single file | `vitest run src/auth.test.ts` |
| Focused test (`>`-joined in v5) | `vitest run src/auth.test.ts -t "login > rejects expired token"` |
| Specific project | `vitest run --project unit` |
| Changed files vs git | `vitest run --changed` or `vitest run --changed=HEAD~1` |
| Fail fast | `vitest run --bail 1` |
| Coverage report | `vitest run --coverage` |
| Type tests only | `vitest run --typecheck.only` |
| CI sharding | `vitest run --reporter=blob --shard=1/3` |
