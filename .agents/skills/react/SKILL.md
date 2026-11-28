---
name: react
description: React 19 component, hook, effect, state, compiler-aware performance, Suspense, form, RSC, and Vitest testing patterns. Use when writing, reviewing, or refactoring .tsx/.jsx components, hooks, context, effects, forms, Suspense/data fetching, Server Components, or React tests.
---

Authoring, refactoring, and reviewing React components, hooks, effects, state, data loading, and tests. Verified against React 19.3 (2026-11). The repo dictates the React version (host apps may bundle their own); check it before using newer APIs.

## Rules

- Function components only; reserve classes for error boundaries or use `react-error-boundary`.
- Pass `ref` as a regular prop in new code (`forwardRef` is deprecated); return cleanup from ref callbacks instead of relying on `null` unmount calls.
- Render `<Context value={...}>` directly and render document metadata (`<title>`, `<meta>`, `<link>`) in components that own it.
- Derive values during render; never mirror props or state into `useState` and sync via `useEffect`.
- Keep state immutable and colocated; lift to nearest common ancestor, then use `useReducer`, split Context, or a store (separate client vs server state).
- Use stable data IDs for `key` on dynamic lists; never use array indices.
- Use `useEffect` only to synchronize with external systems; always return cleanup, keep deps honest (never `eslint-disable`), and extract non-reactive callbacks with `useEffectEvent` (19.2).
- Check build config for `babel-plugin-react-compiler` before adding `useMemo`/`useCallback`/`memo`; when compiler is on, omit manual memo in new code, keep existing ones, and use `"use no memo"` only as a temporary escape hatch.
- Without React Compiler, memoize only for measured hot paths, effect or memoized-child identity, or Context `value` objects; fix tree structure first either way.
- Enforce Rules of React with `eslint-plugin-react-hooks` flat preset (`reactHooks.configs.flat.recommended`).
- Prefer Suspense + `use()` (promises hoisted above render) or a server-cache library over fetch-in-effect; pair Suspense with an error boundary.
- Use `<form action={fn}>`, `useActionState`, `useFormStatus`, and `useOptimistic` for async form mutations; validate `FormData` at the boundary.
- Keep `'use client'` on interactive leaves only; server-to-client props must be serializable (RSC requires a framework).
- Test user-visible behavior in Vitest (`getByRole` > `getByLabelText` > `getByText` > `getByTestId`, `userEvent.setup()`, MSW v3 at network boundary); never assert on internal state.

## References

- `references/components-state.md`: read when authoring components, JSX, hooks, state architecture, Context, or `<Activity>`.
- `references/effects.md`: read when writing, reviewing, or removing `useEffect`, `useLayoutEffect`, or `useEffectEvent`.
- `references/performance.md`: read when deciding on memoization, configuring React Compiler/lints, profiling, using `<ViewTransition>`/`addTransitionType`, or code-splitting.
- `references/data-forms-rsc.md`: read when using Suspense, `use()`, form actions, optimistic UI, or Server Components.
- `references/testing.md`: read when writing React component or hook tests in Vitest (jsdom, Browser Mode, MSW v3).
