import { describe, expect, it } from "vitest";

import { pageAllowsUrl, refusalReason, toastGate } from "./pageNetRules";

describe("pageAllowsUrl", () => {
	const connect = ["api.example.com", "cdn.example.com/Covers/*"];
	it("allows the page's origin, Luna's and the connect-src entries", () => {
		expect(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("https://desktop.tidal.com/x"))).toBe(true);
		expect(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("https://luna/plugin.mjs"))).toBe(true);
		expect(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("wss://api.example.com/s"))).toBe(true);
		expect(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("https://evil.example/x"))).toBe(false);
	});
	it("leaves plain http and ws to luna.fetch, but for loopback (mixed content)", () => {
		const plain = ["http://nas.example:8096", "ws://nas.example:8096", "http://localhost:24050", "ws://127.0.0.1:24050"];
		expect(pageAllowsUrl(plain, "https://desktop.tidal.com", new URL("http://nas.example:8096/x"))).toBe(false);
		expect(pageAllowsUrl(plain, "https://desktop.tidal.com", new URL("ws://nas.example:8096/x"))).toBe(false);
		expect(pageAllowsUrl(plain, "https://desktop.tidal.com", new URL("http://localhost:24050/x"))).toBe(true);
		expect(pageAllowsUrl(plain, "https://desktop.tidal.com", new URL("ws://127.0.0.1:24050/x"))).toBe(true);
	});
	it("matches an entry's path as written, like the CSP", () => {
		expect(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("https://cdn.example.com/Covers/a.jpg"))).toBe(true);
		expect(pageAllowsUrl(connect, "https://desktop.tidal.com", new URL("https://cdn.example.com/covers/a.jpg"))).toBe(false);
	});
});

describe("refusalReason", () => {
	it("reads a refusal and leaves network failures alone", () => {
		const err = new Error(
			"Error invoking remote method '__LunaCore.fetch': Error: [🛑Security🛑] luna.fetch refused: you denied example.com for P",
		);
		expect(refusalReason(err)).toBe("you denied example.com for P");
		expect(refusalReason(new Error("[🛑Security🛑] luna.fetch refused a redirect: x is local"))).toBe("x is local");
		expect(refusalReason(new Error("fetch failed"))).toBe(undefined);
	});
});

describe("toastGate", () => {
	it("lets one toast through per plugin and host every period", () => {
		const gate = toastGate(30_000);
		expect(gate("P", "a.com", 1000)).toBe(true);
		expect(gate("P", "a.com", 20_000)).toBe(false);
		expect(gate("P", "b.com", 20_000)).toBe(true);
		expect(gate("P", "a.com", 31_001)).toBe(true);
	});
});
