import { describe, expect, it } from "vitest";

import { userInTidal } from "./userInTidal";

const settled = async (promise: Promise<void>) => {
	let done = false;
	void promise.then(() => (done = true));
	await new Promise((resolve) => setTimeout(resolve));
	return done;
};

describe("userInTidal", () => {
	it("resolves at once while TIDAL has the focus", async () => {
		expect(await settled(userInTidal(new EventTarget(), () => true))).toBe(true);
	});

	it("doesn't take an element's focus for the window's", async () => {
		const target = new EventTarget();
		const waiting = userInTidal(target, () => false);
		const element = new EventTarget();
		// As a capture listener on window sees it: the event's target is the element
		target.dispatchEvent(Object.defineProperty(new Event("focus"), "target", { value: element }));
		expect(await settled(waiting)).toBe(false);
		target.dispatchEvent(new Event("focus"));
		expect(await settled(waiting)).toBe(true);
	});

	it("waits for a click, a key or the focus", async () => {
		for (const type of ["pointerdown", "keydown", "focus"]) {
			const target = new EventTarget();
			const waiting = userInTidal(target, () => false);
			expect(await settled(waiting)).toBe(false);
			target.dispatchEvent(new Event(type));
			expect(await settled(waiting)).toBe(true);
		}
	});
});
