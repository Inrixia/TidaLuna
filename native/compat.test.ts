import { describe, expect, test } from "vitest";

import { buildCompat, compatVerdict, parseCompat } from "./compat";

/**
 * The claims a release makes about TIDAL, and how they are read.
 *
 * `parseCompat` takes untrusted input — a file downloaded from a release — so the tests are mostly rejections: a release
 * must not be able to claim support it does not have, or name a digest that is not a digest.
 */
const SHA = "a".repeat(64);
const zip = { sha256: SHA, bytes: 1024 };

describe("buildCompat", () => {
	test("publishes the versions it was given", () => {
		expect(buildCompat({ lunaVersion: "1.26.0", tidal: { tested: ["2.48.0"], min: "2.44.0" }, zip })).toEqual({
			luna: "1.26.0",
			tidal: { tested: ["2.48.0"], min: "2.44.0" },
			zip,
		});
	});

	test("drops entries that are not versions rather than publishing claims that match nothing", () => {
		const compat = buildCompat({ lunaVersion: "1.26.0", tidal: { tested: ["2.48.0", "latest", ""], min: "nope" }, zip });

		expect(compat.tidal).toEqual({ tested: ["2.48.0"], min: undefined });
	});
});

describe("parseCompat", () => {
	test("reads a file that says what it supports", () => {
		expect(parseCompat({ luna: "1.26.0", tidal: { tested: ["2.48.0"] }, zip }, "1.26.0")).toEqual({
			luna: "1.26.0",
			tidal: { tested: ["2.48.0"], min: undefined },
			zip,
		});
	});

	test("refuses a file about another release", () => {
		expect(parseCompat({ luna: "1.25.0", tidal: { tested: ["2.48.0"] }, zip }, "1.26.0")).toMatch(/is for "1\.25\.0"/);
	});

	test("refuses a file with no usable digest, since nothing could be checked against it", () => {
		expect(parseCompat({ luna: "1.26.0", tidal: { tested: ["2.48.0"] }, zip: { sha256: "nope", bytes: 1 } }, "1.26.0")).toMatch(/sha256/);
		expect(parseCompat({ luna: "1.26.0", tidal: { tested: ["2.48.0"] }, zip: { sha256: SHA, bytes: 0 } }, "1.26.0")).toMatch(/zip size/);
		expect(parseCompat({ luna: "1.26.0", tidal: { tested: ["2.48.0"] } }, "1.26.0")).toMatch(/no zip digest/);
	});

	test("accepts a file that makes no claims, which the resolver then treats as unknown", () => {
		// A release that does not know its compatibility is still a well formed one: refusing it here would make it
		// permanently uninstallable, where `compatVerdict` can say "unknown" and the caller can flag that
		expect(parseCompat({ luna: "1.26.0", tidal: {}, zip }, "1.26.0")).toEqual({
			luna: "1.26.0",
			tidal: { tested: undefined, min: undefined },
			zip,
		});
		expect(parseCompat({ luna: "1.26.0", tidal: { tested: [] }, zip }, "1.26.0")).toMatchObject({ tidal: { tested: undefined } });
	});

	test("refuses a file with nothing about TIDAL in it at all", () => {
		expect(parseCompat({ luna: "1.26.0", zip }, "1.26.0")).toMatch(/nothing about TIDAL/);
	});

	test("refuses what is not an object at all", () => {
		for (const raw of [undefined, null, "compat", 42, []]) expect(typeof parseCompat(raw, "1.26.0")).toBe("string");
	});

	test("ignores tested entries that are not versions", () => {
		expect(parseCompat({ luna: "1.26.0", tidal: { tested: ["2.48.0", "../evil"] }, zip }, "1.26.0")).toMatchObject({
			tidal: { tested: ["2.48.0"] },
		});
	});
});

describe("compatVerdict", () => {
	const compat = (tidal: { tested?: string[]; min?: string }) => buildCompat({ lunaVersion: "1.26.0", tidal, zip });

	test("a version it was run against is tested", () => {
		expect(compatVerdict(compat({ tested: ["2.48.0"] }), "2.48.0")).toBe("tested");
	});

	test("a version newer than the oldest it supports is at least within its claims", () => {
		expect(compatVerdict(compat({ min: "2.44.0" }), "2.48.0")).toBe("at-least-min");
	});

	test("a version outside the claims is unsupported, even when it is newer than another it was tested on", () => {
		expect(compatVerdict(compat({ tested: ["2.48.0"], min: "2.44.0" }), "2.40.0")).toBe("unsupported");
		// Tested somewhere else and no floor given: nothing says it works here
		expect(compatVerdict(compat({ tested: ["2.48.0"] }), "2.49.0")).toBe("unsupported");
	});

	test("no claims at all is unknown, not unsupported", () => {
		expect(compatVerdict(compat({ tested: [] }), "2.48.0")).toBe("unknown");
	});

	test("a TIDAL that could not be read for a version is unknown", () => {
		expect(compatVerdict(compat({ tested: ["2.48.0"] }), undefined)).toBe("unknown");
	});
});
