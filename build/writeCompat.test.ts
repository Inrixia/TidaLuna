import { describe, expect, test } from "vitest";

import { compatForArchive } from "./writeCompat";

/**
 * The `compat.json` a release publishes.
 *
 * The digest is the part that matters: it is what an unattended install checks the downloaded archive against, so it has
 * to describe those exact bytes, and the file has to name the release it belongs to or the other side refuses it.
 */
const zip = new TextEncoder().encode("the archive bytes");

describe("compatForArchive", () => {
	test("names the release and describes the archive it was made from", () => {
		const compat = compatForArchive(zip, { version: "1.26.0", tidal: { tested: ["2.48.0"], min: "2.44.0" } });

		expect(compat.luna).toBe("1.26.0");
		expect(compat.tidal).toEqual({ tested: ["2.48.0"], min: "2.44.0" });
		expect(compat.zip.bytes).toBe(zip.length);
		expect(compat.zip.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("the digest is of those bytes, not of anything else", () => {
		const first = compatForArchive(zip, { version: "1.26.0" });
		const other = compatForArchive(new TextEncoder().encode("other bytes"), { version: "1.26.0" });

		expect(first.zip.sha256).not.toBe(other.zip.sha256);
		expect(compatForArchive(zip, { version: "1.26.0" }).zip.sha256).toBe(first.zip.sha256);
	});

	test("a release that declares nothing publishes no claims", () => {
		expect(compatForArchive(zip, { version: "1.26.0" }).tidal).toEqual({ tested: undefined, min: undefined });
	});

	test("refuses to publish a file for a package with no usable version", () => {
		for (const version of [undefined, "", "latest", 42]) expect(() => compatForArchive(zip, { version })).toThrow(/no usable version/);
	});
});
