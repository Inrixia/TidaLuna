import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
		assert.deepEqual(declaredHosts(["API.Last.fm", " ws.audioscrobbler.com ", "*.example.com", "http://127.0.0.1:8080", "api.last.fm"]), {
			hosts: ["api.last.fm", "ws.audioscrobbler.com", "*.example.com", "http://127.0.0.1:8080"],
			invalid: [],
		});
		assert.deepEqual(declaredHosts(["*", "*.com", "ftp://x.com", "https://a.com/a?b", "user@a.com", "a.com:99999", "999.1.1.1", 5])!.hosts, []);
		assert.equal(declaredHosts(["*", "ok.com"])?.invalid.length, 1);
	});

	it("tells no hosts (compatibility mode) from an empty list", () => {
		assert.equal(declaredHosts(undefined), undefined);
		assert.equal(declaredHosts("api.last.fm"), undefined);
		assert.deepEqual(declaredHosts([]), { hosts: [], invalid: [] });
	});

	it("matches https and wss on the default port by default", () => {
		const hosts = ["api.last.fm"];
		assert.equal(allowed(hosts, "https://api.last.fm/2.0/?method=x"), true);
		assert.equal(allowed(hosts, "wss://api.last.fm/socket"), true);
		assert.equal(allowed(hosts, "http://api.last.fm/"), false);
		assert.equal(allowed(hosts, "https://api.last.fm:8443/"), false);
		assert.equal(allowed(hosts, "https://evil.api.last.fm/"), false);
		assert.equal(allowed(hosts, "https://api.last.fm.evil.com/"), false);
		assert.equal(allowed(hosts, "https://last.fm/"), false);
	});

	it("matches subdomains for a wildcard, not the domain itself", () => {
		const hosts = ["*.example.com"];
		assert.equal(allowed(hosts, "https://a.example.com/"), true);
		assert.equal(allowed(hosts, "https://a.b.example.com/"), true);
		assert.equal(allowed(hosts, "https://example.com/"), false);
		assert.equal(allowed(hosts, "https://badexample.com/"), false);
	});

	it("needs the scheme and port written out for anything else", () => {
		const hosts = ["http://127.0.0.1:8080", "http://localhost"];
		assert.equal(allowed(hosts, "http://127.0.0.1:8080/x"), true);
		assert.equal(allowed(hosts, "http://127.0.0.1:8081/x"), false);
		assert.equal(allowed(hosts, "https://127.0.0.1:8080/x"), false);
		assert.equal(allowed(hosts, "http://localhost/"), true);
		assert.equal(allowed(hosts, "http://localhost:80/"), true);
	});

	it("compares and diffs host lists", () => {
		assert.equal(sameHosts(["a.com", "b.com"], ["B.com", "a.com"]), true);
		assert.equal(sameHosts(undefined, undefined), true);
		assert.equal(sameHosts(undefined, []), false);
		assert.equal(sameHosts(["a.com"], ["a.com", "c.com"]), false);
		assert.deepEqual(hostsDiff(["a.com", "b.com"], ["b.com", "c.com"]), { added: ["c.com"], removed: ["a.com"] });
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
			assert.equal(isLocalHost(host), true, host);
		for (const host of ["api.last.fm", "8.8.8.8", "172.32.0.1", "[2606:4700::1111]"]) assert.equal(isLocalHost(host), false, host);
	});

	it("gives CSP sources for each scheme", () => {
		assert.deepEqual(cspSources(["api.last.fm", "*.example.com", "http://127.0.0.1:8080", "bad host"]), [
			"https://api.last.fm",
			"wss://api.last.fm",
			"https://*.example.com",
			"wss://*.example.com",
			"http://127.0.0.1:8080",
		]);
	});

	it("parses an entry into its rule", () => {
		assert.deepEqual(parseHostEntry("wss://*.x.com:444"), { schemes: ["wss"], host: "x.com", wildcard: true, port: "444", path: "" });
		assert.equal(parseHostEntry("*.localhost"), undefined);
		assert.equal(parseHostEntry("*.1.2.3.4"), undefined);
	});

	it("refuses names ending in a number: the URL parser reads them as IPv4", () => {
		for (const entry of ["*.0.0.1", "*.1.1", "http://*.1.1", "a.0x7f", "1.2.3", "x.123"]) assert.equal(parseHostEntry(entry), undefined, entry);
		assert.equal(hostAllowed(["*.1.1"], new URL("https://192.168.1.1/")), false);
		assert.ok(parseHostEntry("a1.example.com"));
		assert.ok(parseHostEntry("cdn.123abc.com"));
		assert.ok(parseHostEntry("10.0.0.5"));
	});

	it("tells local entries apart: only they let luna.fetch reach a local address", () => {
		for (const entry of ["localhost", "http://127.0.0.1:8080", "nas.lan", "*.home.arpa", "http://192.168.1.10:8123"])
			assert.equal(isLocalEntry(entry), true, entry);
		for (const entry of ["api.example.com", "*.example.com", "not an entry"]) assert.equal(isLocalEntry(entry), false, entry);
		assert.equal(localEntryAllows(["api.example.com", "http://127.0.0.1:8080"], new URL("http://127.0.0.1:8080/x")), true);
		assert.equal(localEntryAllows(["api.example.com", "http://127.0.0.1:8080"], new URL("https://api.example.com/")), false);
	});

	it("refuses leading zeros, which the URL parser reads another way", () => {
		for (const entry of ["010.0.0.1", "10.0.0.01", "a.com:08080"]) assert.equal(parseHostEntry(entry), undefined, entry);
		assert.ok(parseHostEntry("10.0.0.1"));
		assert.ok(parseHostEntry("a.com:8080"));
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
			assert.equal(isLocalHost(new URL(url).hostname), true, url);
		for (const url of ["http://[64:ff9b::8.8.8.8]/", "http://[2002:808:808::]/", "http://[2001:db8::1]/", "http://198.20.0.1/"])
			assert.equal(isLocalHost(new URL(url).hostname), false, url);
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
			assert.equal(isLocalHost(host), true, host);
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
			assert.equal(isLocalHost(host), false, host);
	});

	it("closes a plugin world's own network: no directive allows a host, a scheme or 'self'", () => {
		const directives = new Map(
			worldCsp.split(";").map((part) => {
				const [name, ...sources] = part.trim().split(/\s+/);
				return [name, sources];
			}),
		);
		assert.deepEqual(directives.get("default-src"), ["'none'"]);
		for (const [name, sources] of directives)
			for (const source of sources) assert.ok(["'none'", "'unsafe-eval'"].includes(source), `${name} ${source}`);
		// A directive that falls back to nothing but default-src: none of the network ones are listed apart
		for (const name of ["connect-src", "img-src", "media-src", "font-src", "style-src", "frame-src", "worker-src"])
			assert.equal(directives.has(name), false, name);
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
			assert.equal(parseHostEntry(entry), undefined, entry);
		assert.notEqual(parseHostEntry("*.fastly.net"), undefined);
		assert.notEqual(parseHostEntry("*.example.co.uk"), undefined);
	});

	it("matches a path pattern, `*` for any characters, nothing else special", () => {
		const hosts = ["*.fastly.net/covers/*", "api.example.com/v1/*/info", "exact.example.com/a.json"];
		assert.equal(allowed(hosts, "https://x.fastly.net/covers/1/2.jpg"), true);
		assert.equal(allowed(hosts, "https://x.fastly.net/covers/"), true);
		assert.equal(allowed(hosts, "https://x.fastly.net/other/covers/1.jpg"), false);
		assert.equal(allowed(hosts, "https://x.fastly.net/covers"), false);
		assert.equal(allowed(hosts, "https://api.example.com/v1/abc/info"), true);
		assert.equal(allowed(hosts, "https://api.example.com/v1/a/b/info"), true);
		assert.equal(allowed(hosts, "https://api.example.com/v1/abc/info2"), false);
		assert.equal(allowed(hosts, "https://exact.example.com/a.json"), true);
		assert.equal(allowed(hosts, "https://exact.example.com/a.json?x=1"), true);
		assert.equal(allowed(hosts, "https://exact.example.com/aXjson"), false);
		// The URL parser resolves dot segments before the match
		assert.equal(allowed(hosts, "https://x.fastly.net/covers/../secret"), false);
		assert.equal(allowed(hosts, "https://x.fastly.net/covers/%2e%2e/secret"), false);
	});

	it("refuses paths the URL parser would rewrite", () => {
		for (const entry of ["a.com/../x", "a.com/./x", "a.com/%2e%2e/x", "a.com//x", "a.com/x?y", "a.com/x#y", "a.com/x\\y"])
			assert.equal(parseHostEntry(entry), undefined, entry);
	});

	it("reads a setting in the package's storage, or in the storage a dotted key names", async () => {
		const stores: Record<string, Record<string, unknown>> = { "@x/jelly": { url: "a.com" }, Jellyfin: { serverUrl: "b.com" } };
		const storage = async (name: string) => stores[name];
		assert.equal(await settingValueOf("url", "@x/jelly", storage), "a.com");
		assert.equal(await settingValueOf("Jellyfin.serverUrl", "@x/jelly", storage), "b.com");
		assert.equal(await settingValueOf("serverUrl", "@x/jelly", storage), undefined);
		assert.equal(await settingValueOf(".serverUrl", "@x/jelly", storage), undefined);
	});

	it("refuses paths that would break out of the CSP source", () => {
		for (const entry of ["a.com/x;script-src", "a.com/b,sandbox", "a.com/'unsafe-eval'", "a.com/caf\u00e9", "a.com/%zz", 'a.com/x"y']) {
			assert.equal(parseHostEntry(entry), undefined, entry);
			assert.deepEqual(cspSources([entry]), [], entry);
		}
		assert.deepEqual(cspSources(["a.com/covers/%20x/*"]), ["https://a.com/covers/%20x/", "wss://a.com/covers/%20x/"]);
	});

	it("puts a path into the CSP as the prefix before its first `*`", () => {
		assert.deepEqual(cspSources(["*.fastly.net/covers/*"]), ["https://*.fastly.net/covers/", "wss://*.fastly.net/covers/"]);
		assert.deepEqual(cspSources(["a.com/x*"]), ["https://a.com", "wss://a.com"]);
		assert.deepEqual(cspSources(["a.com/file.json"]), ["https://a.com/file.json", "wss://a.com/file.json"]);
	});

	it("reads `{setting:<key>}` entries and resolves them to the setting's server only", () => {
		assert.deepEqual(declaredHosts(["{setting:serverUrl}", "{SETTING:serverUrl}", "{setting:}", "{setting:a b}"]), {
			hosts: ["{setting:serverUrl}"],
			invalid: ["{setting:}", "{setting:a b}"],
		});
		assert.deepEqual(settingKeys(["a.com", "{setting:url}"]), ["url"]);
		assert.equal(settingValueEntry("http://NAS.lan:8096/jellyfin?x=1"), "http://nas.lan:8096");
		assert.equal(settingValueEntry("https://music.example.com/"), "https://music.example.com");
		assert.equal(settingValueEntry("music.example.com"), "music.example.com");
		for (const value of ["", "  ", "*.example.com", "ftp://a.com", "https://u:p@a.com", "a.com/path", 5, undefined, "not a host"])
			assert.equal(settingValueEntry(value), undefined, String(value));
		const settings: Record<string, unknown> = { url: "http://192.168.1.5:4533" };
		assert.deepEqual(
			resolveSettings(["a.com", "{setting:url}", "{setting:empty}"], (key) => settings[key]),
			{
				hosts: ["a.com", "http://192.168.1.5:4533"],
				settings: ["http://192.168.1.5:4533"],
			},
		);
		assert.equal(cspSources(["{setting:url}"]).length, 0);
	});
});
