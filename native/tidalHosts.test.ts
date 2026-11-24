import { describe, expect, test } from "vitest";

import { tidalMainHosts } from "./tidalHosts";

describe("tidalMainHosts", () => {
	test("is exactly the hosts the TIDAL web client is served from", () => {
		// Luna injects into, patches and serves files for these hosts only (native/preload.ts, native/injector.ts),
		// so anything else here would hand TIDAL's privileges to another site
		expect([...tidalMainHosts].sort()).toEqual(["desktop.tidal.com", "listen.tidal.com", "stage.tidal.com", "tidal.com"]);
	});

	test.each(["listen.tidal.com", "tidal.com", "desktop.tidal.com", "stage.tidal.com"])("%s is a TIDAL host", (host) => {
		expect(tidalMainHosts.has(host)).toBe(true);
	});

	// hostname comparisons are exact string lookups, so lookalikes must not pass
	test.each([
		["a lookalike", "evil-tidal.com"],
		["the host as a prefix", "tidal.com.evil.com"],
		["another subdomain", "listen.tidal.com.evil.com"],
		["an unlisted subdomain", "evil.listen.tidal.com"],
		["an unlisted subdomain of the bare host", "api.tidal.com"],
		["the host with a trailing dot", "tidal.com."],
		["the host with a port", "tidal.com:443"],
		["the host in upper case", "TIDAL.COM"],
		["a wildcard", "*.tidal.com"],
		["the whole url", "https://tidal.com"],
		["an empty hostname", ""],
	])("%s is not a TIDAL host", (_name, host) => {
		expect(tidalMainHosts.has(host)).toBe(false);
	});
});
