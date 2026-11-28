# Runtime validation

Types are erased. Anything crossing a trust boundary is `unknown` until checked: `JSON.parse`, `fetch` responses, `process.env`, `localStorage`, `postMessage`/IPC, file contents, user input, third-party callbacks.

## Rules

- Validate once at the boundary, pass the typed value inward. Do not re-validate at every call site.
- Parse, don't validate: `parseX(raw: unknown): X` returns the typed value (or throws/returns a result); never a bare `boolean` the caller can ignore.
- The schema is the single source of truth: `type User = z.infer<typeof User>`. No hand-written twin type.
- `as` on external data is not validation. `JSON.parse(text) as User` checks nothing.
- `safeParse` on recoverable paths (user input, optional config); `parse` (throws) where failure is a bug or fatal.
- Env: parse the whole environment once at startup and fail fast; export the typed config object. Never read `process.env.X` deep in the code.
- Use the repo's schema library (zod, valibot, arktype, effect/schema). No new dependency for one guard: a hand-written guard is fine for a flat shape.
- Prefer libraries/APIs that accept Standard Schema (`StandardSchemaV1`) so any conforming schema plugs in.
- Strip or reject unknown keys at boundaries that persist data (`z.strictObject`) to avoid mass assignment.
- Brand validated scalars (`.brand<"Email">()`) so unvalidated strings cannot flow where validated ones are required.
- Errors shown to users: map schema issues to field messages; never echo raw input into logs when it may hold secrets.

## zod (v4 API; check installed major)

```ts
import * as z from "zod";

const User = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(["admin", "viewer"]),
  createdAt: z.coerce.date(),
});
type User = z.infer<typeof User>;

const res = User.safeParse(await response.json());
if (!res.success) throw new Error("bad /user response", { cause: z.treeifyError(res.error) });
const user = res.data; // User
```

v4 vs v3: string formats are top-level (`z.email()`, not `z.string().email()`); custom message key is `error` (not `message`); `z.flattenError(err)`/`z.treeifyError(err)` replace `err.flatten()`/`err.format()`; `zod/mini` is the tree-shakeable build.

## valibot (v1 API)

```ts
import * as v from "valibot";

const User = v.object({ id: v.pipe(v.string(), v.uuid()), email: v.pipe(v.string(), v.email()) });
type User = v.InferOutput<typeof User>;
const user = v.parse(User, input);
```

## Hand-written guard (flat shapes, no dependency)

```ts
type Point = { x: number; y: number };

function parsePoint(raw: unknown): Point {
  if (typeof raw !== "object" || raw === null) throw new TypeError("point: expected object");
  const { x, y } = raw as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number") throw new TypeError("point: x and y must be numbers");
  return { x, y }; // fresh object: no extra keys leak through
}
```
