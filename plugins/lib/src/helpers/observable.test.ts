import type { LunaUnload } from "@luna/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { observe, observePromise } from "./observable";

/**
 * `observable.ts` keeps one MutationObserver and the [selector, callback] pairs in module scope, reports elements that
 * are already in the DOM from a microtask after `observe`, and re-observes `document.body` when the first pair is
 * added again. Each test therefore observes through its own unloads set and runs it afterwards, which removes its
 * pairs and (for the last one) disconnects the observer.
 *
 * happy-dom delivers mutation records in a microtask, so `flush` is what makes a callback have run.
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const div = (className: string, text = className) => {
	const element = document.createElement("div");
	element.className = className;
	element.textContent = text;
	return element;
};

let unloads: Set<LunaUnload>;
beforeEach(() => {
	unloads = new Set();
});
afterEach(() => {
	for (const unload of [...unloads]) unload();
	unloads.clear();
	document.body.innerHTML = "";
});

describe("observe", () => {
	test("reports the elements that are already in the DOM, once", async () => {
		const first = div("luna-existing", "first");
		const second = div("luna-existing", "second");
		document.body.append(first, second);
		const found: Element[] = [];

		observe(unloads, ".luna-existing", (element) => found.push(element));
		await flush();
		await flush();

		expect(found).toEqual([first, second]);
	});

	test("reports an element added after the observer was set up", async () => {
		const found: Element[] = [];
		observe(unloads, ".luna-added", (element) => found.push(element));
		// Let the initial scan of the (empty) document finish first
		await flush();

		const added = div("luna-added");
		document.body.appendChild(added);
		await flush();

		expect(found).toEqual([added]);
	});

	test("reports matching elements inside an added element", async () => {
		const found: Element[] = [];
		observe(unloads, ".luna-nested", (element) => found.push(element));
		await flush();

		const wrapper = document.createElement("section");
		wrapper.append(div("luna-nested", "a"), div("luna-nested", "b"));
		document.body.appendChild(wrapper);
		await flush();

		expect(found.map((element) => element.textContent)).toEqual(["a", "b"]);
	});

	test("reports an element once when its own record and an ancestor's subtree both reach it", async () => {
		const found: Element[] = [];
		observe(unloads, ".luna-batch", (element) => found.push(element));
		await flush();

		const outer = div("luna-batch", "outer");
		document.body.appendChild(outer);
		// Added in the same batch as a child of a node that matched: the child's own added record and `outer`'s subtree
		// scan both reach it
		const inner = div("luna-batch", "inner");
		outer.appendChild(inner);
		await flush();

		expect(found).toEqual([outer, inner]);
	});

	test("skips an element that was removed again before the records were delivered", async () => {
		const found: Element[] = [];
		observe(unloads, ".luna-gone", (element) => found.push(element));
		await flush();

		const element = div("luna-gone");
		document.body.appendChild(element);
		element.remove();
		await flush();

		expect(found).toEqual([]);
	});

	test("stops reporting once unloaded", async () => {
		const found: Element[] = [];
		const unob = observe(unloads, ".luna-unloaded", (element) => found.push(element));
		await flush();

		unob();
		// `observe` leaves its unload in the set it was given (only safeTimeout removes itself), so this pins that
		// stopping the pair doesn't shrink the plugin's unloads
		expect(unloads.has(unob)).toBe(true);
		document.body.appendChild(div("luna-unloaded"));
		await flush();

		expect(found).toEqual([]);
	});

	test("keeps reporting for the pairs that are still observed", async () => {
		const unloaded = vi.fn();
		const kept = vi.fn();
		const unob = observe(unloads, ".luna-keep", unloaded);
		observe(unloads, ".luna-keep", kept);
		await flush();

		const element = div("luna-keep");
		unob();
		document.body.appendChild(element);
		await flush();

		expect(unloaded).not.toHaveBeenCalled();
		expect(kept).toHaveBeenCalledWith(element);
	});
});

describe("observePromise", () => {
	test("resolves with an element that is already in the DOM", async () => {
		const element = div("luna-present");
		document.body.appendChild(element);

		expect(await observePromise(unloads, ".luna-present")).toBe(element);
	});

	test("resolves with the element once it appears", async () => {
		const found = observePromise(unloads, ".luna-later");
		await flush();

		const element = div("luna-later");
		document.body.appendChild(element);

		expect(await found).toBe(element);
	});

	test("resolves null when the element doesn't appear in time", async () => {
		vi.useFakeTimers();
		try {
			const found = observePromise(unloads, ".luna-never", 500);
			await vi.advanceTimersByTimeAsync(500);

			expect(await found).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	test("unregisters its observer and timeout once it found the element", async () => {
		const found = observePromise(unloads, ".luna-cleanup");
		await flush();

		document.body.appendChild(div("luna-cleanup"));
		await found;

		// The timeout unloads itself; the observer's stays, as `observe` never removes its unload from the set
		expect(unloads.size).toBe(1);
	});
});
