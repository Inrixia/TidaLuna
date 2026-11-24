import { afterEach, describe, expect, test, vi } from "vitest";

import * as ftch from "./fetch";

afterEach(() => vi.unstubAllGlobals());

describe("ftch", () => {
	test("json and text read an ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(`{"a":1}`)),
		);
		await expect(ftch.json("https://x/ok")).resolves.toEqual({ a: 1 });
		await expect(ftch.text("https://x/ok")).resolves.toBe(`{"a":1}`);
	});

	test("json and text reject a response that is not ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(`{"error":"x"}`, { status: 500, statusText: "Server Error" })),
		);
		// The body parses fine: only the status makes it a failure
		await expect(ftch.json("https://x/bad")).rejects.toThrow();
		await expect(ftch.text("https://x/bad")).rejects.toThrow();
	});

	test("passes its arguments to fetch unchanged", async () => {
		const fetch = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", fetch);
		const init = { method: "POST", body: "x" };
		await ftch.json("https://x/post", init);
		await ftch.text("https://x/post", init);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenNthCalledWith(1, "https://x/post", init);
		expect(fetch).toHaveBeenNthCalledWith(2, "https://x/post", init);
	});
});
