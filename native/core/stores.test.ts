import assert from "node:assert";
import { describe, it } from "node:test";

import { baselineEntries } from "../cspReportOnly";
import { defaultStoreOrigins, storeOriginOf, storeUrlAllowed } from "./stores";

describe("plugin store origins", () => {
	it("reads the origin of plain http(s) urls only", () => {
		assert.strictEqual(storeOriginOf("https://release.radiant-lyrics.org/store.json"), "https://release.radiant-lyrics.org");
		assert.strictEqual(storeOriginOf("http://localhost:3005/HostsPage"), "http://localhost:3005");
		assert.strictEqual(storeOriginOf("https://user:pw@example.com/x"), undefined);
		assert.strictEqual(storeOriginOf("file:///C:/x"), undefined);
		assert.strictEqual(storeOriginOf("not a url"), undefined);
		assert.strictEqual(storeOriginOf(1), undefined);
	});
	it("allows a known origin, GitHub over https and a dev plugin on this computer", () => {
		const origins = [...defaultStoreOrigins, "https://my-store.example"];
		assert.ok(storeUrlAllowed("https://release.radiant-lyrics.org/Plugin", origins, baselineEntries));
		assert.ok(storeUrlAllowed("https://my-store.example/Plugin", origins, baselineEntries));
		assert.ok(storeUrlAllowed("https://github.com/a/b/releases/download/latest/Plugin", origins, baselineEntries));
		assert.ok(storeUrlAllowed("http://127.0.0.1:3005/Plugin", origins, baselineEntries));
		// What page code could name to have main fetch from any host
		assert.strictEqual(storeUrlAllowed("https://evil.example/secret/Plugin", origins, baselineEntries), false);
		assert.strictEqual(storeUrlAllowed("http://github.com/a/Plugin", origins, baselineEntries), false);
		assert.strictEqual(storeUrlAllowed("https://my-store.example:8443/Plugin", origins, baselineEntries), false);
		assert.strictEqual(storeUrlAllowed("http://localhost:3005/Plugin", origins, baselineEntries), false);
	});
});
