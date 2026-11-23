import assert from "node:assert";
import { describe, it } from "node:test";

import { notAsked, notAskedMessage } from "./notAsked";

describe("core requests that were not asked", () => {
	it("reads the reason back", () => {
		assert.equal(notAskedMessage(notAsked("Install X?", "TIDAL is not in use")), '"Install X?" was not asked: TIDAL is not in use');
	});

	it("reads it after contextBridge prefixed the message", () => {
		const err = new Error(`Error invoking remote method: ${notAsked("Update Y?", "3 confirmations are already waiting").message}`);
		assert.equal(notAskedMessage(err), '"Update Y?" was not asked: 3 confirmations are already waiting');
	});

	it("leaves other errors alone", () => {
		assert.equal(notAskedMessage(new Error("[Luna.core] No code for https://x")), undefined);
		assert.equal(notAskedMessage(new Error("plugin said: was not asked: x")), undefined);
		assert.equal(notAskedMessage("was not asked: "), undefined);
		assert.equal(notAskedMessage(undefined), undefined);
	});
});
