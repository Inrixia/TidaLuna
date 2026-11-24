import { describe, expect, it } from "vitest";

import { createNet, NetRefused, type AskHost, type HostAnswer, type HostQuestion, type NetDeps, type PluginHosts } from "./net";

type Call = { url: string; method: string; body?: string | Uint8Array; headers: Record<string, string> };

/** A fake network: url -> response maker. Records every request that reached it */
const fakeNet = (plugins: Record<string, PluginHosts>, routes: Record<string, () => Response>, extra: Partial<NetDeps> = {}) => {
	const calls: Call[] = [];
	const net = createNet({
		hostsOf: (url) => plugins[url],
		fetch: async (url, init) => {
			calls.push({ url, method: init.method, body: init.body, headers: init.headers });
			expect(init.redirect).toBe("manual");
			const route = routes[url];
			if (route === undefined) throw new Error(`no route ${url}`);
			return route();
		},
		now: () => 1000,
		...extra,
	});
	return { net, calls };
};

const declared = { name: "Declared", mode: "declared", hosts: ["api.example.com"], allow: [], deny: [] } satisfies PluginHosts;
const compat = { name: "Compat", mode: "legacy", allow: [], deny: [] } satisfies PluginHosts;
const plugins = {
	"https://store/declared": declared,
	"https://store/compat": compat,
	"https://store/none": { name: "None", mode: "declared", hosts: [], allow: [], deny: [] },
} satisfies Record<string, PluginHosts>;

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
		expect(res.status).toBe(201);
		expect(new TextDecoder().decode(res.body)).toBe("hi");
		expect(res.headers.find(([name]) => name === "x-a")).toEqual(["x-a", "b"]);
		expect(calls[0]).toEqual({
			url: "https://api.example.com/a?key=secret",
			method: "POST",
			body: "x",
			headers: { "content-type": "text/plain" },
		});
		const [entry] = net.log();
		expect(entry).toEqual({
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
		await expect(net.fetch("https://store/declared", "world", { url: "https://evil.com/steal" })).rejects.toThrow(NetRefused);
		await expect(net.fetch("https://store/none", "page", { url: "https://api.example.com/" })).rejects.toThrow(/not in the hosts of None/);
		expect(calls.length).toBe(0);
		expect(net.log().map(({ allowed, via, error }) => ({ allowed, via, refused: error !== undefined }))).toEqual([
			{ allowed: false, via: "world", refused: true },
			{ allowed: false, via: "page", refused: true },
		]);
	});

	it("lets a plugin without hosts reach public hosts, marked as compatibility mode", async () => {
		const { net } = fakeNet(plugins, { "https://anything.org/": () => new Response("ok") });
		await net.fetch("https://store/compat", "page", { url: "https://anything.org/" });
		expect(net.log()[0].compat).toBe(true);
		expect(net.log()[0].allowed).toBe(true);
	});

	it("keeps a plugin without hosts away from local addresses", async () => {
		const { net, calls } = fakeNet(plugins, {});
		for (const url of ["http://127.0.0.1:9222/json", "http://localhost/", "http://192.168.1.1/", "http://[::1]/"])
			await expect(net.fetch("https://store/compat", "page", { url })).rejects.toThrow(/local address/);
		expect(calls.length).toBe(0);
	});

	it("refuses plugins that aren't enabled, other schemes and credentials in urls", async () => {
		const { net } = fakeNet(plugins, {});
		await expect(net.fetch("https://store/unknown", "page", { url: "https://api.example.com/" })).rejects.toThrow(/not an enabled plugin/);
		await expect(net.fetch(5, "page", { url: "https://api.example.com/" })).rejects.toThrow(/not an enabled plugin/);
		await expect(net.fetch("https://store/compat", "page", { url: "file:///etc/passwd" })).rejects.toThrow(/file: urls/);
		await expect(net.fetch("https://store/compat", "page", { url: "https://u:p@a.org/" })).rejects.toThrow(/credentials/);
		await expect(net.fetch("https://store/compat", "page", { url: "not a url" })).rejects.toThrow(/Not a url/);
		await expect(net.fetch("https://store/compat", "page", { url: "https://a.org/", method: "CONNECT" })).rejects.toThrow(/method CONNECT/);
		await expect(net.fetch("https://store/compat", "page", { url: "https://a.org/", headers: { a: 1 } })).rejects.toThrow(/header a/);
		await expect(net.fetch("https://store/compat", "page", { url: "https://a.org/", headers: { Host: "localhost" } })).rejects.toThrow(
			/header Host can't be set/,
		);
		await expect(net.fetch("https://store/compat", "page", { url: "https://a.org/", body: { a: 1 } })).rejects.toThrow(/string or bytes/);
	});

	it("leaves accept-encoding to fetch, which decodes what it asks for", async () => {
		const { net, calls } = fakeNet(plugins, { "https://a.org/": () => new Response("ok") });
		await net.fetch("https://store/compat", "page", { url: "https://a.org/", headers: { "Accept-Encoding": "zstd", "x-a": "b" } });
		expect(calls[0].headers).toEqual({ "x-a": "b" });
		// `identity` is kept: a HEAD for a file's own size must not get the compressed length
		await net.fetch("https://store/compat", "page", { url: "https://a.org/", headers: { "accept-encoding": "identity" } });
		expect(calls[1].headers).toEqual({ "accept-encoding": "identity" });
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
		expect(res.url).toBe("https://api.example.com/final");
		expect(res.redirected).toBe(true);
		await expect(net.fetch("https://store/declared", "page", { url: "https://api.example.com/out" })).rejects.toThrow(/redirect/);
		expect(calls.some((call) => call.url.startsWith("https://evil.com"))).toBe(false);
		expect(net.log().at(-1)?.allowed).toBe(false);
	});

	it("turns a POST into a GET without body on 303", async () => {
		const { net, calls } = fakeNet(plugins, {
			"https://api.example.com/form": () => new Response(null, { status: 303, headers: { location: "/done" } }),
			"https://api.example.com/done": () => new Response("ok"),
		});
		await net.fetch("https://store/declared", "page", { url: "https://api.example.com/form", method: "POST", body: "a=1" });
		expect(calls.map(({ method, body }) => [method, body])).toEqual([
			["POST", "a=1"],
			["GET", undefined],
		]);
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
		await expect(net.fetch("https://store/declared", "page", { url: "https://api.example.com/loop" })).rejects.toThrow(/redirects/);
		await expect(net.fetch("https://store/declared", "page", { url: "https://api.example.com/big" })).rejects.toThrow(/larger than 10 bytes/);
		expect(net.log().at(-1)?.error ?? "").toMatch(/larger/);
	});

	it("keeps the newest 100 entries of each plugin: one plugin can't push another's out", async () => {
		const { net } = fakeNet(plugins, { "https://anything.org/": () => new Response("ok") });
		await net.fetch("https://store/compat", "page", { url: "https://anything.org/" });
		for (let i = 0; i < 110; i++) await net.fetch("https://store/declared", "page", { url: `https://other${i}.com/` }).catch(() => {});
		for (let i = 0; i < 110; i++) await net.fetch(`https://forged/${i}`, "page", { url: "https://a.org/" }).catch(() => {});
		const log = net.log();
		expect(log.filter((entry) => entry.plugin === "https://store/declared").length).toBe(100);
		expect(log.filter((entry) => entry.plugin === "https://store/compat").length).toBe(1);
		// Requests naming no enabled plugin share one bucket
		expect(log.filter((entry) => entry.plugin.startsWith("https://forged/")).length).toBe(100);
		expect(log.find((entry) => entry.plugin === "https://store/declared")?.target).toBe("https://other10.com/");
	});

	it("clips what the page names before logging it, and refuses very long urls", async () => {
		const { net } = fakeNet(plugins, {});
		await expect(net.fetch("x".repeat(100000), "page", { url: "https://a.org/" })).rejects.toThrow(/not an enabled plugin/);
		expect(net.log()[0].plugin.length < 400).toBeTruthy();
		await expect(net.fetch("https://store/compat", "page", { url: `https://a.org/${"p".repeat(10000)}` })).rejects.toThrow(/longer than/);
		await expect(net.fetch("https://store/compat", "page", { url: 5 })).rejects.toThrow(/Not a url/);
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
		expect(calls[0].headers).toEqual({ Authorization: "Bearer t", "x-api-key": "k", Cookie: "c" });
		expect(calls[1].headers).toEqual({ "x-api-key": "k" });
	});

	it("refuses a name that resolves to a local address in compatibility mode", async () => {
		const resolved: Record<string, string[]> = { "rebind.example": ["192.168.1.1"], "public.example": ["93.184.215.14"] };
		const { net, calls } = fakeNet(
			plugins,
			{ "https://public.example/": () => new Response(null, { status: 302, headers: { location: "https://rebind.example/" } }) },
			{ resolve: async (hostname) => resolved[hostname] ?? [] },
		);
		await expect(net.fetch("https://store/compat", "page", { url: "https://rebind.example/" })).rejects.toThrow(/local address/);
		await expect(net.fetch("https://store/compat", "page", { url: "https://public.example/" })).rejects.toThrow(/redirect.*local address/);
		expect(calls.map((call) => call.url)).toEqual(["https://public.example/"]);
	});

	it("refuses a declared public name that resolves to a local address, not a declared local entry", async () => {
		const lan = {
			name: "Lan",
			mode: "declared",
			hosts: ["http://api.myplugin.dev", "http://127.0.0.1:8080", "nas.lan"],
			allow: [],
			deny: [],
		} satisfies PluginHosts;
		const resolved: Record<string, string[]> = { "api.myplugin.dev": ["192.168.1.1"], "nas.lan": ["192.168.1.2"] };
		const { net, calls } = fakeNet(
			{ "https://store/lan": lan },
			{ "http://127.0.0.1:8080/": () => new Response("local"), "https://nas.lan/": () => new Response("nas") },
			{ resolve: async (hostname) => resolved[hostname] ?? [] },
		);
		await expect(net.fetch("https://store/lan", "page", { url: "http://api.myplugin.dev/" })).rejects.toThrow(/local address/);
		expect((await net.fetch("https://store/lan", "page", { url: "http://127.0.0.1:8080/" })).status).toBe(200);
		expect((await net.fetch("https://store/lan", "page", { url: "https://nas.lan/" })).status).toBe(200);
		expect(calls.map((call) => call.url)).toEqual(["http://127.0.0.1:8080/", "https://nas.lan/"]);
	});

	it("asks about a public name that resolves to a local address (a server under split DNS), until restart only", async () => {
		const home = { name: "Home", mode: "declared", hosts: ["{setting:serverUrl}"], allow: [], deny: [] } satisfies PluginHosts;
		const questions: HostQuestion[] = [];
		let answer: HostAnswer = "deny";
		const ask: AskHost = async (question) => (questions.push(question), answer);
		const { net, calls } = fakeNet(
			{ "https://store/home": home },
			{ "https://jelly.example.org/System/Info": () => new Response("ok") },
			{ resolve: async () => ["192.168.1.10"] },
		);
		const get = () =>
			net.fetch("https://store/home", "page", { url: "https://jelly.example.org/System/Info" }, ask, { serverUrl: "https://jelly.example.org" });
		await expect(get()).rejects.toThrow(/denied/);
		expect(questions[0].reason).toBe("resolves-local");
		// The deny holds until restart: not asked again
		await expect(get()).rejects.toThrow(/local address/);
		expect(questions.length).toBe(1);
		net.forget("https://store/home");
		answer = "always";
		expect((await get()).status).toBe(200);
		expect((await get()).status).toBe(200);
		expect(questions.length).toBe(2);
		expect(calls.length).toBe(2);
	});

	it("a grant that throws at once still lets the answered request through", async () => {
		const unlisted = { name: "U", mode: "unlisted", allow: [], deny: [] } satisfies PluginHosts;
		const { net } = fakeNet(
			{ "https://store/u": unlisted },
			{ "https://a.example/": () => new Response("ok") },
			{
				grant: () => {
					throw new Error("registry not ready");
				},
			},
		);
		const res = await net.fetch("https://store/u", "page", { url: "https://a.example/" }, async () => "always");
		expect(res.status).toBe(200);
		// Not kept: it counts until restart, and page code hears that it isn't in the page's CSP
		expect(await net.ask("https://store/u", "https://a.example/y", async () => "deny")).toEqual({
			allowed: true,
			answer: "always",
			notKept: true,
		});
	});

	it("an answer the registry doesn't keep (plugin gone) counts until restart, a deny too", async () => {
		const unlisted = { name: "U", mode: "unlisted", allow: [], deny: [] } satisfies PluginHosts;
		const { net } = fakeNet({ "https://store/u": unlisted }, { "https://a.example/": () => new Response("ok") }, { grant: async () => false });
		const questions: string[] = [];
		const deny: AskHost = async (q) => (questions.push(q.entry), "deny");
		await expect(net.fetch("https://store/u", "page", { url: "https://a.example/" }, deny)).rejects.toThrow(/you denied/);
		await expect(net.fetch("https://store/u", "page", { url: "https://a.example/" }, deny)).rejects.toThrow(/you denied/);
		expect(questions.length).toBe(1);
	});

	it("says 'once' to page code for an only-now answer, and holds a deny for the host's other schemes", async () => {
		const unlisted = { name: "U", mode: "unlisted", allow: [], deny: ["https://tracker.example"] } satisfies PluginHosts;
		const { net } = fakeNet({ "https://store/u": unlisted }, {});
		expect(await net.ask("https://store/u", "wss://live.example.com/s", async () => "once")).toEqual({ allowed: true, answer: "once" });
		const never: AskHost = async () => expect.fail("not asked");
		expect(await net.ask("https://store/u", "wss://tracker.example/s", never)).toEqual({
			allowed: false,
			reason: "you denied tracker.example for U",
		});
		expect(await net.ask("https://store/u", "http://tracker.example/", never)).toEqual({
			allowed: false,
			reason: "you denied tracker.example for U",
		});
		// A deny until restart (an answer that couldn't be kept) holds for the other schemes too
		expect((await net.ask("https://store/u", "ws://[2001:db8::9]:81/", async () => "deny")).allowed).toBe(false);
		expect((await net.ask("https://store/u", "https://[2001:db8::9]:81/", never)).allowed).toBe(false);
	});

	it("tells page code when an allowed host can't reach the page's CSP (not kept)", async () => {
		const unlisted = { name: "U", mode: "unlisted", allow: [], deny: [] } satisfies PluginHosts;
		const { net } = fakeNet({ "https://store/u": unlisted }, {});
		expect(await net.ask("https://store/u", "ws://nas:8096/socket", async () => "always")).toEqual({
			allowed: true,
			answer: "always",
			notKept: true,
		});
		expect(await net.ask("https://store/u", "wss://live.example.com/s", async () => "always")).toEqual({ allowed: true, answer: "always" });
	});

	it("follows only redirect statuses, and drops the headers of an encoded body", async () => {
		const { net, calls } = fakeNet(plugins, {
			"https://a.org/": () => new Response(null, { status: 304, headers: { location: "https://b.org/" } }),
			"https://a.org/gz": () => new Response("decoded", { headers: { "content-encoding": "gzip", "content-length": "3", "x-a": "b" } }),
		});
		const res = await net.fetch("https://store/compat", "page", { url: "https://a.org/" });
		expect(res.status).toBe(304);
		expect(res.redirected).toBe(false);
		expect(calls.length).toBe(1);
		const gz = await net.fetch("https://store/compat", "page", { url: "https://a.org/gz" });
		expect(gz.headers.map(([name]) => name).filter((name) => name !== "content-type")).toEqual(["x-a"]);
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
		expect((await net.fetch("https://store/compat", "page", { url: "https://a.org/steady" })).body.byteLength).toBe(6);
		await expect(net.fetch("https://store/compat", "page", { url: "https://a.org/stalled" })).rejects.toThrow(/No answer/);
	});

	it("refuses a name that doesn't resolve in compatibility mode", async () => {
		const { net, calls } = fakeNet(plugins, {}, { resolve: async () => Promise.reject(new Error("ENOTFOUND")) });
		await expect(net.fetch("https://store/compat", "page", { url: "https://nowhere.example/" })).rejects.toThrow(/doesn't resolve/);
		expect(calls.length).toBe(0);
	});

	it("drops the body headers when a redirect continues as GET, and resends the body on 307", async () => {
		const { net, calls } = fakeNet(plugins, {
			"https://a.org/303": () => new Response(null, { status: 303, headers: { location: "https://a.org/done" } }),
			"https://a.org/307": () => new Response(null, { status: 307, headers: { location: "https://a.org/done" } }),
			"https://a.org/done": () => new Response("ok"),
		});
		const request = { method: "POST", body: "x", headers: { "Content-Type": "text/plain", "x-a": "b" } };
		await net.fetch("https://store/compat", "page", { url: "https://a.org/303", ...request });
		expect([calls[1].method, calls[1].body, calls[1].headers]).toEqual(["GET", undefined, { "x-a": "b" }]);
		await net.fetch("https://store/compat", "page", { url: "https://a.org/307", ...request });
		expect([calls[3].method, calls[3].body, calls[3].headers]).toEqual(["POST", "x", { "Content-Type": "text/plain", "x-a": "b" }]);
	});

	it("keeps content-encoding it doesn't decode, and content-length of a HEAD answer", async () => {
		const { net } = fakeNet(plugins, {
			"https://a.org/raw": () => new Response("raw", { headers: { "content-encoding": "zz", "content-length": "3" } }),
			"https://a.org/head": () => new Response(null, { headers: { "content-encoding": "gzip", "content-length": "1234" } }),
		});
		const names = (res: { headers: [string, string][] }) => res.headers.map(([name]) => name);
		expect(names(await net.fetch("https://store/compat", "page", { url: "https://a.org/raw" })).includes("content-encoding")).toBeTruthy();
		expect(
			names(await net.fetch("https://store/compat", "page", { url: "https://a.org/head", method: "HEAD" })).includes("content-length"),
		).toBeTruthy();
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
		await expect(
			net.fetch("https://store/compat", "page", { url: "https://a.org/", method: "POST", body: new Uint8Array(33 * 1024 * 1024) }),
		).rejects.toThrow(/larger than/);
		const running = Array.from({ length: 16 }, () => net.fetch("https://store/compat", "page", { url: "https://a.org/" }));
		await expect(net.fetch("https://store/compat", "page", { url: "https://a.org/" })).rejects.toThrow(/too many requests/);
		// Another plugin isn't held up by this one
		const other = net.fetch("https://store/none", "page", { url: "https://a.org/" }).catch((err) => err);
		await new Promise((res) => setTimeout(res, 10));
		for (const release of waiting) release();
		await Promise.all(running);
		expect(String(await other)).toMatch(/not in the hosts/);
		expect(
			(
				await (async () => {
					const p = net.fetch("https://store/compat", "page", { url: "https://a.org/" });
					await new Promise((res) => setTimeout(res, 10));
					waiting.at(-1)!();
					return p;
				})()
			).status,
		).toBe(200);
	});
});

