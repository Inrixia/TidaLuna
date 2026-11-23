import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toNetRequest, toResponse } from "./netMessages";

describe("luna.fetch messages", () => {
	it("sends what fetch takes as a plain request", async () => {
		assert.deepEqual(await toNetRequest("https://a.com/x", { headers: { "X-Key": "1" } }), {
			url: "https://a.com/x",
			method: "GET",
			headers: { "x-key": "1" },
			body: undefined,
		});
		const post = await toNetRequest(new URL("https://a.com/p"), { method: "POST", body: JSON.stringify({ a: 1 }) });
		assert.equal(post.method, "POST");
		assert.equal(new TextDecoder().decode(post.body as Uint8Array), '{"a":1}');
		assert.equal(post.headers?.["content-type"], "text/plain;charset=UTF-8");
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
		assert.deepEqual(await res.json(), { ok: true });
		assert.equal(res.url, "https://a.com/final");
		assert.equal(res.redirected, true);
		assert.equal(
			toResponse({ status: 204, statusText: "", url: "https://a.com/", redirected: false, headers: [], body: new Uint8Array() }).status,
			204,
		);
	});
});
