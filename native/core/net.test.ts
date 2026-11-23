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

	it("keeps only the newest 500 log entries, and clears them", async () => {
		const { net } = fakeNet(plugins, {});
		for (let i = 0; i < 510; i++) await net.fetch("https://store/declared", "page", { url: `https://other${i}.com/` }).catch(() => {});
		assert.equal(net.log().length, 500);
		assert.equal(net.log()[0].target, "https://other10.com/");
		net.clearLog();
		assert.equal(net.log().length, 0);
	});
});
