import { describe, expect, it } from "vitest";

import { estimateMemory } from "./estimateMemory";
import { WeakRefs } from "./WeakRefs";

describe("estimateMemory", () => {
	it("grows with string length and binary size", () => {
		expect(estimateMemory("abcd")).toBeGreaterThan(estimateMemory("a"));
		expect(estimateMemory(new Uint8Array(1000))).toBeGreaterThanOrEqual(1000);
		expect(estimateMemory(undefined)).toBe(0);
	});

	it("walks objects, arrays, maps and sets", () => {
		const nested = { a: "x".repeat(100), list: [1, 2, 3], map: new Map([["k", "v"]]), set: new Set(["s"]) };
		expect(estimateMemory(nested)).toBeGreaterThan(estimateMemory("x".repeat(100)) + estimateMemory([1, 2, 3]));
	});

	it("counts a shared or cyclic object once", () => {
		const shared = { text: "y".repeat(1000) };
		const cyclic: Record<string, unknown> = { shared };
		cyclic.self = cyclic;
		expect(estimateMemory({ one: shared, two: shared })).toBeLessThan(2 * estimateMemory(shared));
		expect(estimateMemory(cyclic)).toBeGreaterThan(estimateMemory(shared));
	});
});

describe("WeakRefs", () => {
	it("gives back the object set under a key while it lives", () => {
		const refs = new WeakRefs<{ id: number }>();
		const item = refs.set("a", { id: 1 });
		expect(refs.get("a")).toBe(item);
		expect(refs.size).toBe(1);
		refs.delete("a");
		expect(refs.get("a")).toBeUndefined();
	});
});
