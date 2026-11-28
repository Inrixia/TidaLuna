# React Testing (Vitest)

Vitest only; never use Jest APIs or Jest config. Read the `vitest` skill for general Vitest config, mocking, and runner mechanics.

## Default Unit/Component Tests (`jsdom` / `happy-dom`)

- Load `@testing-library/jest-dom/vitest` in Vitest `setupFiles` for DOM matchers (`toBeVisible`, `toHaveTextContent`).
- Call `const user = userEvent.setup()` once per test and `await` every interaction (`user.click`, `user.type`). Prefer `userEvent` over `fireEvent` for real focus, keyboard, and input event sequences.
- Query priority: `getByRole` > `getByLabelText` > `getByText` > `getByTestId` (last resort).
- Query variants: `getBy*` (must exist now), `queryBy*` (assert absence), `findBy*` (async/Suspense, retries until present).
- Never assert on internal state, props, or implementation-detail class names; assert on user-visible DOM and ARIA state.
- Wrap components needing Context, router, or query client in a test `wrapper` option on `render`.
- Test custom hooks with `renderHook(() => useX())`, assert on `result.current`, and wrap manual state triggers in `act`.

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

// MSW handler for the subscribe endpoint returns 500 in this test
test("shows an alert when subscribe fails", async () => {
  const user = userEvent.setup();
  render(<Subscribe />);
  await user.type(screen.getByLabelText("Email"), "a@b.com");
  await user.click(screen.getByRole("button", { name: "Subscribe" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Subscription failed");
});
```

## Vitest Browser Mode

- Use `vitest-browser-react` + `@vitest/browser-playwright` when real browser layout, CSS visibility, focus, or native events matter.
- `render` is async and act-wrapped; use retrying locators and `await expect.element(...)` instead of manual polling.

```tsx
import { render } from "vitest-browser-react";
import { expect, test } from "vitest";

test("increments counter in real browser", async () => {
  const screen = await render(<Counter initialCount={1} />);
  await screen.getByRole("button", { name: "Increment" }).click();
  await expect.element(screen.getByText("Count is 2")).toBeVisible();
});
```

## Network Mocking (MSW v3)

- Mock at the network boundary with `setupServer` from `msw/node` instead of stubbing `fetch`.
- Configure in Vitest `setupFiles`: fail fast on unhandled traffic, reset per-test overrides, and close after suite.
- MSW v3 renamed `onUnhandledRequest` to `onUnhandledFrame` (covers HTTP and WebSocket frames).

```ts
// vitest.setup.ts
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./mocks/node";

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

- Override per test with `server.use(...)` (wrap concurrent tests with `server.boundary(...)` to isolate overrides).
