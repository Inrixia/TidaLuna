import { describe, expect, test } from "vitest";

import { stringNotEmpty } from "./stringNotEmpty";

describe("stringNotEmpty", () => {
	test("is false for a field that was left out or left blank", () => {
		expect(stringNotEmpty(undefined)).toBe(false);
		expect(stringNotEmpty("")).toBe(false);
		expect(stringNotEmpty("   ")).toBe(false);
		expect(stringNotEmpty("\n\t")).toBe(false);
	});

	test("is true for anything with a character in it, spaces around it included", () => {
		expect(stringNotEmpty("cotton candy")).toBe(true);
		expect(stringNotEmpty("  padded  ")).toBe(true);
	});

	test("narrows the type, so a caller can use the value without a second check", () => {
		const name: string | undefined = "nightwave";
		if (!stringNotEmpty(name)) throw new Error("expected a name");
		expect(name.toUpperCase()).toBe("NIGHTWAVE");
	});
});
