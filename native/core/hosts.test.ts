import { describe, expect, it } from "vitest";

import {
	cspSources,
	resolveSettings,
	settingKeys,
	settingValueEntry,
	settingValueOf,
	declaredHosts,
	hostAllowed,
	hostsDiff,
	isLocalEntry,
	isLocalHost,
	localEntryAllows,
	parseHostEntry,
	sameHosts,
	worldCsp,
} from "./hosts";

const allowed = (hosts: string[], url: string) => hostAllowed(hosts, new URL(url));

describe("plugin hosts", () => {
	it("reads valid entries and keeps invalid ones apart", () => {
		expect(declaredHosts(["API.Last.fm", " ws.audioscrobbler.com ", "*.example.com", "http://127.0.0.1:8080", "api.last.fm"])).toEqual({
			hosts: ["api.last.fm", "ws.audioscrobbler.com", "*.example.com", "http://127.0.0.1:8080"],
			invalid: [],
		});
		expect(declaredHosts(["*", "*.com", "ftp://x.com", "https://a.com/a?b", "user@a.com", "a.com:99999", "999.1.1.1", 5])!.hosts).toEqual([]);
		expect(declaredHosts(["*", "ok.com"])?.invalid.length).toBe(1);
	});

	it("tells no hosts (compatibility mode) from an empty list", () => {
		expect(declaredHosts(undefined)).toBe(undefined);
		expect(declaredHosts("api.last.fm")).toBe(undefined);
		expect(declaredHosts([])).toEqual({ hosts: [], invalid: [] });
	});

	it("matches https and wss on the default port by default", () => {
		const hosts = ["api.last.fm"];
		expect(allowed(hosts, "https://api.last.fm/2.0/?method=x")).toBe(true);
		expect(allowed(hosts, "wss://api.last.fm/socket")).toBe(true);
		expect(allowed(hosts, "http://api.last.fm/")).toBe(false);
		expect(allowed(hosts, "https://api.last.fm:8443/")).toBe(false);
		expect(allowed(hosts, "https://evil.api.last.fm/")).toBe(false);
		expect(allowed(hosts, "https://api.last.fm.evil.com/")).toBe(false);
		expect(allowed(hosts, "https://last.fm/")).toBe(false);
	});

	it("matches subdomains for a wildcard, not the domain itself", () => {
		const hosts = ["*.example.com"];
		expect(allowed(hosts, "https://a.example.com/")).toBe(true);
		expect(allowed(hosts, "https://a.b.example.com/")).toBe(true);
		expect(allowed(hosts, "https://example.com/")).toBe(false);
		expect(allowed(hosts, "https://badexample.com/")).toBe(false);
	});

	it("needs the scheme and port written out for anything else", () => {
		const hosts = ["http://127.0.0.1:8080", "http://localhost"];
		expect(allowed(hosts, "http://127.0.0.1:8080/x")).toBe(true);
		expect(allowed(hosts, "http://127.0.0.1:8081/x")).toBe(false);
		expect(allowed(hosts, "https://127.0.0.1:8080/x")).toBe(false);
		expect(allowed(hosts, "http://localhost/")).toBe(true);
		expect(allowed(hosts, "http://localhost:80/")).toBe(true);
	});

	it("compares and diffs host lists", () => {
		expect(sameHosts(["a.com", "b.com"], ["B.com", "a.com"])).toBe(true);
		expect(sameHosts(undefined, undefined)).toBe(true);
		expect(sameHosts(undefined, [])).toBe(false);
		expect(sameHosts(["a.com"], ["a.com", "c.com"])).toBe(false);
		expect(hostsDiff(["a.com", "b.com"], ["b.com", "c.com"])).toEqual({ added: ["c.com"], removed: ["a.com"] });
	});

	it("knows local addresses by their literal", () => {
		for (const host of [
			"localhost",
			"a.localhost",
			"printer.local",
			"127.0.0.1",
			"10.1.2.3",
			"192.168.0.1",
			"172.16.0.1",
			"169.254.1.1",
			"100.64.0.1",
			"0.0.0.0",
			"[::1]",
			"[fd00::1]",
			"[fe80::1]",
			"[::ffff:127.0.0.1]",
			"router",
			"nas.lan",
			"fritz.box.home.arpa",
			"db.internal",
			"localhost.",
		])
			expect(isLocalHost(host), host).toBe(true);
		for (const host of ["api.last.fm", "8.8.8.8", "172.32.0.1", "[2606:4700::1111]"]) expect(isLocalHost(host), host).toBe(false);
	});

	it("gives CSP sources for each scheme", () => {
		expect(cspSources(["api.last.fm", "*.example.com", "http://127.0.0.1:8080", "bad host"])).toEqual([
			"https://api.last.fm",
			"wss://api.last.fm",
			"https://*.example.com",
			"wss://*.example.com",
			"http://127.0.0.1:8080",
		]);
	});

	it("parses an entry into its rule", () => {
		expect(parseHostEntry("wss://*.x.com:444")).toEqual({ schemes: ["wss"], host: "x.com", wildcard: true, port: "444", path: "" });
		expect(parseHostEntry("*.localhost")).toBe(undefined);
		expect(parseHostEntry("*.1.2.3.4")).toBe(undefined);
	});

	it("refuses names ending in a number: the URL parser reads them as IPv4", () => {
		for (const entry of ["*.0.0.1", "*.1.1", "http://*.1.1", "a.0x7f", "1.2.3", "x.123"]) expect(parseHostEntry(entry), entry).toBe(undefined);
		expect(hostAllowed(["*.1.1"], new URL("https://192.168.1.1/"))).toBe(false);
		expect(parseHostEntry("a1.example.com")).toBeTruthy();
		expect(parseHostEntry("cdn.123abc.com")).toBeTruthy();
		expect(parseHostEntry("10.0.0.5")).toBeTruthy();
	});

	it("tells local entries apart: only they let luna.fetch reach a local address", () => {
		for (const entry of ["localhost", "http://127.0.0.1:8080", "nas.lan", "*.home.arpa", "http://192.168.1.10:8123"])
			expect(isLocalEntry(entry), entry).toBe(true);
		for (const entry of ["api.example.com", "*.example.com", "not an entry"]) expect(isLocalEntry(entry), entry).toBe(false);
		expect(localEntryAllows(["api.example.com", "http://127.0.0.1:8080"], new URL("http://127.0.0.1:8080/x"))).toBe(true);
		expect(localEntryAllows(["api.example.com", "http://127.0.0.1:8080"], new URL("https://api.example.com/"))).toBe(false);
	});

	it("refuses leading zeros, which the URL parser reads another way", () => {
		for (const entry of ["010.0.0.1", "10.0.0.01", "a.com:08080"]) expect(parseHostEntry(entry), entry).toBe(undefined);
		expect(parseHostEntry("10.0.0.1")).toBeTruthy();
		expect(parseHostEntry("a.com:8080")).toBeTruthy();
	});

	it("finds IPv4 addresses inside IPv6 ones, as the URL parser writes them", () => {
		for (const url of [
			"http://[::127.0.0.1]/",
			"http://[64:ff9b::192.168.1.1]/",
			"http://[2002:c0a8:101::1]/",
			"http://198.18.0.1/",
			"http://0/",
			"http://[::ffff:7f00:1]/",
		])
			expect(isLocalHost(new URL(url).hostname), url).toBe(true);
		for (const url of ["http://[64:ff9b::8.8.8.8]/", "http://[2002:808:808::]/", "http://[2001:db8::1]/", "http://198.20.0.1/"])
			expect(isLocalHost(new URL(url).hostname), url).toBe(false);
	});

	it("reads IPv6 in every form: compressed groups and the dotted tail dns.lookup writes", () => {
		for (const host of [
			"::127.0.0.1",
			"::10.0.0.1",
			"::ffff:192.168.1.1",
			"64:ff9b::10.1.2.3",
			"2002:a01::1",
			"2002:c0a8::",
			"::100",
			"64:ff9b::1",
			"::",
			"::1",
			"fd00::1",
			"fe80::1%eth0",
			"1::2::3",
			"::ffff:0:127.0.0.1",
			"64:ff9b:1::10.0.0.1",
			"fec0::1",
			"2001:0:4136:e378:8000:63bf:80ff:fffe",
		])
			expect(isLocalHost(host), host).toBe(true);
		for (const host of [
			"::8.8.8.8",
			"::ffff:8.8.8.8",
			"2002:808:808::1",
			"2001:4860:4860::8888",
			"64:ff9b::8.8.8.8",
			"::ffff:0:8.8.8.8",
			"fe7f::1",
			"64:ff9b:2::1",
			"2001:0:4136:e378:8000:63bf:f7f7:f7f7",
		])
			expect(isLocalHost(host), host).toBe(false);
	});

	it("closes a plugin world's own network: no directive allows a host, a scheme or 'self'", () => {
		const directives = new Map(
			worldCsp.split(";").map((part) => {
				const [name, ...sources] = part.trim().split(/\s+/);
				return [name, sources];
			}),
		);
		expect(directives.get("default-src")).toEqual(["'none'"]);
		for (const [name, sources] of directives)
			for (const source of sources) expect(["'none'", "'unsafe-eval'"].includes(source), `${name} ${source}`).toBeTruthy();
		// A directive that falls back to nothing but default-src: none of the network ones are listed apart
		for (const name of ["connect-src", "img-src", "media-src", "font-src", "style-src", "frame-src", "worker-src"])
			expect(directives.has(name), name).toBe(false);
	});
});

