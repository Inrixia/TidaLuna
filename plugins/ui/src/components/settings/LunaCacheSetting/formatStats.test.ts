import { describe, expect, it } from "vitest";

import { formatExtra, hitRate, keyTitle, labelOf, percentOf } from "./formatStats";

describe("formatStats", () => {
	it("labels camelCase keys", () => expect(labelOf("evictedBytes")).toBe("Evicted bytes"));
	it("strips the native prefix", () => expect(keyTitle("native:audioStreams")).toBe("Audio streams"));
	it("formats Bytes extras as bytes and others as counts", () => {
		expect(formatExtra("heldBytes", 2 * 1024 ** 2)).toBe("2.0 MB");
		expect(formatExtra("pending", 1234)).toBe((1234).toLocaleString());
	});
	it("computes hit rate", () => {
		expect(hitRate(0, 0)).toBe("-");
		expect(hitRate(3, 1)).toBe("75%");
	});
	it("clamps percent and ignores infinite limits", () => {
		expect(percentOf(50, 100)).toBe(50);
		expect(percentOf(500, 100)).toBe(100);
		expect(percentOf(5, Infinity)).toBe(0);
	});
});
