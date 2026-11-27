import { describe, expect, it } from "vitest";

import { baselineEntries } from "../cspReportOnly";
import { defaultStoreOrigins, storeOriginOf, storeUrlAllowed } from "./stores";

describe("plugin store origins", () => {
	it("reads the origin of plain http(s) urls only", () => {
		expect(storeOriginOf("https://release.radiant-lyrics.org/store.json")).toBe("https://release.radiant-lyrics.org");
		expect(storeOriginOf("http://localhost:3005/HostsPage")).toBe("http://localhost:3005");
		expect(storeOriginOf("https://user:pw@example.com/x")).toBe(undefined);
		expect(storeOriginOf("file:///C:/x")).toBe(undefined);
		expect(storeOriginOf("not a url")).toBe(undefined);
		expect(storeOriginOf(1)).toBe(undefined);
	});
	it("allows a known origin, GitHub over https and a dev plugin on this computer", () => {
		const origins = [...defaultStoreOrigins, "https://my-store.example"];
		expect(storeUrlAllowed("https://release.radiant-lyrics.org/Plugin", origins, baselineEntries)).toBeTruthy();
		expect(storeUrlAllowed("https://my-store.example/Plugin", origins, baselineEntries)).toBeTruthy();
		expect(storeUrlAllowed("https://github.com/a/b/releases/download/latest/Plugin", origins, baselineEntries)).toBeTruthy();
		expect(storeUrlAllowed("http://127.0.0.1:3005/Plugin", origins, baselineEntries)).toBeTruthy();
		// What page code could name to have main fetch from any host
		expect(storeUrlAllowed("https://evil.example/secret/Plugin", origins, baselineEntries)).toBe(false);
		expect(storeUrlAllowed("http://github.com/a/Plugin", origins, baselineEntries)).toBe(false);
		expect(storeUrlAllowed("https://my-store.example:8443/Plugin", origins, baselineEntries)).toBe(false);
		expect(storeUrlAllowed("http://localhost:3005/Plugin", origins, baselineEntries)).toBe(false);
	});
});
