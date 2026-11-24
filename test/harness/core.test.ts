import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import * as harness from "./core";

/**
 * The harness stands in for `@luna/core` in tests, so it has to expose everything that barrel does — otherwise a
 * module under test fails to import and the reason is easy to miss. `render/src/index.ts` can't be imported here
 * (it boots TIDAL), so its export names are read from the source.
 */
// `import.meta.url` is not a file url in the dom environment
const barrelPath = path.join(process.cwd(), "render/src/index.ts");

const runtimeExportNames = (source: string): string[] => {
	const names = new Set<string>();
	// export { a, b as c } from "./x"
	for (const [, clause] of source.matchAll(/export\s*\{([^}]+)\}\s*from/g)) {
		for (const part of clause.split(",")) {
			const local = part.trim().split(/\s+as\s+/)[0]?.trim();
			// `type Foo` exports are erased
			if (!local || local.startsWith("type ")) continue;
			names.add(local.replace(/^type\s+/, ""));
		}
	}
	// export * as ftch from "./helpers/fetch"
	for (const [, name] of source.matchAll(/export\s*\*\s*as\s+(\w+)\s*from/g)) names.add(name);
	return [...names];
};

describe("the @luna/core stand-in", () => {
	test("exposes every export of render/src/index.ts", async () => {
		const source = await readFile(barrelPath, "utf8");
		const names = runtimeExportNames(source);
		// `export * from` can't be read statically, these are what those barrels export.
		// SettingsTransfer is left out on purpose, see core.ts
		const starExports = ["LunaPlugin", "ReactiveStore"];

		expect(names.length).toBeGreaterThan(0);
		for (const name of [...names, ...starExports]) {
			expect(Object.keys(harness)).toContain(name);
		}
	});

	test("returns a redux store shaped like TIDAL's", () => {
		expect(harness.reduxStore.getState().session).toBeDefined();
		harness.setTidalState({ session: { userId: "42", countryCode: "AU" } });
		expect(harness.reduxStore.getState().session.userId).toBe("42");
	});
});
