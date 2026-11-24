import { describe, expect, test } from "vitest";

import { groupModules } from "./categories";

/**
 * `groupModules` is what the permission prompt shows: the modules a native file names, grouped by what they let it do.
 * The per-module table behind it is private now, so this tests the grouping through the public entry point.
 */
const ids = (modules: string[]) => groupModules(modules).map(({ id }) => id);

describe("groupModules", () => {
	test("returns nothing for a file that names no modules", () => {
		expect(groupModules([])).toEqual([]);
		expect(groupModules(new Set())).toEqual([]);
	});

	test("puts modules under the category that describes them", () => {
		expect(ids(["fs"])).toEqual(["filesystem"]);
		expect(ids(["os"])).toEqual(["system"]);
		expect(ids(["child_process"])).toEqual(["execute"]);
		expect(ids(["electron"])).toEqual(["electron"]);
		expect(ids(["inspector"])).toEqual(["debug"]);
		expect(ids(["dgram"])).toEqual(["udp"]);
	});

	test("modules that need the same prompt share one group", () => {
		expect(ids(["tls", "net", "http", "https", "http2", "dns"])).toEqual(["network"]);
	});

	test("orders groups the way the prompt lists them, not the order given", () => {
		// debug is last in the table, network first, filesystem third
		expect(ids(["v8", "fs", "net"])).toEqual(["network", "filesystem", "debug"]);
	});

	test("keeps each group's modules in the order the file named them", () => {
		const [network] = groupModules(["https", "net", "http"]);
		expect(network.id).toBe("network");
		expect(network.modules).toEqual(["https", "net", "http"]);
	});

	test("modules with no category of their own are grouped last as Other Modules", () => {
		const groups = groupModules(["fs", "some-random-module"]);
		expect(groups.map(({ id }) => id)).toEqual(["filesystem", "other"]);
		const other = groups.at(-1)!;
		expect(other.label).toBe("Other Modules");
		expect(other.modules).toEqual(["some-random-module"]);
	});

	test("TIDAL's own files group as TIDAL and Luna app code", () => {
		expect(ids(["./app/player.js"])).toEqual(["tidal"]);
		expect(ids(["./original.asar/index.js"])).toEqual(["tidal"]);
		// Backslashes arrive from Windows paths
		expect(ids([".\\app\\player.js"])).toEqual(["tidal"]);
	});

	test("a path that climbs out of TIDAL's folders is not TIDAL's own code", () => {
		// The guard normalizes before matching, so a traversal can't borrow TIDAL's trust
		expect(ids(["./app/../../evil.js"])).toEqual(["other"]);
		expect(ids(["./original.asar/../node_modules/evil.js"])).toEqual(["other"]);
		// A plain module name that happens to start with app/ is not a path either
		expect(ids(["app/player.js"])).toEqual(["other"]);
	});

	test("every group carries a label and a description for the prompt", () => {
		for (const { label, description } of groupModules(["net", "fs", "v8", "unknown-thing", "./app/x.js"])) {
			expect(label.length).toBeGreaterThan(0);
			expect(description.length).toBeGreaterThan(0);
		}
	});

	test("only reports the categories the file actually uses", () => {
		const groups = groupModules(["fs"]);
		expect(groups).toHaveLength(1);
		expect(groups[0].modules).toEqual(["fs"]);
	});
});
