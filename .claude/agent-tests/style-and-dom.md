# Styles and DOM helpers apply in TIDAL

Requires: none

`StyleTag`, `observe`/`observePromise` and the scrollbar/loading helpers touch TIDAL's DOM. Check they behave in TIDAL's real page.

1. `start`.
2. `eval` a `new luna.lib.StyleTag("agent-test", unloads, "body { outline: 3px solid red }")` with a fresh `unloads` set (read `StyleTag.ts` for its current signature); check the `<style>` is in `document.head` and `getComputedStyle(document.body).outlineStyle === "solid"`.
3. Run `luna.core.unloadSet(unloads)` and check the style is gone.
4. Use `luna.lib.observePromise` (read `plugins/lib/src/helpers/observable.ts`) to wait for an element that appears after a `router/PUSH` navigation, and check it resolves.
5. Take a `screenshot` and Read it to see the page renders (no blank page, no error overlay).

Pass when the style applies and is removed on unload, the observer resolves, and the page renders.
