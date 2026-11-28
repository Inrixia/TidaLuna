import { describe, expect, test } from "vitest";

import { fileExtension, urlFileName, urlHost } from "./url";

describe("urlHost", () => {
	test("is the host of an absolute url", () => {
		expect(urlHost("https://raw.githubusercontent.com/a/b/main/c.css")).toBe("raw.githubusercontent.com");
	});

	test("is undefined when the url cannot be parsed", () => {
		expect(urlHost("not a url")).toBeUndefined();
		expect(urlHost("")).toBeUndefined();
	});
});

describe("urlFileName", () => {
	test("is the last path segment, which is the part that names the file", () => {
		expect(urlFileName("https://tidaluna.dev/nightwave.css")).toBe("nightwave.css");
		expect(urlFileName("https://raw.githubusercontent.com/a/b/refs/heads/main/fonts/tech/Dream.woff2")).toBe("Dream.woff2");
	});

	test("decodes an encoded name", () => {
		expect(urlFileName("https://raw.githubusercontent.com/a/b/main/pride%20collection/sourrainbowstrips.css")).toBe("sourrainbowstrips.css");
	});

	test("is undefined for a host root and for a url that cannot be parsed", () => {
		expect(urlFileName("https://themes.example.com/")).toBeUndefined();
		expect(urlFileName("not a url")).toBeUndefined();
	});
});

describe("fileExtension", () => {
	test("is the lowercased extension of the last segment", () => {
		expect(fileExtension("https://t.example.com/theme.css")).toBe(".css");
		expect(fileExtension("/fonts/Tech.woff2")).toBe(".woff2");
		expect(fileExtension("IMAGE.PNG")).toBe(".png");
	});

	test("ignores the query and the fragment", () => {
		expect(fileExtension("https://t.example.com/theme.css?v=2")).toBe(".css");
		expect(fileExtension("https://t.example.com/theme.css#top")).toBe(".css");
		expect(fileExtension("https://t.example.com/font.woff2?v=1#x")).toBe(".woff2");
	});

	test("is empty when the segment has no dot, and for an empty path", () => {
		expect(fileExtension("https://t.example.com/theme")).toBe("");
		expect(fileExtension("")).toBe("");
		expect(fileExtension("https://t.example.com/dir.v2/theme")).toBe("");
	});
});
