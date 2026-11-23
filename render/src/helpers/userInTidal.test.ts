import assert from "node:assert";
import { describe, it } from "node:test";

import { userInTidal } from "./userInTidal";

const settled = async (promise: Promise<void>) => {
	let done = false;
	void promise.then(() => (done = true));
	await new Promise((resolve) => setTimeout(resolve));
	return done;
};

describe("userInTidal", () => {
	it("resolves at once while TIDAL has the focus", async () => {
		assert.equal(await settled(userInTidal(new EventTarget(), () => true)), true);
	});

	it("doesn't take an element's focus for the window's", async () => {
		const target = new EventTarget();
		const waiting = userInTidal(target, () => false);
		const element = new EventTarget();
		// As a capture listener on window sees it: the event's target is the element
		target.dispatchEvent(Object.defineProperty(new Event("focus"), "target", { value: element }));
		assert.equal(await settled(waiting), false);
		target.dispatchEvent(new Event("focus"));
		assert.equal(await settled(waiting), true);
	});

	it("waits for a click, a key or the focus", async () => {
		for (const type of ["pointerdown", "keydown", "focus"]) {
			const target = new EventTarget();
			const waiting = userInTidal(target, () => false);
			assert.equal(await settled(waiting), false);
			target.dispatchEvent(new Event(type));
			assert.equal(await settled(waiting), true);
		}
	});
});
