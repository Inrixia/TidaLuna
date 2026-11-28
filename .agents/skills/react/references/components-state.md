# Components, Hooks, and State

## Components and JSX

- Small, single-purpose function components; split components that fetch, transform, and render.
- Compute derived values and branch helpers above `return`; never cram nested ternaries into JSX.
- Props are read-only; destructure with defaults. Compose with `children` or explicit slot props instead of mega-prop configs.
- Use `<>...</>` fragments for grouping; `createPortal(children, domNode)` (`react-dom`) to render elsewhere while keeping React tree Context and event bubbling.
- Use stable data IDs for `key` on lists that reorder, insert, or delete; never use array index.
- Catch render errors with `react-error-boundary` or a class boundary (`getDerivedStateFromError` / `componentDidCatch`).
- Naming: `PascalCase` components, `useCamelCase` hooks, `onX` props / `handleX` handlers, `isX`/`hasX` booleans.

## React 19+ Component APIs

| API | Version | When to use |
|-----|---------|-------------|
| `ref` as prop | 19.0 | Accept `ref` directly in function props (`forwardRef` is deprecated) |
| `ref` cleanup | 19.0 | Return `() => ...` from ref callback to tear down listeners/observers (skips `null` unmount call) |
| `<Context value>` | 19.0 | Provide context directly (`<Context.Provider>` is legacy) |
| `<title>`/`<meta>`/`<link>` | 19.0 | Render head tags in the component owning metadata; React hoists to `<head>` |
| `<Activity mode="visible\|hidden">` | 19.2 | Hide UI (`display: none`) while preserving DOM nodes and state instead of unmounting (media stays in DOM) |
| `<Fragment ref>` | 19.3 | Ref on a Fragment yields a `FragmentInstance` (listeners, focus, observers over its children) without a wrapper DOM node |

```tsx
type InputProps = { label: string; ref?: React.Ref<HTMLInputElement> };

function TextInput({ label, ref }: InputProps) {
  return <label>{label}<input ref={ref} /></label>;
}

<Activity mode={isOpen ? "visible" : "hidden"}>
  <Sidebar />
</Activity>
```

- Avoid implicit assignment in ref callbacks (`ref={el => (node = el)}`); TypeScript flags non-void returns that look like cleanups.

## Hooks Primitives

- Call hooks unconditionally at the top level of components or `use*` custom hooks (only `use()` may be conditional).
- Custom hooks share stateful logic, not state; each call site owns independent state.

| Hook | When to use |
|------|-------------|
| `useState` | Local render state; use `setX(prev => ...)` when computing from prior state (never store non-rendering values) |
| `useReducer` | Multiple related state transitions or state-machine logic in one place |
| `useRef` | Mutable non-rendering value (DOM node, timer ID, latest value); never read/write `.current` during render |
| `useId` | Stable SSR-safe ID for accessibility attributes (`htmlFor`, `aria-*`), never for list keys |
| `useSyncExternalStore` | Subscribe safely to external non-React mutable stores |
| `useTransition` | Mark state updates non-urgent with `isPending` (19.0 allows async functions in `startTransition`) |
| `useDeferredValue` | Render a lagging copy of a fast-changing value (`initialValue` added in 19.0) |

## State Architecture and Context

- Derive, do not store: compute filtered/sorted/formatted values during render instead of syncing duplicate `useState`.
- Update immutably: `[...items, next]`, `{ ...state, field }`; mutating state or props skips re-renders and corrupts reconciliation.
- Decision ladder: colocate in lowest component -> lift to closest common ancestor -> `useReducer` -> Context -> store library.
- Separate **client state** (UI toggles, drafts, selection) from **server state** (remote cache with staleness/races: use TanStack Query or framework loaders, not `useState` + `useEffect`).

| Store | Shape | When to use |
|-------|-------|-------------|
| Zustand | Hook-based store | Simple global client state, minimal boilerplate |
| Redux Toolkit | Single store + reducers | Large apps needing strict structure, middleware, devtools |
| Jotai | Atomic bottom-up | Fine-grained derived client state |
| TanStack Query | Async cache | Server state (fetching, caching, mutations, invalidation) |

- **Context**: transport for slowly changing cross-cutting data (theme, locale, auth user), not a high-frequency store.
- Every Context consumer re-renders when `value` identity changes (no per-field bailout).
- Split Contexts by change frequency (e.g. separate state context and stable dispatch context); skip Context for 1-2 prop hops.

```tsx
const ThemeContext = createContext<"light" | "dark">("light");

<ThemeContext value={theme}>{children}</ThemeContext>
```
