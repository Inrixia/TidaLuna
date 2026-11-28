# Type-level patterns

## Quick reference

| Do | Instead of | Why |
|----|-----------|-----|
| `unknown` + narrowing | `any` | `any` disables checking for everything it touches |
| `x satisfies T` | `const x: T = ...` | checks shape, keeps literal types |
| discriminant literal (`kind: "circle"`) | optional-field unions | exhaustive narrowing |
| `[T] extends [U] ? ...` | bare `T extends U` | brackets stop distribution over unions |
| `NoInfer<T>` on fallback/default params | extra type param | inference anchored to the primary argument |
| `infer` in a conditional | manual indexed access | extracts from any shape |
| `-readonly` / `-?` in mapped types | rewriting props | strip modifiers in one place |
| `as` key remapping: `` [K in keyof T as `get${Capitalize<K & string>}`] `` | one alias per transform | derived keys |
| `function isX(v: unknown): v is X` | scattered casts | central narrowing, works in `.filter()` |
| `function assertX(v: unknown): asserts v is X` | cast after external call | narrows rest of scope |
| `<const T extends readonly string[]>` | caller-side `as const` | literal tuple inference |
| `Awaited<T>` | hand-rolled promise unwrap | handles nested thenables |
| `object` / `Record<string, unknown>` | `Object`, `{}` | `{}` means any non-nullish value |
| typed signature `(x: string) => number` | `Function` | `Function` returns `any` |

TS infers type predicates from simple filters (`arr.filter((x) => x !== undefined)` narrows). Write an explicit predicate only when inference fails.

## Exhaustiveness

```ts
type Shape = { kind: "circle"; radius: number } | { kind: "square"; side: number };

function assertNever(value: never, message = `unhandled: ${String(value)}`): never {
  throw new Error(message);
}

function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius ** 2;
    case "square":
      return shape.side ** 2;
    default:
      return assertNever(shape); // new variant = compile error here
  }
}
```

Lookup alternative for pure mappings: `const labels = { circle: "Circle", square: "Square" } satisfies Record<Shape["kind"], string>;`

## Guards and assertions

```ts
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function assertString(v: unknown, name: string): asserts v is string {
  if (typeof v !== "string") throw new TypeError(`${name}: expected string, got ${typeof v}`);
}
```

A predicate is an unchecked promise to the compiler: keep it trivially correct, test it, prefer a schema for nested shapes.

## Recipes

```ts
// Brand: nominal type for validated values; the only cast lives in the validator.
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };
type UserId = Brand<string, "UserId">;
const toUserId = (raw: string): UserId => {
  if (!/^u-\d+$/.test(raw)) throw new Error(`invalid user id: ${raw}`);
  return raw as UserId;
};

// DeepReadonly: functions kept as-is; arrays/tuples stay arrays/tuples (homomorphic mapped type).
// Map/Set are not deep-frozen.
type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

// Prettify: flatten intersections in hovers.
type Prettify<T> = { [K in keyof T]: T[K] } & {};

// Keys of a sealed object. Unsafe for open objects (extra runtime keys possible).
const typedKeys = <T extends object>(obj: T) => Object.keys(obj) as (keyof T)[];

// Values-as-type from a const object (enum replacement).
const Status = { Active: "active", Banned: "banned" } as const;
type Status = (typeof Status)[keyof typeof Status]; // "active" | "banned"
```

## Pitfalls

- Distributive conditionals: `ToArray<string | number>` is `string[] | number[]`; wrap in `[T] extends [U]` for `(string | number)[]`.
- `ReturnType`/`infer` on overloaded functions sees only the last signature.
- `const` type params with a mutable constraint (`string[]`) fall back to non-literal; use `readonly`.
- `noUncheckedIndexedAccess`: `arr[i]` is `T | undefined`; prefer `for...of`, `.at()` with a check, or destructuring with defaults over `!`.
- Optional vs `undefined`: `{ a?: string }` allows omission; `{ a: string | undefined }` requires the key. Under `exactOptionalPropertyTypes` they differ at assignment too.
- Huge unions (hundreds of members) and deep recursive conditionals slow the checker and IDE; split into named sub-unions.
