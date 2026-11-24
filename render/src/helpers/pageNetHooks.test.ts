import { describe, expect, it } from "vitest";

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
		expect(calls.native).toEqual(["https://api.tidal.com/v1/x", "https://api.allowed.example/y"]);
		expect(calls.stacks).toBe(0);
		expect(calls.luna).toEqual([]);
	});

	it("a plugin's fetch outside the connect-src goes through luna.fetch; a non-plugin one stays native (and the CSP blocks it)", async () => {
		const { page, calls, net } = setup();
		await net.ready;
		const res = await page.fetch("https://other.example/z");
		expect(await res.text()).toBe("luna");
		expect(calls.luna).toEqual(["https://other.example/z"]);
		const tidal = setup({ caller: undefined });
		await tidal.net.ready;
		await tidal.page.fetch("https://other.example/z");
		expect(tidal.calls.native).toEqual(["https://other.example/z"]);
	});

	it("a refused luna.fetch is toasted and thrown", async () => {
		const { page, calls, net } = setup({ lunaFetch: async () => Promise.reject(new Error("[Luna.net] refused")) });
		await net.ready;
		await expect(page.fetch("https://other.example/z")).rejects.toThrow(/refused/);
		expect(calls.blocked).toEqual(["P other.example refused"]);
	});

	it("a socket, XHR, EventSource or beacon to a new host asks, and says what the answer means", async () => {
		const always = setup();
		await always.net.ready;
		new always.page.WebSocket("wss://live.example/s");
		await always.net.lastAsk();
		expect(always.calls.asked).toEqual(["wss://live.example/s"]);
		expect(always.calls.warned[0]).toMatch(/works once TIDAL reloads/);

		const once = setup({ askHost: async () => ({ allowed: true, answer: "once" }) });
		await once.net.ready;
		once.page.XMLHttpRequest.prototype.open("GET", "https://x.example/a");
		await once.net.lastAsk();
		expect(once.calls.blocked[0]).toMatch(/needs "Always allow"/);

		const notKept = setup({ askHost: async () => ({ allowed: true, answer: "always", notKept: true }) });
		await notKept.net.ready;
		new notKept.page.EventSource("https://nas:8096/events");
		await notKept.net.lastAsk();
		expect(notKept.calls.blocked[0]).toMatch(/can't keep an answer/);
		expect(notKept.calls.warned).toEqual([]);

		// Plain http/ws but to loopback: mixed content, not asked whatever the answer would be
		let asked = 0;
		const plain = setup({ askHost: async () => (asked++, { allowed: true, answer: "always" }) });
		await plain.net.ready;
		new plain.page.WebSocket("ws://nas.lan:8096/socket");
		await plain.net.lastAsk();
		expect(asked).toBe(0);
		expect(plain.calls.blocked[0]).toMatch(/can't reach plain ws hosts/);

		const denied = setup({ askHost: async () => ({ allowed: false, reason: "you denied x.example" }) });
		await denied.net.ready;
		denied.page.navigator.sendBeacon("https://x.example/b");
		await denied.net.lastAsk();
		expect(denied.calls.blocked).toEqual(["P x.example you denied x.example"]);

		// Allowed by the page's CSP, or the page's own origin: nothing asked
		new always.page.WebSocket("wss://api.allowed.example/s");
		new always.page.WebSocket("wss://desktop.tidal.com/s");
		expect(always.calls.asked.length).toBe(1);
	});

	it("an enforced CSP block is toasted with its directive; report-only ones aren't", () => {
		const { calls, violation } = setup();
		violation({ disposition: "report", blockedURI: "https://r.example/x", effectiveDirective: "connect-src" });
		violation({ disposition: "enforce", blockedURI: "https://e.example/x", effectiveDirective: "connect-src" });
		expect(calls.blocked).toEqual(["connect-src e.example"]);
	});

	it("one toast for a plugin's blocked request: its own, not the CSP report's too", async () => {
		const { page, net, calls, violation } = setup({ askHost: async () => ({ allowed: false, reason: "you denied x.example" }) });
		await net.ready;
		new page.WebSocket("wss://x.example/s");
		violation({ disposition: "enforce", blockedURI: "wss://x.example/s", effectiveDirective: "connect-src" });
		await net.lastAsk();
		expect(calls.blocked).toEqual(["P x.example you denied x.example"]);
	});

	it("a request the page allows leaves no toast mark: a later real block of the host is toasted", async () => {
		const { page, net, calls, violation } = setup();
		await net.ready;
		new page.WebSocket("wss://api.allowed.example/s");
		await net.lastAsk();
		violation({ disposition: "enforce", blockedURI: "wss://api.allowed.example/s", effectiveDirective: "connect-src" });
		expect(calls.blocked).toEqual(["connect-src api.allowed.example"]);
	});

	it("says a host only luna.fetch reaches won't work after a reload", async () => {
		for (const [why, text] of [
			["setting", /server from its settings/],
			["resolves-local", /resolves to a local address/],
		] as const) {
			const { page, net, calls } = setup({ askHost: async () => ({ allowed: true, notKept: true, fetchOnly: why }) });
			await net.ready;
			new page.WebSocket("wss://jf.example.com/s");
			await net.lastAsk();
			expect(calls.blocked[0]).toMatch(text);
			expect(calls.warned).toEqual([]);
		}
	});

	it("hands askHost the plugin's settings", async () => {
		const seen: unknown[] = [];
		const { page, net } = setup({
			settingsFor: async () => ({ server: "https://jf.example.com" }),
			askHost: async (_u, _t, settings) => (seen.push(settings), { allowed: true }),
		});
		await net.ready;
		new page.WebSocket("wss://jf.example.com/s");
		await net.lastAsk();
		expect(seen).toEqual([{ server: "https://jf.example.com" }]);
	});
});