describe("host patterns", () => {
	it("refuses a wildcard over everything or over a public suffix", () => {
		for (const entry of [
			"*",
			"*.com",
			"*.co.uk",
			"*.github.io",
			"*.githubusercontent.com",
			"*.vercel.app",
			"",
			" ",
			"*.*.example.com",
			"a*.example.com",
			"*example.com",
		])
			expect(parseHostEntry(entry), entry).toBe(undefined);
		expect(parseHostEntry("*.fastly.net")).not.toBe(undefined);
		expect(parseHostEntry("*.example.co.uk")).not.toBe(undefined);
	});

	it("matches a path pattern, `*` for any characters, nothing else special", () => {
		const hosts = ["*.fastly.net/covers/*", "api.example.com/v1/*/info", "exact.example.com/a.json"];
		expect(allowed(hosts, "https://x.fastly.net/covers/1/2.jpg")).toBe(true);
		expect(allowed(hosts, "https://x.fastly.net/covers/")).toBe(true);
		expect(allowed(hosts, "https://x.fastly.net/other/covers/1.jpg")).toBe(false);
		expect(allowed(hosts, "https://x.fastly.net/covers")).toBe(false);
		expect(allowed(hosts, "https://api.example.com/v1/abc/info")).toBe(true);
		expect(allowed(hosts, "https://api.example.com/v1/a/b/info")).toBe(true);
		expect(allowed(hosts, "https://api.example.com/v1/abc/info2")).toBe(false);
		expect(allowed(hosts, "https://exact.example.com/a.json")).toBe(true);
		expect(allowed(hosts, "https://exact.example.com/a.json?x=1")).toBe(true);
		expect(allowed(hosts, "https://exact.example.com/aXjson")).toBe(false);
		// The URL parser resolves dot segments before the match
		expect(allowed(hosts, "https://x.fastly.net/covers/../secret")).toBe(false);
		expect(allowed(hosts, "https://x.fastly.net/covers/%2e%2e/secret")).toBe(false);
	});

	it("refuses paths the URL parser would rewrite", () => {
		for (const entry of ["a.com/../x", "a.com/./x", "a.com/%2e%2e/x", "a.com//x", "a.com/x?y", "a.com/x#y", "a.com/x\\y"])
			expect(parseHostEntry(entry), entry).toBe(undefined);
	});

	it("reads a setting in the package's storage, or in the storage a dotted key names", async () => {
		const stores: Record<string, Record<string, unknown>> = { "@x/jelly": { url: "a.com" }, Jellyfin: { serverUrl: "b.com" } };
		const storage = async (name: string) => stores[name];
		expect(await settingValueOf("url", "@x/jelly", storage)).toBe("a.com");
		expect(await settingValueOf("Jellyfin.serverUrl", "@x/jelly", storage)).toBe("b.com");
		expect(await settingValueOf("serverUrl", "@x/jelly", storage)).toBe(undefined);
		expect(await settingValueOf(".serverUrl", "@x/jelly", storage)).toBe(undefined);
	});

	it("refuses paths that would break out of the CSP source", () => {
		for (const entry of ["a.com/x;script-src", "a.com/b,sandbox", "a.com/'unsafe-eval'", "a.com/caf\u00e9", "a.com/%zz", 'a.com/x"y']) {
			expect(parseHostEntry(entry), entry).toBe(undefined);
			expect(cspSources([entry]), entry).toEqual([]);
		}
		expect(cspSources(["a.com/covers/%20x/*"])).toEqual(["https://a.com/covers/%20x/", "wss://a.com/covers/%20x/"]);
	});

	it("puts a path into the CSP as the prefix before its first `*`", () => {
		expect(cspSources(["*.fastly.net/covers/*"])).toEqual(["https://*.fastly.net/covers/", "wss://*.fastly.net/covers/"]);
		expect(cspSources(["a.com/x*"])).toEqual(["https://a.com", "wss://a.com"]);
		expect(cspSources(["a.com/file.json"])).toEqual(["https://a.com/file.json", "wss://a.com/file.json"]);
		// CSP matches paths case-sensitively: the path stays as written, the host goes to lower case
		expect(cspSources(["CDN.Example.com/Covers/*"])).toEqual(["https://cdn.example.com/Covers/", "wss://cdn.example.com/Covers/"]);
		expect(declaredHosts(["HTTP://A.com:8080/Path/*"])?.hosts).toEqual(["http://a.com:8080/Path/*"]);
		expect(allowed(["cdn.example.com/Covers/*"], "https://cdn.example.com/Covers/a.jpg")).toBe(true);
		expect(allowed(["cdn.example.com/Covers/*"], "https://cdn.example.com/COVERS/a.jpg")).toBe(false);
	});

	it("reads `{setting:<key>}` entries and resolves them to the setting's server only", () => {
		expect(declaredHosts(["{setting:serverUrl}", "{SETTING:serverUrl}", "{setting:}", "{setting:a b}"])).toEqual({
			hosts: ["{setting:serverUrl}"],
			invalid: ["{setting:}", "{setting:a b}"],
		});
		expect(settingKeys(["a.com", "{setting:url}"])).toEqual(["url"]);
		expect(settingValueEntry("http://NAS.lan:8096/jellyfin?x=1")).toBe("http://nas.lan:8096");
		expect(settingValueEntry("https://music.example.com/")).toBe("https://music.example.com");
		expect(settingValueEntry("music.example.com")).toBe("music.example.com");
		for (const value of ["", "  ", "*.example.com", "ftp://a.com", "https://u:p@a.com", "a.com/path", 5, undefined, "not a host"])
			expect(settingValueEntry(value), String(value)).toBe(undefined);
		const settings: Record<string, unknown> = { url: "http://192.168.1.5:4533" };
		expect(resolveSettings(["a.com", "{setting:url}", "{setting:empty}"], (key) => settings[key])).toEqual({
			hosts: ["a.com", "http://192.168.1.5:4533"],
			settings: ["http://192.168.1.5:4533"],
		});
		expect(cspSources(["{setting:url}"]).length).toBe(0);
	});
});
