import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	// NativeModule/index.ts builds a require from process.resourcesPath at import time
	(process as unknown as { resourcesPath: string }).resourcesPath = process.cwd();
});

import { secureLoad } from "./secureLoad";

const runInSandbox = async <T = Record<string, unknown>>(code: string, fileName = "sandbox-test.native.ts"): Promise<T> =>
	(await secureLoad({
		fileName,
		code,
		hash: "test-hash",
		isCore: true,
	})) as unknown as T;

describe("secureLoad sandbox process", () => {
	const originalPath = process.env.PATH;

	afterEach(() => {
		delete process.env.LUNA_TEST_SECRET;
		delete process.env.LUNA_SANDBOX_ADDED;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	});

	it("exposes a filtered, frozen process.env that cannot be mutated in strict or sloppy mode", async () => {
		process.env.LUNA_TEST_SECRET = "top-secret";

		const result = await runInSandbox<{
			strictAddThrows: boolean;
			strictModifyThrows: boolean;
			strictDeleteThrows: boolean;
			sloppyDeleteResult: boolean;
			isFrozen: boolean;
			requireIsSameFrozen: boolean;
			hasSecret: boolean;
			hasPath: boolean;
			pathAfter: string | undefined;
			addedValue: unknown;
		}>(`
			const procFromRequire = require("process");
			const procFromNodeRequire = require("node:process");

			const tryStrict = (fn) => {
				try {
					fn();
					return false;
				} catch (err) {
					return err instanceof TypeError;
				}
			};

			const strictAddThrows = tryStrict(() => {
				"use strict";
				process.env.LUNA_SANDBOX_ADDED = "injected";
			});
			const strictModifyThrows = tryStrict(() => {
				"use strict";
				process.env.PATH = "mutated";
			});
			const strictDeleteThrows = tryStrict(() => {
				"use strict";
				delete process.env.PATH;
			});

			// Sloppy mode writes and deletes must also have no effect
			process.env.LUNA_SANDBOX_ADDED = "sloppy";
			process.env.PATH = "sloppy-mutated";
			const sloppyDeleteResult = delete process.env.PATH;

			module.exports = {
				strictAddThrows,
				strictModifyThrows,
				strictDeleteThrows,
				sloppyDeleteResult,
				isFrozen: Object.isFrozen(process.env),
				requireIsSameFrozen: procFromRequire.env === process.env && Object.isFrozen(procFromNodeRequire.env),
				hasSecret: "LUNA_TEST_SECRET" in process.env,
				hasPath: "PATH" in process.env,
				pathAfter: process.env.PATH,
				addedValue: process.env.LUNA_SANDBOX_ADDED,
			};
		`);

		expect(result.isFrozen).toBe(true);
		expect(result.requireIsSameFrozen).toBe(true);
		expect(result.strictAddThrows).toBe(true);
		expect(result.strictModifyThrows).toBe(true);
		expect(result.strictDeleteThrows).toBe(true);
		expect(result.sloppyDeleteResult).toBe(false);
		expect(result.hasSecret).toBe(false);
		expect(result.hasPath).toBe(true);
		expect(result.pathAfter).toBe(originalPath);
		expect(result.addedValue).toBeUndefined();
		expect(process.env.LUNA_SANDBOX_ADDED).toBeUndefined();
		expect(process.env.PATH).toBe(originalPath);
	});

	it("isolates and freezes versions, release, and features without leaking live process references", async () => {
		const realNodeVersion = process.versions.node;
		const realReleaseName = process.release.name;
		const realUvFeature = process.features.uv;

		const result = await runInSandbox<{
			versionsMatch: boolean;
			releaseMatch: boolean;
			featuresMatch: boolean;
			versionsFrozen: boolean;
			releaseFrozen: boolean;
			featuresFrozen: boolean;
			versionsWriteThrows: boolean;
			releaseWriteThrows: boolean;
			featuresWriteThrows: boolean;
			nodeAfter: string;
			releaseNameAfter: string;
			uvAfter: boolean;
		}>(`
			"use strict";
			const tryMutate = (fn) => {
				try {
					fn();
					return false;
				} catch (err) {
					return err instanceof TypeError;
				}
			};

			module.exports = {
				versionsMatch: process.versions.node === ${JSON.stringify(realNodeVersion)},
				releaseMatch: process.release.name === ${JSON.stringify(realReleaseName)},
				featuresMatch: process.features.uv === ${JSON.stringify(realUvFeature)},
				versionsFrozen: Object.isFrozen(process.versions),
				releaseFrozen: Object.isFrozen(process.release),
				featuresFrozen: Object.isFrozen(process.features),
				versionsWriteThrows: tryMutate(() => { process.versions.node = "0.0.0"; }),
				releaseWriteThrows: tryMutate(() => { process.release.name = "evil"; }),
				featuresWriteThrows: tryMutate(() => { process.features.uv = false; }),
				nodeAfter: process.versions.node,
				releaseNameAfter: process.release.name,
				uvAfter: process.features.uv,
			};
		`);

		expect(result.versionsMatch).toBe(true);
		expect(result.releaseMatch).toBe(true);
		expect(result.featuresMatch).toBe(true);
		expect(result.versionsFrozen).toBe(true);
		expect(result.releaseFrozen).toBe(true);
		expect(result.featuresFrozen).toBe(true);
		expect(result.versionsWriteThrows).toBe(true);
		expect(result.releaseWriteThrows).toBe(true);
		expect(result.featuresWriteThrows).toBe(true);
		expect(result.nodeAfter).toBe(realNodeVersion);
		expect(result.releaseNameAfter).toBe(realReleaseName);
		expect(result.uvAfter).toBe(realUvFeature);
		expect(process.versions.node).toBe(realNodeVersion);
		expect(process.release.name).toBe(realReleaseName);
		expect(process.features.uv).toBe(realUvFeature);
	});
});
