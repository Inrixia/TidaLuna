import path from "node:path";
import { describe, expect, test } from "vitest";

import { isInside } from "./isInside";

describe("isInside", () => {
	const dir = path.resolve("resources", "app");

	test.each([
		["a file in the dir", path.join(dir, "luna.mjs"), true],
		["a file in a subdirectory", path.join(dir, "sub", "file.css"), true],
		["the dir itself", dir, true],
		["a sibling whose name starts with the dir's name", path.join(dir, "..foo"), true],
		["a parent directory", path.join(dir, ".."), false],
		["a sibling directory", path.join(dir, "..", "app-old", "x"), false],
		["a sibling with the dir name as prefix", path.join(dir + "-old", "x"), false],
	])("returns %s", (_name, target, expected) => {
		expect(isInside(dir, target)).toBe(expected);
	});

	test("a directory that only shares a prefix with dir is outside it", () => {
		expect(isInside("/a/b", "/a/bc")).toBe(false);
		expect(isInside("/a/b", "/a/b/c")).toBe(true);
	});
});
