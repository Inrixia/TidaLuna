import { findModuleProperty, tidalModules } from "@luna/core";
import { beforeEach, describe, expect, test } from "vitest";

import { getCredentials } from "./getCredentials";

/**
 * `getCredentials` finds TIDAL's `getCredentials` through `findModuleProperty`, whose selector memoizes: the selector
 * here is a module constant, so a lookup (including a miss) would otherwise be cached for the whole file. Each test
 * empties the seeded modules and clears the memo instead of reloading the module.
 */
const seed = (modules: Record<string, object>) => Object.assign(tidalModules, modules);
/** `memoize` only types `clear` for the arguments it memoized; at runtime it clears every lookup when called bare */
const clearLookups = () => (findModuleProperty as unknown as { clear: () => void }).clear();
beforeEach(() => {
	for (const key of Object.keys(tidalModules)) delete tidalModules[key];
	clearLookups();
});

const credentials = () => ({
	clientId: "luna-test-client",
	clientUniqueKey: "unique-key",
	expires: 1_800_000_000,
	grantedScopes: ["r_usr", "w_usr"],
	requestedScopes: ["r_usr", "w_usr"],
	token: "access-token",
	userId: "1234567",
});

describe("getCredentials", () => {
	test("returns the credentials of TIDAL's module", async () => {
		const creds = credentials();
		seed({ "tidal/session": { getCredentials: async () => creds } });

		expect(await getCredentials()).toBe(creds);
	});

	test("throws when TIDAL has no getCredentials", async () => {
		seed({ "tidal/session": { loggedIn: true } });

		await expect(getCredentials()).rejects.toThrow("Could not find Tidal credentials module");
	});

	test("ignores a getCredentials that isn't callable", async () => {
		seed({ "tidal/session": { getCredentials: "access-token" } });

		await expect(getCredentials()).rejects.toThrow("Could not find Tidal credentials module");
	});

	test.each([
		[undefined, "undefined"],
		[null, "object"],
		[0, "number"],
		["", "string"],
	])("throws when the module returns %s", async (value, type) => {
		seed({ "tidal/session": { getCredentials: async () => value } });

		await expect(getCredentials()).rejects.toThrow(`getCredentials returned ${type}!`);
	});
});
