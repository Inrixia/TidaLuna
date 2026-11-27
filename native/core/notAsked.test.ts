import { describe, expect, it } from "vitest";

import { notAsked, notAskedMessage } from "./notAsked";

describe("core requests that were not asked", () => {
	it("reads the reason back", () => {
		expect(notAskedMessage(notAsked("Install X?", "TIDAL is not in use"))).toBe('"Install X?" was not asked: TIDAL is not in use');
	});

	it("reads it after contextBridge prefixed the message", () => {
		const err = new Error(`Error invoking remote method: ${notAsked("Update Y?", "3 confirmations are already waiting").message}`);
		expect(notAskedMessage(err)).toBe('"Update Y?" was not asked: 3 confirmations are already waiting');
	});

	it("leaves other errors alone", () => {
		expect(notAskedMessage(new Error("[Luna.core] No code for https://x"))).toBe(undefined);
		expect(notAskedMessage(new Error("plugin said: was not asked: x"))).toBe(undefined);
		expect(notAskedMessage("was not asked: ")).toBe(undefined);
		expect(notAskedMessage(undefined)).toBe(undefined);
	});
});
