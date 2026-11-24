import assert from "node:assert";
import { describe, it } from "node:test";

import { allowSource } from "./allowSource";

/** Luna core as the page sees it: the origins its CSP had at load, what allowStore answers, the origins core reads from */
const core = (pageStores: string[], allows: boolean, storeOrigins: string[]) => {
	const asked: string[] = [];
	(globalThis as { __LunaCore?: unknown }).__LunaCore = {
		pageStores: async () => pageStores,
		allowStore: async (url: string) => (asked.push(url), allows),
		storeOrigins: async () => storeOrigins,
	};
	return asked;
};

describe("allowSource", () => {
	it("reads at once from an origin the page's CSP has, without asking", async () => {
		const asked = core(["https://store.example"], true, ["https://store.example"]);
		assert.equal(await allowSource("https://store.example/theme.css"), "ready");
		assert.deepEqual(asked, []);
	});

	it("asks for any other origin: denied, or readable once TIDAL reloads", async () => {
		assert.equal(await allowSource((core([], false, []), "https://new.example/theme.css")), "denied");
		const asked = core([], true, ["https://new.example"]);
		assert.equal(await allowSource("https://new.example/theme.css"), "reload");
		assert.deepEqual(asked, ["https://new.example/theme.css"]);
	});

	it("reads at once from an origin allowed but never listed (GitHub, TIDAL's hosts)", async () => {
		core([], true, []);
		assert.equal(await allowSource("https://raw.githubusercontent.com/a/b/theme.css"), "ready");
	});
});
