import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installPageNet, type PageNetDeps } from "./pageNetHooks";

const plugin = { url: "https://store.example/P", name: "P" };

const setup = (over: Partial<PageNetDeps> & { connect?: string[]; caller?: typeof plugin } = {}) => {
	const calls = {
		native: [] as string[],
		luna: [] as string[],
		asked: [] as string[],
		blocked: [] as string[],
		warned: [] as string[],
		stacks: 0,
	};
	class FakeSocket {
		constructor(public url: string) {}
	}
	let violation: ((event: any) => void) | undefined;
	const page = {
		fetch: (async (input: RequestInfo | URL) => (calls.native.push(String(input)), new Response("native"))) as typeof fetch,
		WebSocket: FakeSocket as unknown as typeof WebSocket,
		EventSource: FakeSocket as unknown as typeof EventSource,
		XMLHttpRequest: { prototype: { open: (_method: string, _url: string) => {} } },
		navigator: { sendBeacon: (_url: string | URL) => true },
		document: { addEventListener: (_type: string, listener: (event: any) => void) => void (violation = listener) },
		location: { origin: "https://desktop.tidal.com", href: "https://desktop.tidal.com/" },
	};
	const deps: PageNetDeps = {
		pageConnect: async () => over.connect ?? ["*.tidal.com", "api.allowed.example"],
		lunaFetch: async (_url, request) => (
			calls.luna.push(request.url),
			{ status: 200, statusText: "OK", headers: {}, body: new TextEncoder().encode("luna") }
		),
		askHost: async (_url, target) => (calls.asked.push(target), { allowed: true, answer: "always" }),
		callingPlugin: () => (calls.stacks++, "caller" in over ? over.caller : plugin),
		settingsFor: async () => undefined,
		blocked: (who, target, reason) => calls.blocked.push(`${who} ${target} ${reason ?? ""}`.trim()),
		refused: (who, target) => calls.blocked.push(`${who} ${target} refused`),
		warn: (message) => calls.warned.push(message),
		error: () => {},
		...over,
	};
	const net = installPageNet(page as any, deps);
	return { page, calls, net, violation: (event: any) => violation?.(event) };
};

describe("pageNetHooks", () => {
	it("a url the page's connect-src allows goes out as it is, without reading the stack once it is loaded", async () => {
		const { page, calls, net } = setup();
		await net.ready;
		await page.fetch("https://api.tidal.com/v1/x");
		await page.fetch("https://api.allowed.example/y");
		assert.deepEqual(calls.native, ["https://api.tidal.com/v1/x", "https://api.allowed.example/y"]);
		assert.equal(calls.stacks, 0);
		assert.deepEqual(calls.luna, []);
	});

	it("a plugin's fetch outside the connect-src goes through luna.fetch; a non-plugin one stays native (and the CSP blocks it)", async () => {
		const { page, calls, net } = setup();
		await net.ready;
		const res = await page.fetch("https://other.example/z");
		assert.equal(await res.text(), "luna");
		assert.deepEqual(calls.luna, ["https://other.example/z"]);
		const tidal = setup({ caller: undefined });
		await tidal.net.ready;
		await tidal.page.fetch("https://other.example/z");
		assert.deepEqual(tidal.calls.native, ["https://other.example/z"]);
	});

	it("a refused luna.fetch is toasted and thrown", async () => {
		const { page, calls, net } = setup({ lunaFetch: async () => Promise.reject(new Error("[Luna.net] refused")) });
		await net.ready;
		await assert.rejects(page.fetch("https://other.example/z"), /refused/);
		assert.deepEqual(calls.blocked, ["P other.example refused"]);
	});

	it("a socket, XHR, EventSource or beacon to a new host asks, and says what the answer means", async () => {
		const always = setup();
		await always.net.ready;
		new always.page.WebSocket("wss://live.example/s");
		await always.net.lastAsk();
		assert.deepEqual(always.calls.asked, ["wss://live.example/s"]);
		assert.match(always.calls.warned[0], /works once TIDAL reloads/);

		const once = setup({ askHost: async () => ({ allowed: true, answer: "once" }) });
		await once.net.ready;
		once.page.XMLHttpRequest.prototype.open("GET", "https://x.example/a");
		await once.net.lastAsk();
		assert.match(once.calls.blocked[0], /needs "Always allow"/);

		const notKept = setup({ askHost: async () => ({ allowed: true, answer: "always", notKept: true }) });
		await notKept.net.ready;
		new notKept.page.EventSource("http://nas:8096/events");
		await notKept.net.lastAsk();
		assert.match(notKept.calls.blocked[0], /can't keep an answer/);
		assert.deepEqual(notKept.calls.warned, []);

		const denied = setup({ askHost: async () => ({ allowed: false, reason: "you denied x.example" }) });
		await denied.net.ready;
		denied.page.navigator.sendBeacon("https://x.example/b");
		await denied.net.lastAsk();
		assert.deepEqual(denied.calls.blocked, ["P x.example you denied x.example"]);

		// Allowed by the page's CSP, or the page's own origin: nothing asked
		new always.page.WebSocket("wss://api.allowed.example/s");
		new always.page.WebSocket("wss://desktop.tidal.com/s");
		assert.equal(always.calls.asked.length, 1);
	});

	it("an enforced CSP block is toasted with its directive; report-only ones aren't", () => {
		const { calls, violation } = setup();
		violation({ disposition: "report", blockedURI: "https://r.example/x", effectiveDirective: "connect-src" });
		violation({ disposition: "enforce", blockedURI: "https://e.example/x", effectiveDirective: "connect-src" });
		assert.deepEqual(calls.blocked, ["connect-src e.example"]);
	});
});
