import { expect, test, vi } from "vitest";

// The server: url path > body, every request counted
const bodies = new Map<string, string>();
const requests: string[] = [];
(<{ location: unknown }>(<unknown>globalThis)).location = { href: "https://desktop.tidal.com/" };
(<{ fetch: typeof fetch }>(<unknown>globalThis)).fetch = async (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	requests.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname}`);
	const body = bodies.get(url.pathname);
	return body === undefined ? new Response("", { status: 404 }) : new Response(body, { headers: { "content-type": "application/json" } });
};
vi.useFakeTimers();
// SharedRequests captures `globalThis.fetch` when first imported, so the server above has to be in place before
const { sharedRequests } = await import("../caches");

const fail = async (): Promise<never> => {
	throw new Error("fetched");
};
const unloads = new Set<() => void>();
sharedRequests.register(unloads, { pattern: /\/v1\/pages\//, swr: true });
sharedRequests.register(unloads, { pattern: /\/v1\/tracks\// });
const changed: string[] = [];
sharedRequests.onChange(unloads, (key) => void changed.push(key));
const settle = () => vi.advanceTimersByTimeAsync(10);
const tick = (ms: number) => vi.advanceTimersByTime(ms);
const json = async (res: Response | Promise<Response>) => (await res).json();
const page = "https://api.tidal.com/v1/pages/album?albumId=123&countryCode=US";

test("swr: serves TIDAL's requests from the cache and re-fetches them in the background", async () => {
	bodies.set("/v1/pages/album", `{"v":1}`);
	expect(await json(fetch(page))).toEqual({ v: 1 });
	// Served without a request, desktop. and api. share entries
	const res = await fetch(page.replace("api.", "desktop."));
	expect(await res.json()).toEqual({ v: 1 });
	expect(res.url).toBe(page.replace("api.", "desktop."));
	expect(requests.length).toBe(1);
	// Luna's request() shares the entry
	expect(await sharedRequests.request(page, fail)).toEqual({ v: 1 });

	// Fresh: served without re-fetching
	tick(30_000);
	expect(await json(fetch(page))).toEqual({ v: 1 });
	await settle();
	expect(requests.length).toBe(1);

	// Stale and unchanged: served, re-fetched, no change
	tick(31_000);
	expect(await json(fetch(page))).toEqual({ v: 1 });
	await settle();
	expect(requests.length).toBe(2);
	expect(changed).toEqual([]);

	// Stale and changed: the old response is served, the new one reported and served next
	bodies.set("/v1/pages/album", `{"v":2}`);
	tick(61_000);
	expect(await json(fetch(page))).toEqual({ v: 1 });
	await settle();
	expect(changed).toEqual(["tidal-v1/v1/pages/album?albumId=123&countryCode=US"]);
	expect(await json(fetch(page))).toEqual({ v: 2 });
	expect(requests.length).toBe(3);

	// Days old is still served (and re-fetched)
	tick(7 * 24 * 60 * 60_000);
	expect(await json(fetch(page))).toEqual({ v: 2 });
	await settle();
	expect(requests.length).toBe(4);

	// cache: "no-store" isn't served
	await fetch(page, { cache: "no-store" });
	expect(requests.length).toBe(5);

	// Same json with keys in another order isn't a change
	changed.length = 0;
	bodies.set("/v1/pages/album", `{"v":2,"w":{"b":1,"a":2}}`);
	await fetch(page, { cache: "no-store" });
	bodies.set("/v1/pages/album", `{"w":{"a":2,"b":1},"v":2}`);
	tick(61_000);
	await fetch(page);
	await settle();
	expect(requests.length).toBe(7);
	expect(changed).toEqual([]);
});

test("a mutation drops entries mentioning the ids it changes", async () => {
	await sharedRequests.clear();
	requests.length = 0;
	const other = "https://desktop.tidal.com/v1/pages/mix?mixId=0019136b";
	bodies.set("/v1/pages/mix", `{}`);
	await fetch(page);
	await fetch(other);
	await fetch(page);
	expect(requests.length).toBe(2);
	await fetch("https://desktop.tidal.com/v1/users/1/favorites/albums?albumIds=1", { method: "POST" });
	await fetch("https://desktop.tidal.com/api/event-batch", { method: "POST" });
	await fetch(page);
	expect(requests.length, "nothing dropped").toBe(4);
	await fetch("https://openapi.tidal.com/v2/albums/123/relationships/items", { method: "DELETE" });
	await fetch(page);
	await fetch(other);
	expect(requests.slice(4)).toEqual(["DELETE /v2/albums/123/relationships/items", "GET /v1/pages/album"]);
	// Ids in the query
	await fetch("https://api.tidal.com/v2/favorites/mixes/remove?mixIds=0019136b", { method: "PUT" });
	await fetch(other);
	expect(requests.slice(6)).toEqual(["PUT /v2/favorites/mixes/remove", "GET /v1/pages/mix"]);
});

test("non-swr rules still only fill the cache", async () => {
	requests.length = 0;
	bodies.set("/v1/tracks/1", `{"id":1}`);
	const track = "https://desktop.tidal.com/v1/tracks/1?countryCode=US";
	await fetch(track);
	await fetch(track);
	expect(requests.length).toBe(2);
	expect(await sharedRequests.request(track, fail)).toEqual({ id: 1 });
	// 404s are cached as undefined
	expect(
		await sharedRequests.request("https://desktop.tidal.com/v1/tracks/2?countryCode=US", () =>
			fetch("https://desktop.tidal.com/v1/tracks/2?countryCode=US").then(() => undefined),
		),
	).toBeUndefined();
	// A response that doesn't parse is dropped rather than retried forever
	bodies.set("/v1/tracks/3", "not json");
	const broken = "https://desktop.tidal.com/v1/tracks/3?countryCode=US";
	await fetch(broken);
	expect(await sharedRequests.request(broken, async () => ({ id: 3 }))).toEqual({ id: 3 });
	await sharedRequests.clear();
	await sharedRequests.request(track, async () => ({ id: 1 }));
});

test("respond rules answer TIDAL from any fresh entry, without answering their own fetcher", async () => {
	sharedRequests.register(unloads, {
		pattern: /\/v1\/videos\/\d+\/playbackinfo/,
		maxAgeMs: 60_000,
		respond: (value, headers) => ({ ...(<object>value), session: headers.get("x-session") }),
	});
	requests.length = 0;
	bodies.set("/v1/videos/1/playbackinfo", `{"id":1}`);
	const info = "https://desktop.tidal.com/v1/videos/1/playbackinfo?q=HIGH";
	// Luna's fetcher goes through the hook to the network
	expect(await sharedRequests.request(info, () => fetch(info).then((res) => res.json()))).toEqual({ id: 1 });
	expect(requests.length).toBe(1);
	// TIDAL is answered from it with its own header
	const res = await fetch(info.replace("desktop.", "api."), { headers: { "x-session": "abc" } });
	expect(await res.json()).toEqual({ id: 1, session: "abc" });
	expect(requests.length).toBe(1);
	// Too old: fetched again, by both
	tick(61_000);
	await fetch(info, { headers: { "x-session": "def" } });
	expect(requests.length).toBe(2);
	tick(61_000);
	expect(await sharedRequests.request(info, () => fetch(info).then((res) => res.json()))).toEqual({ id: 1 });
	expect(requests.length).toBe(3);
	expect(sharedRequests.served > 0).toBe(true);
});

test("an swr rule's maxAgeMs caps how long it is served", async () => {
	await sharedRequests.clear();
	requests.length = 0;
	const mix = "https://api.tidal.com/v1/mixes/0019136b/items?countryCode=US";
	sharedRequests.register(unloads, { pattern: /\/v1\/mixes\//, swr: true, maxAgeMs: 30_000 });
	bodies.set("/v1/mixes/0019136b/items", `{}`);
	await fetch(mix);
	await fetch(mix);
	expect(requests.length).toBe(1);
	tick(31_000);
	await fetch(mix);
	expect(requests.length).toBe(2);
});

test("extraUrls answer other urls from the same entry", async () => {
	await sharedRequests.clear();
	sharedRequests.register(unloads, {
		pattern: /\/v1\/aliased\/main/,
		extraUrls: () => ["https://desktop.tidal.com/v1/aliased/other?q=2"],
	});
	expect(await sharedRequests.request("https://desktop.tidal.com/v1/aliased/main?q=1", async () => ({ id: 9 }))).toEqual({ id: 9 });
	await settle();
	expect(await sharedRequests.request("https://desktop.tidal.com/v1/aliased/other?q=2", fail)).toEqual({ id: 9 });
});

test("a rejected entry is dropped and fetched again", async () => {
	await sharedRequests.clear();
	const url = "https://desktop.tidal.com/v1/tracks/77?countryCode=US";
	await expect(sharedRequests.request(url, fail)).rejects.toThrow("fetched");
	await settle();
	expect(sharedRequests.has("tidal-v1/v1/tracks/77?countryCode=US")).toBe(false);
	expect(await sharedRequests.request(url, async () => ({ id: 77 }))).toEqual({ id: 77 });
});

test("stats count served and fetched requests, and the size of resolved entries", async () => {
	await sharedRequests.clear();
	await sharedRequests.request("https://desktop.tidal.com/v1/tracks/5?countryCode=US", async () => ({ id: 5 }));
	await settle();
	const stats = sharedRequests.stats();
	expect(stats.extra).toEqual({ served: sharedRequests.served, fetched: sharedRequests.fetched });
	expect(stats.extra!.fetched).toBeGreaterThan(0);
	// Sized once resolved: `{"id":5}` is 8 characters
	expect(stats.memory.dataBytes).toBe(8);
});
