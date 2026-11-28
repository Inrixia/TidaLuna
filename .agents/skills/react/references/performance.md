# Performance, Compiler, and Transitions

## Compiler and Memoization Rules

Check the build config (`babel-plugin-react-compiler` or framework compiler option) before adding manual memoization.

- **React Compiler enabled**:
  - Do not add `useMemo`, `useCallback`, or `memo` in new code; the compiler memoizes components and values automatically.
  - Do not mass-remove existing `useMemo`/`useCallback`/`memo`; removing them can alter dependency identities and change when effects fire.
  - `"use no memo"` at the top of a function body is a temporary escape hatch for a component that breaks under compilation, not a habit; fix the Rules of React violation and remove it.
- **No React Compiler**:
  - Memoize only with a concrete reason: (1) measured expensive calculation on a hot path, (2) referential identity feeding an effect dependency or a `memo`ized child, or (3) Context provider `value` objects (`useMemo(() => ({ user, setUser }), [user])`).
- **Either way, fix structure first**:
  - Move state down into leaf components that actually use it.
  - Lift expensive/static content up via `children` (slot composition) so state updates in wrappers do not re-render passed children.
  - Split fast-changing and stable Contexts; keep list `key`s stable.

## Linting (Rules of React + Compiler)

- Enable `eslint-plugin-react-hooks` flat preset (`reactHooks.configs.flat.recommended`); it includes compiler-powered checks (`set-state-in-effect`, `set-state-in-render`, `immutability`, `purity`, `refs`, `exhaustive-deps`, `rules-of-hooks`).
- If a component violates Rules of React, React Compiler automatically skips optimizing that component without breaking the build.

```js
// eslint.config.js
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";

export default defineConfig([reactHooks.configs.flat.recommended]);
```

## Profiling Before Optimizing

- Components re-render when their own state changes, their parent re-renders (without compiler/memo bailout), or a consumed Context value identity changes.
- Measure first with **React DevTools Profiler** ("Why did this render?") or `<Profiler id="..." onRender={onRender}>` before tuning memoization.

## Responsiveness, View Transitions, and Code-Splitting

| API | Version | When to use |
|-----|---------|-------------|
| `useTransition` | 18+ / 19.0 | Wrap non-urgent state/async updates so typing/clicks stay responsive (`isPending`; keeps prior UI visible across Suspense) |
| `useDeferredValue` | 18+ / 19.0 | Defer an expensive subtree driven by a fast-changing value (`initialValue` in 19.0) |
| `<ViewTransition>` | 19.3 | Animate enter, exit, update (including list reorder), and shared-element (`name` prop) DOM changes during transitions |
| `addTransitionType` | 19.3 | Call inside `startTransition` to tag transition cause strings for `<ViewTransition>` directional animations |
| `React.lazy` + `<Suspense>` | 18+ | Split route or heavy feature bundles on demand |

- `<ViewTransition>` only animates updates inside `startTransition`, `<Suspense>`, or `useDeferredValue`; urgent `setState` updates never trigger it.
- Virtualize (window) large lists instead of mounting thousands of DOM rows.

```tsx
import { ViewTransition, addTransitionType, startTransition } from "react";

function navigate(direction: "next" | "previous", go: () => void) {
  startTransition(() => {
    addTransitionType(direction);
    go();
  });
}

<ViewTransition enter={{ next: "from-right", previous: "from-left" }} exit={{ next: "to-left", previous: "to-right" }}>
  <Slide key={slide.id} slide={slide} />
</ViewTransition>;
```
