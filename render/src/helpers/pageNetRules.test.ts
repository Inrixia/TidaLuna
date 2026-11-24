import assert from "node:assert";
import { describe, it } from "node:test";

import { pageAllowsUrl, refusalReason, toastGate } from "./pageNetRules";

describe("pageAllowsUrl", () => {
	const connect = ["api.example.com", "cdn.example.com/Covers/*"];
	it("allows the page's origin, Luna's and the connect-src entries", () => {
		assert.strictEqual(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("https://desktop.tidal.com/x")), true);
		assert.strictEqual(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("https://luna/plugin.mjs")), true);
		assert.strictEqual(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("wss://api.example.com/s")), true);
		assert.strictEqual(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("https://evil.example/x")), false);
	});
	it("leaves plain http and ws to luna.fetch, but for loopback (mixed content)", () => {
		const plain = ["http://nas.example:8096", "ws://nas.example:8096", "http://localhost:24050", "ws://127.0.0.1:24050"];
		assert.strictEqual(pageAllowsUrl(plain, "https://desktop.tidal.com", new URL("http://nas.example:8096/x")), false);
		assert.strictEqual(pageAllowsUrl(plain, "https://desktop.tidal.com", new URL("ws://nas.example:8096/x")), false);
		assert.strictEqual(pageAllowsUrl(plain, "https://desktop.tidal.com", new URL("http://localhost:24050/x")), true);
		assert.strictEqual(pageAllowsUrl(plain, "https://desktop.tidal.com", new URL("ws://127.0.0.1:24050/x")), true);
	});
	it("matches an entry's path as written, like the CSP", () => {
		assert.strictEqual(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("https://cdn.example.com/Covers/a.jpg")), true);
		assert.strictEqual(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("https://cdn.example.com/covers/a.jpg")), false);
	});
});

describe("refusalReason", () => {
	it("reads a refusal and leaves network failures alone", () => {
		const err = new Error(
			"Error invoking remote method '__LunaCore.fetch': Error: [🛑Security🛑] luna.fetch refused: you denied example.com for P",
		);
		assert.strictEqual(refusalReason(err), "you denied example.com for P");
		assert.strictEqual(refusalReason(new Error("[🛑Security🛑] luna.fetch refused a redirect: x is local")), "x is local");
		assert.strictEqual(refusalReason(new Error("fetch failed")), undefined);
	});
});

describe("toastGate", () => {
	it("lets one toast through per plugin and host every period", () => {
		const gate = toastGate(30_000);
		assert.strictEqual(gate("P", "a.com", 1000), true);
		assert.strictEqual(gate("P", "a.com", 20_000), false);
		assert.strictEqual(gate("P", "b.com", 20_000), true);
		assert.strictEqual(gate("P", "a.com", 31_001), true);
	});
});
