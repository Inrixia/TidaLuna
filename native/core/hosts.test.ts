import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cspSources, declaredHosts, hostAllowed, hostsDiff, isLocalEntry, isLocalHost, localEntryAllows, parseHostEntry, sameHosts } from "./hosts";

const allowed = (hosts: string[], url: string) => hostAllowed(hosts, new URL(url));

describe("plugin hosts", () => {
	it("reads valid entries and keeps invalid ones apart", () => {
		assert.deepEqual(declaredHosts(["API.Last.fm", " ws.audioscrobbler.com ", "*.example.com", "http://127.0.0.1:8080", "api.last.fm"]), {
			hosts: ["api.last.fm", "ws.audioscrobbler.com", "*.example.com", "http://127.0.0.1:8080"],
			invalid: [],
		});
		assert.deepEqual(declaredHosts(["*", "*.com", "ftp://x.com", "https://a.com/path", "user@a.com", "a.com:99999", "999.1.1.1", 5])!.hosts, []);
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
		assert.deepEqual(parseHostEntry("wss://*.x.com:444"), { schemes: ["wss"], host: "x.com", wildcard: true, port: "444" });
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
		for (const entry of ["localhost", "http://127.0.0.1:8080", "nas.lan", "*.home.arpa", "http://192.168.1.10:8123"]) assert.equal(isLocalEntry(entry), true, entry);
		for (const entry of ["api.example.com", "*.example.com", "not an entry"]) assert.equal(isLocalEntry(entry), false, entry);
		assert.equal(localEntryAllows(["api.example.com", "http://127.0.0.1:8080"], new URL("http://127.0.0.1:8080/x")), true);
		assert.equal(localEntryAllows(["api.example.com", "http://127.0.0.1:8080"], new URL("https://api.example.com/")), false);
	});
});
