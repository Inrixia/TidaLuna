import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNet, NetRefused, type NetDeps, type PluginHosts } from "./net";

type Call = { url: string; method: string; body?: string | Uint8Array; headers: Record<string, string> };

/** A fake network: url -> response maker. Records every request that reached it */
const fakeNet = (plugins: Record<string, PluginHosts>, routes: Record<string, () => Response>, extra: Partial<NetDeps> = {}) => {
	const calls: Call[] = [];
	const net = createNet({
		hostsOf: (url) => plugins[url],
		fetch: async (url, init) => {
			calls.push({ url, method: init.method, body: init.body, headers: init.headers });
			assert.equal(init.redirect, "manual");
			const route = routes[url];
			if (route === undefined) throw new Error(`no route ${url}`);
			return route();
		},
		now: () => 1000,
		...extra,
	});
	return { net, calls };
};

const declared = { name: "Declared", hosts: ["api.example.com"] };
const compat = { name: "Compat" };
const plugins = { "https://store/declared": declared, "https://store/compat": compat, "https://store/none": { name: "None", hosts: [] } };

describe("luna.fetch", () => {
	it("fetches a declared host and gives status, headers and body", async () => {
		const { net, calls } = fakeNet(plugins, {
			"https://api.example.com/a?key=secret": () => new Response("hi", { status: 201, headers: { "x-a": "b" } }),
		});
		const res = await net.fetch("https://store/declared", "page", {
			url: "https://api.example.com/a?key=secret",
			method: "post",
			headers: { "content-type": "text/plain" },
			body: "x",
		});
		assert.equal(res.status, 201);
		assert.equal(new TextDecoder().decode(res.body), "hi");
		assert.deepEqual(
			res.headers.find(([name]) => name === "x-a"),
			["x-a", "b"],
		);
		assert.deepEqual(calls[0], {
			url: "https://api.example.com/a?key=secret",
			method: "POST",
			body: "x",
			headers: { "content-type": "text/plain" },
		});
		const [entry] = net.log();
		assert.deepEqual(entry, {
			time: 1000,
			plugin: "https://store/declared",
			via: "page",
			method: "POST",
			target: "https://api.example.com/a",
			allowed: true,
			compat: false,
			status: 201,
		});
	});

	it("refuses a host the plugin doesn't declare, before any request", async () => {
		const { net, calls } = fakeNet(plugins, {});
		await assert.rejects(net.fetch("https://store/declared", "world", { url: "https://evil.com/steal" }), NetRefused);
		await assert.rejects(net.fetch("https://store/none", "page", { url: "https://api.example.com/" }), /not in the hosts of None/);
		assert.equal(calls.length, 0);
		assert.deepEqual(
			net.log().map(({ allowed, via, error }) => ({ allowed, via, refused: error !== undefined })),
			[
				{ allowed: false, via: "world", refused: true },
				{ allowed: false, via: "page", refused: true },
			],
		);
	});

	it("lets a plugin without hosts reach public hosts, marked as compatibility mode", async () => {
		const { net } = fakeNet(plugins, { "https://anything.org/": () => new Response("ok") });
		await net.fetch("https://store/compat", "page", { url: "https://anything.org/" });
		assert.equal(net.log()[0].compat, true);
		assert.equal(net.log()[0].allowed, true);
	});

	it("keeps a plugin without hosts away from local addresses", async () => {
		const { net, calls } = fakeNet(plugins, {});
		for (const url of ["http://127.0.0.1:9222/json", "http://localhost/", "http://192.168.1.1/", "http://[::1]/"])
			await assert.rejects(net.fetch("https://store/compat", "page", { url }), /local address/);
		assert.equal(calls.length, 0);
	});

	it("refuses plugins that aren't enabled, other schemes and credentials in urls", async () => {
		const { net } = fakeNet(plugins, {});
		await assert.rejects(net.fetch("https://store/unknown", "page", { url: "https://api.example.com/" }), /not an enabled plugin/);
		await assert.rejects(net.fetch(5, "page", { url: "https://api.example.com/" }), /not an enabled plugin/);
		await assert.rejects(net.fetch("https://store/compat", "page", { url: "file:///etc/passwd" }), /file: urls/);
		await assert.rejects(net.fetch("https://store/compat", "page", { url: "https://u:p@a.org/" }), /credentials/);
		await assert.rejects(net.fetch("https://store/compat", "page", { url: "not a url" }), /Not a url/);
		await assert.rejects(net.fetch("https://store/compat", "page", { url: "https://a.org/", method: "CONNECT" }), /method CONNECT/);
		await assert.rejects(net.fetch("https://store/compat", "page", { url: "https://a.org/", headers: { a: 1 } }), /header a/);
		await assert.rejects(
			net.fetch("https://store/compat", "page", { url: "https://a.org/", headers: { Host: "localhost" } }),
			/header Host can't be set/,
		);
		await assert.rejects(net.fetch("https://store/compat", "page", { url: "https://a.org/", body: { a: 1 } }), /string or bytes/);
	});

	it("checks every redirect hop against the hosts", async () => {
		const redirect =
			(location: string, status = 302) =>
			() =>
				new Response(null, { status, headers: { location } });
		const { net, calls } = fakeNet(plugins, {
			"https://api.example.com/r": redirect("/final"),
			"https://api.example.com/final": () => new Response("done"),
			"https://api.example.com/out": redirect("https://evil.com/"),
		});
		const res = await net.fetch("https://store/declared", "page", { url: "https://api.example.com/r" });
		assert.equal(res.url, "https://api.example.com/final");
		assert.equal(res.redirected, true);
		await assert.rejects(net.fetch("https://store/declared", "page", { url: "https://api.example.com/out" }), /redirect/);
		assert.equal(
			calls.some((call) => call.url.startsWith("https://evil.com")),
			false,
		);
		assert.equal(net.log().at(-1)?.allowed, false);
	});

	it("turns a POST into a GET without body on 303", async () => {
		const { net, calls } = fakeNet(plugins, {
			"https://api.example.com/form": () => new Response(null, { status: 303, headers: { location: "/done" } }),
			"https://api.example.com/done": () => new Response("ok"),
		});
		await net.fetch("https://store/declared", "page", { url: "https://api.example.com/form", method: "POST", body: "a=1" });
		assert.deepEqual(
			calls.map(({ method, body }) => [method, body]),
			[
				["POST", "a=1"],
				["GET", undefined],
			],
		);
	});

	it("stops after five redirects and refuses bodies over the limit", async () => {
		const { net } = fakeNet(
			plugins,
			{
				"https://api.example.com/loop": () => new Response(null, { status: 302, headers: { location: "/loop" } }),
				"https://api.example.com/big": () => new Response("x".repeat(20)),
			},
			{ maxBytes: 10 },
		);
		await assert.rejects(net.fetch("https://store/declared", "page", { url: "https://api.example.com/loop" }), /redirects/);
		await assert.rejects(net.fetch("https://store/declared", "page", { url: "https://api.example.com/big" }), /larger than 10 bytes/);
		assert.match(net.log().at(-1)?.error ?? "", /larger/);
	});

	it("keeps the newest 100 entries of each plugin: one plugin can't push another's out", async () => {
		const { net } = fakeNet(plugins, { "https://anything.org/": () => new Response("ok") });
		await net.fetch("https://store/compat", "page", { url: "https://anything.org/" });
		for (let i = 0; i < 110; i++) await net.fetch("https://store/declared", "page", { url: `https://other${i}.com/` }).catch(() => {});
		for (let i = 0; i < 110; i++) await net.fetch(`https://forged/${i}`, "page", { url: "https://a.org/" }).catch(() => {});
		const log = net.log();
		assert.equal(log.filter((entry) => entry.plugin === "https://store/declared").length, 100);
		assert.equal(log.filter((entry) => entry.plugin === "https://store/compat").length, 1);
		// Requests naming no enabled plugin share one bucket
		assert.equal(log.filter((entry) => entry.plugin.startsWith("https://forged/")).length, 100);
		assert.equal(log.find((entry) => entry.plugin === "https://store/declared")?.target, "https://other10.com/");
	});

	it("clips what the page names before logging it, and refuses very long urls", async () => {
		const { net } = fakeNet(plugins, {});
		await assert.rejects(net.fetch("x".repeat(100000), "page", { url: "https://a.org/" }), /not an enabled plugin/);
		assert.ok(net.log()[0].plugin.length < 400);
		await assert.rejects(net.fetch("https://store/compat", "page", { url: `https://a.org/${"p".repeat(10000)}` }), /longer than/);
		await assert.rejects(net.fetch("https://store/compat", "page", { url: 5 }), /Not a url/);
	});

	it("drops credentials on a redirect to another origin", async () => {
		const { net, calls } = fakeNet(plugins, {
			"https://a.org/r": () => new Response(null, { status: 302, headers: { location: "https://b.org/" } }),
			"https://b.org/": () => new Response("ok"),
		});
		await net.fetch("https://store/compat", "page", {
			url: "https://a.org/r",
			headers: { Authorization: "Bearer t", "x-api-key": "k", Cookie: "c" },
		});
		assert.deepEqual(calls[0].headers, { Authorization: "Bearer t", "x-api-key": "k", Cookie: "c" });
		assert.deepEqual(calls[1].headers, { "x-api-key": "k" });
	});

	it("refuses a name that resolves to a local address in compatibility mode", async () => {
		const resolved: Record<string, string[]> = { "rebind.example": ["192.168.1.1"], "public.example": ["93.184.215.14"] };
		const { net, calls } = fakeNet(
			plugins,
			{ "https://public.example/": () => new Response(null, { status: 302, headers: { location: "https://rebind.example/" } }) },
			{ resolve: async (hostname) => resolved[hostname] ?? [] },
		);
		await assert.rejects(net.fetch("https://store/compat", "page", { url: "https://rebind.example/" }), /local address/);
		await assert.rejects(net.fetch("https://store/compat", "page", { url: "https://public.example/" }), /redirect.*local address/);
		assert.deepEqual(
			calls.map((call) => call.url),
			["https://public.example/"],
		);
	});

	it("refuses a declared public name that resolves to a local address, not a declared local entry", async () => {
		const lan = { name: "Lan", hosts: ["http://api.myplugin.dev", "http://127.0.0.1:8080", "nas.lan"] };
		const resolved: Record<string, string[]> = { "api.myplugin.dev": ["192.168.1.1"], "nas.lan": ["192.168.1.2"] };
		const { net, calls } = fakeNet(
			{ "https://store/lan": lan },
			{ "http://127.0.0.1:8080/": () => new Response("local"), "https://nas.lan/": () => new Response("nas") },
			{ resolve: async (hostname) => resolved[hostname] ?? [] },
		);
		await assert.rejects(net.fetch("https://store/lan", "page", { url: "http://api.myplugin.dev/" }), /local address/);
		assert.equal((await net.fetch("https://store/lan", "page", { url: "http://127.0.0.1:8080/" })).status, 200);
		assert.equal((await net.fetch("https://store/lan", "page", { url: "https://nas.lan/" })).status, 200);
		assert.deepEqual(
			calls.map((call) => call.url),
			["http://127.0.0.1:8080/", "https://nas.lan/"],
		);
	});

	it("follows only redirect statuses, and drops the headers of an encoded body", async () => {
		const { net, calls } = fakeNet(plugins, {
			"https://a.org/": () => new Response(null, { status: 304, headers: { location: "https://b.org/" } }),
			"https://a.org/gz": () => new Response("decoded", { headers: { "content-encoding": "gzip", "content-length": "3", "x-a": "b" } }),
		});
		const res = await net.fetch("https://store/compat", "page", { url: "https://a.org/" });
		assert.equal(res.status, 304);
		assert.equal(res.redirected, false);
		assert.equal(calls.length, 1);
		const gz = await net.fetch("https://store/compat", "page", { url: "https://a.org/gz" });
		assert.deepEqual(
			gz.headers.map(([name]) => name).filter((name) => name !== "content-type"),
			["x-a"],
		);
	});

	it("times out when no data arrives for timeoutMs, not after a fixed total", async () => {
		const slow = (chunks: number, gapMs: number) => () =>
			new Response(
				new ReadableStream({
					async start(controller) {
						for (let i = 0; i < chunks; i++) {
							await new Promise((res) => setTimeout(res, gapMs));
							controller.enqueue(new Uint8Array([i]));
						}
						controller.close();
					},
				}),
			);
		const { net } = fakeNet(
			plugins,
			{ "https://a.org/steady": slow(6, 30), "https://a.org/stalled": slow(1, 300) },
			{
				timeoutMs: 100,
				// Like fetch: the body stream fails once the signal aborts
				fetch: async (url, init) => {
					const res = (url.endsWith("steady") ? slow(6, 30) : slow(1, 300))();
					const reader = res.body!.getReader();
					return new Response(
						new ReadableStream({
							async pull(controller) {
								const aborted = new Promise<never>((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
								const { done, value } = await Promise.race([reader.read(), aborted]);
								if (done) controller.close();
								else controller.enqueue(value);
							},
						}),
					);
				},
			},
		);
		// 6 chunks 30 ms apart: 180 ms in all, never 100 ms without data
		assert.equal((await net.fetch("https://store/compat", "page", { url: "https://a.org/steady" })).body.byteLength, 6);
		await assert.rejects(net.fetch("https://store/compat", "page", { url: "https://a.org/stalled" }), /No answer/);
	});

	it("refuses a name that doesn't resolve in compatibility mode", async () => {
		const { net, calls } = fakeNet(plugins, {}, { resolve: async () => Promise.reject(new Error("ENOTFOUND")) });
		await assert.rejects(net.fetch("https://store/compat", "page", { url: "https://nowhere.example/" }), /doesn't resolve/);
		assert.equal(calls.length, 0);
	});

	it("drops the body headers when a redirect continues as GET, and resends the body on 307", async () => {
		const { net, calls } = fakeNet(plugins, {
			"https://a.org/303": () => new Response(null, { status: 303, headers: { location: "https://a.org/done" } }),
			"https://a.org/307": () => new Response(null, { status: 307, headers: { location: "https://a.org/done" } }),
			"https://a.org/done": () => new Response("ok"),
		});
		const request = { method: "POST", body: "x", headers: { "Content-Type": "text/plain", "x-a": "b" } };
		await net.fetch("https://store/compat", "page", { url: "https://a.org/303", ...request });
		assert.deepEqual([calls[1].method, calls[1].body, calls[1].headers], ["GET", undefined, { "x-a": "b" }]);
		await net.fetch("https://store/compat", "page", { url: "https://a.org/307", ...request });
		assert.deepEqual([calls[3].method, calls[3].body, calls[3].headers], ["POST", "x", { "Content-Type": "text/plain", "x-a": "b" }]);
	});

	it("keeps content-encoding it doesn't decode, and content-length of a HEAD answer", async () => {
		const { net } = fakeNet(plugins, {
			"https://a.org/raw": () => new Response("raw", { headers: { "content-encoding": "zz", "content-length": "3" } }),
			"https://a.org/head": () => new Response(null, { headers: { "content-encoding": "gzip", "content-length": "1234" } }),
		});
		const names = (res: { headers: [string, string][] }) => res.headers.map(([name]) => name);
		assert.ok(names(await net.fetch("https://store/compat", "page", { url: "https://a.org/raw" })).includes("content-encoding"));
		assert.ok(names(await net.fetch("https://store/compat", "page", { url: "https://a.org/head", method: "HEAD" })).includes("content-length"));
	});

	it("caps request bodies and the requests a plugin has in flight", async () => {
		const waiting: (() => void)[] = [];
		const { net } = fakeNet(
			plugins,
			{},
			{
				fetch: () => new Promise((resolve) => waiting.push(() => resolve(new Response("ok")))),
			},
		);
		await assert.rejects(
			net.fetch("https://store/compat", "page", { url: "https://a.org/", method: "POST", body: new Uint8Array(33 * 1024 * 1024) }),
			/larger than/,
		);
		const running = Array.from({ length: 16 }, () => net.fetch("https://store/compat", "page", { url: "https://a.org/" }));
		await assert.rejects(net.fetch("https://store/compat", "page", { url: "https://a.org/" }), /too many requests/);
		// Another plugin isn't held up by this one
		const other = net.fetch("https://store/none", "page", { url: "https://a.org/" }).catch((err) => err);
		await new Promise((res) => setTimeout(res, 10));
		for (const release of waiting) release();
		await Promise.all(running);
		assert.match(String(await other), /not in the hosts/);
		assert.equal(
			(
				await (async () => {
					const p = net.fetch("https://store/compat", "page", { url: "https://a.org/" });
					await new Promise((res) => setTimeout(res, 10));
					waiting.at(-1)!();
					return p;
				})()
			).status,
			200,
		);
	});
});
