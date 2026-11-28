# Suspense, Forms, and Server Components

## Suspense and `use()`

- **`<Suspense fallback={...}>`**: render fallback UI while child code (`React.lazy`) or data (`use(promise)`) suspends.
- **`use(resource)`** (19.0): read a Promise (suspends until resolved) or Context; unlike hooks, may be called conditionally inside `if` or loops.
- Hoist promises above the suspending component (parent, cache, or loader); creating a promise inside the suspending component's render causes infinite re-suspending.
- Pair `<Suspense>` with an error boundary; rejected promises throw to the nearest boundary.

```tsx
function Profile({ userPromise }: { userPromise: Promise<User> }) {
  const user = use(userPromise);
  return <h1>{user.name}</h1>;
}

<ErrorBoundary fallback={<p>Failed</p>}>
  <Suspense fallback={<Spinner />}>
    <Profile userPromise={userPromise} />
  </Suspense>
</ErrorBoundary>;
```

## Forms and Actions

- **Controlled** (`value` + `onChange`): React owns value; use when transforming or validating every keystroke.
- **Uncontrolled** (`defaultValue` + `FormData` or `ref`): simplest for standard forms; never flip an input between controlled and uncontrolled.

| API | Package | Version | When to use |
|-----|---------|---------|-------------|
| `<form action={fn}>` | `react-dom` | 19.0 | Run async `fn(formData)` in a transition; auto-resets uncontrolled fields on success |
| `useActionState` | `react` | 19.0 | Wrap an action to track `[state, formAction, isPending]` for errors/results |
| `useFormStatus` | `react-dom` | 19.0 | Read parent `<form>` `{ pending, data, method }` from a child submit control |
| `useOptimistic` | `react` | 19.0 | Show optimistic state while an async action is pending; reverts or commits when settled |

- Call `useFormStatus()` inside a child component of `<form>`, not in the component rendering `<form>`.
- Call `addOptimistic(next)` inside the action before `await`.
- Validate `FormData` at the boundary (e.g. schema parse) and return field errors as action state.

```tsx
function Subscribe() {
  const [error, action, pending] = useActionState(async (_prev: string | null, fd: FormData) => {
    const res = await subscribe(String(fd.get("email") ?? ""));
    return res.ok ? null : "Subscription failed";
  }, null);

  return (
    <form action={action}>
      <label>Email <input name="email" type="email" /></label>
      <button disabled={pending}>Subscribe</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

## React Server Components (Framework-Neutral Model)

RSC and Server Actions require an RSC framework; plain client SPAs do not run them.

- **Server Components** run only on the server: may be `async`, read DB/filesystem/secrets directly, ship zero component JS; cannot use state, effects, or browser APIs.
- **`'use client'`**: marks client bundle entry points (interactive leaves only); everything imported into a client file ships to the browser. Never mark every file `'use client'`.
- **`'use server'`**: marks a Server Function callable from client code (or a Server Action when passed to `<form action>`). Server Components need no directive.
- **Serialization boundary**: props passed Server -> Client must be serializable (no functions or class instances). Pass Server Component JSX as `children` into Client Component shells to keep non-interactive content on the server.
- **Streaming**: `<Suspense>` boundaries stream HTML and hydrate progressively as server promises resolve.
- **`cacheSignal()`** (19.2, RSC only): returns an `AbortSignal` that aborts when RSC rendering finishes, aborts, or fails (`null` outside render or in Client Components); pass to `fetch` / `cache()` to cancel unneeded in-flight work.