describe("luna.fetch prompts", () => {
	const unlisted = { name: "Unlisted", mode: "unlisted", allow: [], deny: [] } satisfies PluginHosts;
	const asker = (answers: (HostAnswer | undefined)[]) => {
		const questions: HostQuestion[] = [];
		const ask: AskHost = async (question) => {
			questions.push(question);
			return answers.shift();
		};
		return { ask, questions };
	};
	const routes = { "https://api.new.example/x": () => new Response("ok"), "https://api.new.example/y": () => new Response("ok") };
	const granting = (grants: [string, string, string][]): Partial<NetDeps> => ({
		grant: (url, entry, grant) => void grants.push([url, entry, grant]),
	});

	it("asks about a host an unlisted plugin uses, and refuses it without an answer", async () => {
		const { net, calls } = fakeNet({ "https://store/u": unlisted }, routes);
		const { ask, questions } = asker([undefined]);
		await expect(net.fetch("https://store/u", "page", { url: "https://api.new.example/x?k=1" }, ask)).rejects.toThrow(/didn't allow it/);
		expect(calls.length).toBe(0);
		expect(questions).toEqual([
			{ plugin: "https://store/u", name: "Unlisted", entry: "https://api.new.example", example: "https://api.new.example/x", reason: "unlisted" },
		]);
		// Without an asker a host outside the list is refused, not let through
		await expect(net.fetch("https://store/u", "page", { url: "https://api.new.example/x" })).rejects.toThrow(NetRefused);
	});

	it("keeps 'once' until restart and hands 'always' and 'deny' to the registry", async () => {
		const grants: [string, string, string][] = [];
		const { net } = fakeNet({ "https://store/u": unlisted }, routes, granting(grants));
		const once = asker(["once"]);
		expect((await net.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, once.ask)).status).toBe(200);
		expect((await net.fetch("https://store/u", "page", { url: "https://api.new.example/y" }, once.ask)).status).toBe(200);
		expect(once.questions.length).toBe(1);
		expect(grants).toEqual([]);
		expect(net.log()[0].asked).toBe("once");

		const { net: net2 } = fakeNet({ "https://store/u": unlisted }, routes, granting(grants));
		await net2.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, asker(["always"]).ask);
		expect(grants).toEqual([["https://store/u", "https://api.new.example", "always"]]);

		const { net: net3 } = fakeNet({ "https://store/u": unlisted }, routes, granting(grants));
		await expect(net3.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, asker(["deny"]).ask)).rejects.toThrow(/you denied/);
		expect(grants[1]).toEqual(["https://store/u", "https://api.new.example", "deny"]);
	});

	it("keeps 'always' for a host the grammar can't keep until restart, and forgets answers of an uninstalled plugin", async () => {
		const grants: [string, string, string][] = [];
		const v6 = { "https://[2001:db8::1]/x": () => new Response("ok"), "https://api.new.example/x": () => new Response("ok") };
		const { net } = fakeNet({ "https://store/u": unlisted }, v6, granting(grants));
		const always = asker(["always"]);
		expect((await net.fetch("https://store/u", "page", { url: "https://[2001:db8::1]/x" }, always.ask)).status).toBe(200);
		expect((await net.fetch("https://store/u", "page", { url: "https://[2001:db8::1]/x" }, always.ask)).status).toBe(200);
		expect(always.questions.length).toBe(1);
		expect(grants).toEqual([]);

		const deny = asker(["deny", "once"]);
		const v6b = "https://[2001:db8::2]/x";
		const { net: denyNet } = fakeNet({ "https://store/u": unlisted }, { [v6b]: () => new Response("ok") }, granting(grants));
		await expect(denyNet.fetch("https://store/u", "page", { url: v6b }, deny.ask)).rejects.toThrow(/you denied/);
		await expect(denyNet.fetch("https://store/u", "page", { url: v6b }, deny.ask)).rejects.toThrow(/you denied/);
		expect(deny.questions.length).toBe(1);
		expect(grants).toEqual([]);

		const once = asker(["once", undefined]);
		await net.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, once.ask);
		net.forget("https://store/u");
		await expect(net.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, once.ask)).rejects.toThrow(/didn't allow it/);
		expect(once.questions.length).toBe(2);
	});

	it("drops an answer that comes after the plugin was forgotten (uninstalled)", async () => {
		const { net } = fakeNet({ "https://store/u": unlisted }, { "https://api.new.example/x": () => new Response("ok") });
		let answer: (value: "once") => void = () => {};
		const late = new Promise<"once">((resolve) => (answer = resolve));
		const pending = net.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, () => late);
		await new Promise((resolve) => setTimeout(resolve, 5));
		net.forget("https://store/u");
		answer("once");
		await pending.catch(() => undefined);
		// A reinstall from the same url asks again
		const again = asker([undefined]);
		await expect(net.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, again.ask)).rejects.toThrow(/didn't allow it/);
		expect(again.questions.length).toBe(1);
	});

	it("drops an answer whose grant was still being saved when the plugin was forgotten", async () => {
		let finish: (kept: boolean) => void = () => {};
		const saving = new Promise<boolean>((resolve) => (finish = resolve));
		const { net } = fakeNet({ "https://store/u": unlisted }, { "https://api.new.example/x": () => new Response("ok") }, { grant: () => saving });
		const pending = net.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, asker(["always"]).ask);
		await new Promise((resolve) => setTimeout(resolve, 5));
		net.forget("https://store/u");
		finish(false);
		await pending.catch(() => undefined);
		const again = asker([undefined]);
		await expect(net.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, again.ask)).rejects.toThrow(/didn't allow it/);
		expect(again.questions.length).toBe(1);
	});

	it("asks with the redirect reason about a host a redirect leads to", async () => {
		const { net } = fakeNet(
			{ "https://store/u": { ...unlisted, allow: ["https://api.new.example"] } },
			{
				"https://api.new.example/x": () => new Response(null, { status: 302, headers: { location: "https://other.example/y" } }),
			},
		);
		const { ask, questions } = asker([undefined]);
		await expect(net.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, ask)).rejects.toThrow(/redirect/);
		expect(questions[0]?.reason).toBe("redirect");
	});

	it("doesn't time out a redirect while the user answers", async () => {
		const { net } = fakeNet(
			{ "https://store/u": { ...unlisted, allow: ["https://api.new.example"] } },
			{
				"https://api.new.example/x": () => new Response(null, { status: 302, headers: { location: "https://other.example/y" } }),
				"https://other.example/y": () => new Response("ok"),
			},
			{ timeoutMs: 50 },
		);
		const slow = async () => (await new Promise((resolve) => setTimeout(resolve, 150)), "once" as const);
		const res = await net.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, slow);
		expect(res.status).toBe(200);
	});

	it("tells the user when an answer can't be kept, and names a migrated plugin's reason", async () => {
		const { net } = fakeNet({ "https://store/u": { ...unlisted, unconfirmed: true } }, { "https://[2001:db8::3]/x": () => new Response("ok") });
		const { ask, questions } = asker(["once", "once"]);
		await net.fetch("https://store/u", "page", { url: "https://[2001:db8::3]/x" }, ask);
		expect(questions[0]?.notKept).toBe(true);
		expect(questions[0]?.reason).toBe("unconfirmed");
	});

	it("asks once for many requests waiting on the same host", async () => {
		const { net } = fakeNet({ "https://store/u": unlisted }, routes);
		let release!: (answer: HostAnswer) => void;
		let asked = 0;
		const ask: AskHost = () => {
			asked++;
			return new Promise((resolve) => (release = resolve));
		};
		const both = Promise.all([
			net.fetch("https://store/u", "page", { url: "https://api.new.example/x" }, ask),
			net.fetch("https://store/u", "page", { url: "https://api.new.example/y" }, ask),
		]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		release("once");
		const results = await both;
		expect(asked).toBe(1);
		expect(results.map((res) => res.status)).toEqual([200, 200]);
	});

	it("follows remembered answers without asking: allow and deny lists", async () => {
		const plugin = { name: "P", mode: "declared", hosts: [], allow: ["https://api.new.example"], deny: ["api.bad.example"] } satisfies PluginHosts;
		const { net } = fakeNet({ "https://store/p": plugin }, { ...routes, "https://api.bad.example/": () => new Response("no") });
		const { ask, questions } = asker([]);
		expect((await net.fetch("https://store/p", "page", { url: "https://api.new.example/x" }, ask)).status).toBe(200);
		await expect(net.fetch("https://store/p", "page", { url: "https://api.bad.example/" }, ask)).rejects.toThrow(/you denied/);
		expect(questions.length).toBe(0);
	});

	it("asks with not-listed for a declared plugin, and a deny beats a declared host", async () => {
		const plugin = { name: "D", mode: "declared", hosts: ["api.example.com"], allow: [], deny: ["api.example.com"] } satisfies PluginHosts;
		const { net } = fakeNet({ "https://store/d": plugin }, { "https://api.example.com/": () => new Response("x"), ...routes });
		const { ask, questions } = asker([undefined]);
		await expect(net.fetch("https://store/d", "page", { url: "https://api.example.com/" }, ask)).rejects.toThrow(/you denied/);
		await expect(net.fetch("https://store/d", "page", { url: "https://api.new.example/x" }, ask)).rejects.toThrow();
		expect(questions[0].reason).toBe("not-listed");
	});

	it("allows the public server in a {setting:} entry as it is now, and asks about a local one", async () => {
		const plugin = { name: "S", mode: "declared", hosts: ["{setting:server}"], allow: [], deny: [] } satisfies PluginHosts;
		const { net, calls } = fakeNet(
			{ "https://store/s": plugin },
			{ "https://music.example/api": () => new Response("pub"), "http://192.168.1.5:4533/api": () => new Response("lan") },
			{ resolve: async () => ["93.184.216.34"] },
		);
		const { ask, questions } = asker(["once"]);
		expect(
			(await net.fetch("https://store/s", "page", { url: "https://music.example/api" }, ask, { server: "https://music.example" })).status,
		).toBe(200);
		expect(questions.length).toBe(0);
		// The setting names another server now: the old one is no longer covered
		await expect(
			net.fetch("https://store/s", "page", { url: "https://music.example/api" }, undefined, { server: "https://other.example" }),
		).rejects.toThrow();
		expect(
			(await net.fetch("https://store/s", "page", { url: "http://192.168.1.5:4533/api" }, ask, { server: "http://192.168.1.5:4533" })).status,
		).toBe(200);
		expect(questions[0].reason).toBe("local-setting");
		expect(calls.length).toBe(2);
	});

	it("keeps a declared local entry when a setting names the same server", async () => {
		const plugin = {
			name: "S",
			mode: "declared",
			hosts: ["http://localhost:8096", "{setting:server}"],
			allow: [],
			deny: [],
		} satisfies PluginHosts;
		const { net } = fakeNet({ "https://store/s": plugin }, { "http://localhost:8096/api": () => new Response("lan") });
		const { ask, questions } = asker([]);
		const res = await net.fetch("https://store/s", "page", { url: "http://localhost:8096/api" }, ask, { server: "http://localhost:8096" });
		expect(res.status).toBe(200);
		expect(questions.length).toBe(0);
	});

	it("lets a legacy plugin reach public hosts without asking, never local ones", async () => {
		const { net } = fakeNet({ "https://store/c": compat }, { ...routes, "http://127.0.0.1/": () => new Response("x") });
		const { ask, questions } = asker(["always"]);
		expect((await net.fetch("https://store/c", "page", { url: "https://api.new.example/x" }, ask)).status).toBe(200);
		await expect(net.fetch("https://store/c", "page", { url: "http://127.0.0.1/" }, ask)).rejects.toThrow(/local address/);
		expect(questions.length).toBe(0);
		// A local entry of its own legacy list (in the page's CSP too) is reached
		const listed = fakeNet(
			{ "https://store/c": { ...compat, hosts: ["http://192.168.1.10:8080"] } },
			{ "http://192.168.1.10:8080/x": () => new Response("x") },
		);
		expect((await listed.net.fetch("https://store/c", "page", { url: "http://192.168.1.10:8080/x" }, ask)).status).toBe(200);
		await expect(listed.net.fetch("https://store/c", "page", { url: "http://192.168.1.11:8080/x" }, ask)).rejects.toThrow(/local address/);
	});

	it("takes the page's settings for a plugin's {setting:} server on page requests, as luna.fetch does", async () => {
		const server = { name: "S", mode: "declared", hosts: ["{setting:server}"], allow: [], deny: [] } satisfies PluginHosts;
		const { net } = fakeNet({ "https://store/s": server }, {});
		const never: AskHost = async () => expect.fail("not asked");
		expect(await net.ask("https://store/s", "https://jf.example.com/Sessions", never, { server: "https://jf.example.com" })).toEqual({
			allowed: true,
			// The page's CSP is built without the page's settings: only luna.fetch reaches it
			notKept: true,
			fetchOnly: "setting",
		});
	});

	it("asks for a legacy plugin's page requests: an always answer is its only way into the page's CSP", async () => {
		const { net } = fakeNet({ "https://store/c": compat }, routes);
		const { ask, questions } = asker(["always"]);
		expect(await net.ask("https://store/c", "wss://api.new.example/socket", ask)).toEqual({ allowed: true, answer: "always" });
		expect(questions[0]?.entry).toBe("wss://api.new.example");
	});

	it("asks for page requests (ws too), logs them and returns the answer", async () => {
		const { net } = fakeNet({ "https://store/u": unlisted }, {});
		const { ask } = asker(["always", "deny"]);
		expect(await net.ask("https://store/u", "wss://live.example/socket", ask)).toEqual({ allowed: true, answer: "always" });
		expect((await net.ask("https://store/u", "https://other.example/", ask)).allowed).toBe(false);
		expect(await net.ask("https://store/none", "https://x.example/", ask)).toEqual({
			allowed: false,
			reason: "https://store/none is not an enabled plugin",
		});
		expect(await net.ask("https://store/u", "ftp://x.example/", ask)).toEqual({ allowed: false, reason: "ftp: urls can't be fetched" });
		const log = net.log();
		expect(log[0].method).toBe("PAGE");
		expect(log[0].asked).toBe("always");
	});
});
