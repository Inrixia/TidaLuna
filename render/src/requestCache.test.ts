// Run: pnpm exec tsx --test render/src/requestCache.test.ts
import assert from "node:assert/strict";
import { mock, test } from "node:test";

// The server: url path > body, every request counted
const bodies = new Map<string, string>();
const requests: string[] = [];
globalThis.location = <Location>{ href: "https://desktop.tidal.com/" };
globalThis.fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	requests.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname}`);
	const body = bodies.get(url.pathname);
	return body === undefined ? new Response("", { status: 404 }) : new Response(body, { headers: { "content-type": "application/json" } });
};
mock.timers.enable({ apis: ["Date"] });
const { requestCache } = await import("./requestCache");

const unloads = new Set<() => void>();
requestCache.register(unloads, { pattern: /\/v1\/pages\//, swr: true });
requestCache.register(unloads, { pattern: /\/v1\/tracks\// });
const changed: string[] = [];
requestCache.onChange(unloads, (url) => changed.push(url));
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const page = "https://api.tidal.com/v1/pages/album?albumId=123&countryCode=US";

test("swr: serves TIDAL's requests from the cache and re-fetches them in the background", async () => {
	bodies.set("/v1/pages/album", `{"v":1}`);
	assert.deepEqual(await (await fetch(page)).json(), { v: 1 });
	// Served without a request, desktop. and api. share entries
	const res = await fetch(page.replace("api.", "desktop."));
	assert.deepEqual(await res.json(), { v: 1 });
	assert.equal(res.url, page.replace("api.", "desktop."));
	assert.equal(requests.length, 1);
	// Luna's get() shares the entry
	assert.deepEqual(await requestCache.get(page, async () => assert.fail("fetched")), { v: 1 });

	// Stale and unchanged: served, re-fetched, no change
	mock.timers.tick(6_000);
	assert.deepEqual(await (await fetch(page)).json(), { v: 1 });
	await settle();
	assert.equal(requests.length, 2);
	assert.deepEqual(changed, []);

	// Stale and changed: the old response is served, the new one reported and served next
	bodies.set("/v1/pages/album", `{"v":2}`);
	mock.timers.tick(6_000);
	assert.deepEqual(await (await fetch(page)).json(), { v: 1 });
	await settle();
	assert.deepEqual(changed, [page]);
	assert.deepEqual(await (await fetch(page)).json(), { v: 2 });
	assert.equal(requests.length, 3);

	// Too old to serve
	mock.timers.tick(11 * 60_000);
	await fetch(page);
	assert.equal(requests.length, 4);
	// cache: "no-store" isn't served
	await fetch(page, { cache: "no-store" });
	assert.equal(requests.length, 5);

	// Same json with keys in another order isn't a change
	changed.length = 0;
	bodies.set("/v1/pages/album", `{"v":2,"w":{"b":1,"a":2}}`);
	await fetch(page, { cache: "no-store" });
	bodies.set("/v1/pages/album", `{"w":{"a":2,"b":1},"v":2}`);
	mock.timers.tick(6_000);
	await fetch(page);
	await settle();
	assert.equal(requests.length, 7);
	assert.deepEqual(changed, []);
});

test("a mutation drops entries mentioning the ids it changes", async () => {
	requestCache.clear();
	requests.length = 0;
	const other = "https://desktop.tidal.com/v1/pages/mix?mixId=0019136b";
	bodies.set("/v1/pages/mix", `{}`);
	await fetch(page);
	await fetch(other);
	await fetch(page);
	assert.equal(requests.length, 2);
	await fetch("https://desktop.tidal.com/v1/users/1/favorites/albums?albumIds=1", { method: "POST" });
	await fetch("https://desktop.tidal.com/api/event-batch", { method: "POST" });
	await fetch(page);
	assert.equal(requests.length, 4, "nothing dropped");
	await fetch("https://openapi.tidal.com/v2/albums/123/relationships/items", { method: "DELETE" });
	await fetch(page);
	await fetch(other);
	assert.deepEqual(requests.slice(4), ["DELETE /v2/albums/123/relationships/items", "GET /v1/pages/album"]);
	// Ids in the query
	await fetch("https://api.tidal.com/v2/favorites/mixes/remove?mixIds=0019136b", { method: "PUT" });
	await fetch(other);
	assert.deepEqual(requests.slice(6), ["PUT /v2/favorites/mixes/remove", "GET /v1/pages/mix"]);
});

test("non-swr rules still only fill the cache", async () => {
	requests.length = 0;
	bodies.set("/v1/tracks/1", `{"id":1}`);
	const track = "https://desktop.tidal.com/v1/tracks/1?countryCode=US";
	await fetch(track);
	await fetch(track);
	assert.equal(requests.length, 2);
	assert.deepEqual(await requestCache.get(track, async () => assert.fail("fetched")), { id: 1 });
	// 404s are cached as undefined
	assert.equal(
		await requestCache.get("https://desktop.tidal.com/v1/tracks/2?countryCode=US", () =>
			fetch("https://desktop.tidal.com/v1/tracks/2?countryCode=US").then(() => undefined),
		),
		undefined,
	);
	// A response that doesn't parse is dropped rather than retried forever
	bodies.set("/v1/tracks/3", "not json");
	const broken = "https://desktop.tidal.com/v1/tracks/3?countryCode=US";
	await fetch(broken);
	assert.deepEqual(await requestCache.get(broken, async () => ({ id: 3 })), { id: 3 });
	requestCache.clear();
	await requestCache.get(track, async () => ({ id: 1 }));
});
