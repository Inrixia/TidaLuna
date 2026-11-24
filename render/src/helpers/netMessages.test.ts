import { describe, expect, it } from "vitest";

import { toNetRequest, toResponse } from "./netMessages";

describe("luna.fetch messages", () => {
	it("sends what fetch takes as a plain request", async () => {
		expect(await toNetRequest("https://a.com/x", { headers: { "x-key": "1" } })).toEqual({
			url: "https://a.com/x",
			method: "GET",
			headers: { "x-key": "1" },
			body: undefined,
		});
		const post = await toNetRequest(new URL("https://a.com/p"), {
			method: "POST",
			body: JSON.stringify({ a: 1 }),
			headers: { "content-type": "text/plain;charset=UTF-8" },
		});
		expect(post.method).toBe("POST");
		expect(new TextDecoder().decode(post.body as Uint8Array)).toBe('{"a":1}');
		expect(post.headers?.["content-type"]).toBe("text/plain;charset=UTF-8");
	});

	it("gives the answer back as a Response", async () => {
		const res = toResponse({
			status: 200,
			statusText: "OK",
			url: "https://a.com/final",
			redirected: true,
			headers: [["content-type", "application/json"]],
			body: new TextEncoder().encode('{"ok":true}'),
		});
		expect(await res.json()).toEqual({ ok: true });
		expect(res.url).toBe("https://a.com/final");
		expect(res.redirected).toBe(true);
		expect(toResponse({ status: 204, statusText: "", url: "https://a.com/", redirected: false, headers: [], body: new Uint8Array() }).status).toBe(
			204,
		);
	});
});
