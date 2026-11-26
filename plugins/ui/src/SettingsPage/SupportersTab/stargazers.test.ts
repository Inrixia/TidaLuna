import { describe, expect, test, vi } from "vitest";

import { loadStarCount, parseStarCount } from "./stargazers";

describe("parseStarCount", () => {
	test("reads the count a repo response carries", () => {
		expect(parseStarCount({ stargazers_count: 623 })).toBe(623);
		expect(parseStarCount({ stargazers_count: 0 })).toBe(0);
		// Other repo fields don't matter
		expect(parseStarCount({ name: "TidaLuna", stargazers_count: 12, forks: 3 })).toBe(12);
	});

	test("is undefined when the response has no usable count", () => {
		expect(parseStarCount({})).toBeUndefined();
		expect(parseStarCount({ stargazers_count: "623" })).toBeUndefined();
		expect(parseStarCount({ stargazers_count: -1 })).toBeUndefined();
		expect(parseStarCount({ stargazers_count: 1.5 })).toBeUndefined();
		expect(parseStarCount({ stargazers_count: null })).toBeUndefined();
		expect(parseStarCount(undefined)).toBeUndefined();
		expect(parseStarCount(null)).toBeUndefined();
		expect(parseStarCount("623")).toBeUndefined();
	});
});

describe("loadStarCount", () => {
	test("asks the public repo endpoint and returns the count", async () => {
		const fetchJson = vi.fn(async () => ({ stargazers_count: 623 }));

		await expect(loadStarCount(fetchJson)).resolves.toBe(623);
		expect(fetchJson).toHaveBeenCalledWith("https://api.github.com/repos/Inrixia/TidaLuna");
	});

	test("is undefined instead of throwing when the request fails", async () => {
		// Rate limited, offline or a 401: the tab says so rather than breaking the settings page
		const rejected = vi.fn(async () => {
			throw new Error("401 Requires authentication");
		});
		await expect(loadStarCount(rejected)).resolves.toBeUndefined();

		const offline = vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		});
		await expect(loadStarCount(offline)).resolves.toBeUndefined();
	});

	test("is undefined when the response is not a repo object", async () => {
		await expect(loadStarCount(vi.fn(async () => undefined))).resolves.toBeUndefined();
		await expect(loadStarCount(vi.fn(async () => ({ message: "Not Found" })))).resolves.toBeUndefined();
	});
});
