import { describe, expect, test } from "vitest";

import { humanizeFileName } from "./humanizeFileName";

describe("humanizeFileName", () => {
	test("turns a file name into a title", () => {
		expect(humanizeFileName("base-windows.css")).toBe("Base Windows");
		expect(humanizeFileName("cottoncandy.css")).toBe("Cottoncandy");
		expect(humanizeFileName("tech_round_pack.woff2")).toBe("Tech Round Pack");
	});

	test("separates words at the characters a file name uses for that", () => {
		expect(humanizeFileName("pride+collection.css")).toBe("Pride Collection");
		expect(humanizeFileName("sour-rainbow__strips.css")).toBe("Sour Rainbow Strips");
	});

	test("decodes nothing and keeps a name that is already a title", () => {
		expect(humanizeFileName("Nightwave.css")).toBe("Nightwave");
	});

	test("is empty when there is no name left to read", () => {
		expect(humanizeFileName(".css")).toBe("");
		expect(humanizeFileName("")).toBe("");
	});
});
