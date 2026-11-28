# Effects

`useEffect` synchronizes a component with an external system (DOM, subscription, timer, observer, non-React widget, network). If nothing outside React is involved, do not write an effect.

## You Might Not Need an Effect

| Temptation | Do instead |
|------------|------------|
| Compute value from props/state | Compute during render (`const x = ...`, or `useMemo` if expensive without compiler) |
| Update state when a prop changes | Derive in render (or reset subtree with `key`) |
| Run logic after a user interaction | Execute in the event handler |
| Reset all state when an ID/prop changes | Pass `key={itemId}` on the component |
| Chain effects (`effect A` sets state -> `effect B`) | Compute transitions together in the event handler or render |
| Fetch cacheable data | Use Suspense + `use()`, framework loader, or TanStack Query |

## Dependencies and `useEffectEvent`

- List every reactive value read inside the effect; never add `eslint-disable` for `react-hooks/exhaustive-deps`.
- Reduce noisy dependencies by moving functions/objects inside the effect or using functional state updates (`setCount(c => c + 1)`).
- **`useEffectEvent(fn)`** (React 19.2): extract non-reactive logic called from an effect so it always reads latest props/state without triggering effect re-runs.
  - Never list an Effect Event in a dependency array.
  - Call Effect Events only inside effects (`useEffect`, `useLayoutEffect`, `useInsertionEffect`) or other Effect Events; never call during render or pass to child components/hooks.

```tsx
import { useEffect, useEffectEvent } from "react";

function ChatRoom({ roomId, onMessage }: { roomId: string; onMessage: (msg: string) => void }) {
  const handleMessage = useEffectEvent(onMessage);

  useEffect(() => {
    const conn = connect(roomId);
    conn.on("message", (msg) => handleMessage(msg));
    return () => conn.disconnect();
  }, [roomId]);
}
```

## Cleanup, `useLayoutEffect`, and StrictMode

- Always return a cleanup function for subscriptions, timers, observers, and requests; cleanup runs before the next effect re-run and on unmount.
- In raw fetch effects, abort on cleanup with `AbortController` (or guard with an ignore flag) so stale responses never overwrite newer state.

```tsx
useEffect(() => {
  const ctrl = new AbortController();
  fetch(url, { signal: ctrl.signal })
    .then((r) => r.json())
    .then(setData)
    .catch((e) => { if (!ctrl.signal.aborted) setError(e); });
  return () => ctrl.abort();
}, [url]);
```

- **`useLayoutEffect`**: runs synchronously after DOM mutations and before paint; use only to measure layout or avoid visual flicker.
- **StrictMode (dev)** runs setup -> cleanup -> setup on mount to verify cleanup symmetry; write clean teardowns instead of adding ref guards to skip re-runs.
