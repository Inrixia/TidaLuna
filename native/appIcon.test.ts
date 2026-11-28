import { describe, expect, test } from "vitest";

import { appIconPng, appIconSize, createAppIcon, isAppIconPng } from "./appIcon";

describe("appIconPng", () => {
	test("is the 256px png from the brand assets", () => {
		expect(isAppIconPng(appIconPng)).toBe(true);
		expect(appIconSize(appIconPng)).toEqual({ width: 256, height: 256 });
	});
});

describe("isAppIconPng", () => {
	test("rejects anything that is not a png", () => {
		expect(isAppIconPng(Buffer.from("<svg></svg>"))).toBe(false);
	});

	test("rejects a truncated png", () => {
		expect(isAppIconPng(appIconPng.subarray(0, 4))).toBe(false);
	});
});

describe("appIconSize", () => {
	test("throws instead of reading garbage out of a non-png", () => {
		expect(() => appIconSize(Buffer.from("nope"))).toThrow("Not a PNG");
	});
});

describe("createAppIcon", () => {
	test("hands the png bytes to nativeImage", () => {
		const seen: Buffer[] = [];
		const icon = createAppIcon({ createFromBuffer: (png: Buffer) => (seen.push(png), { png }) });
		expect(seen).toEqual([appIconPng]);
		expect(icon?.png).toBe(appIconPng);
	});

	test("returns undefined for a broken asset, leaving TIDAL's own icon alone", () => {
		expect(createAppIcon({ createFromBuffer: () => "icon" }, Buffer.from("nope"))).toBeUndefined();
	});
});
