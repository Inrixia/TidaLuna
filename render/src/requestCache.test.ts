import { afterAll, expect, test, vi } from "vitest";

// The server: url path > body, every request counted
const bodies = new Map<string, string>();
const requests: string[] = [];

// Only the clock is faked: the module stamps entries with Date, and the settle() wait below needs real timers
vi.useFakeTimers({ toFake: ["Date"] });
vi.stubGlobal("location", <Location>{ href: "https://desktop.tidal.com/" });
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	requests.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname}`);
	const body = bodies.get(url.pathname);
	return body === undefined ? new Response("", { status: 404 }) : new Response(body, { headers: { "content-type": "application/json" } });
});

const { requestCache } = await import("./requestCache");

const unloads = new Set<() => void>();
requestCache.register(unloads, { pattern: /\/v1\/pages\//, swr: true });
requestCache.register(unloads, { pattern: /\/v1\/tracks\// });
const changed: string[] = [];
requestCache.onChange(unloads, (url) => changed.push(url));
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const page = "https://api.tidal.com/v1/pages/album?albumId=123&countryCode=US";
const unreachable = () => {
	throw new Error("the cache should have answered this");
};

afterAll(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("swr: serves TIDAL's requests from the cache and re-fetches them in the background", async () => {
	bodies.set("/v1/pages/album", `{"v":1}`);
	expect(await (await fetch(page)).json()).toEqual({ v: 1 });
	// Served without a request, desktop. and api. share entries
	const res = await fetch(page.replace("api.", "desktop."));
	expect(await res.json()).toEqual({ v: 1 });
	expect(res.url).toBe(page.replace("api.", "desktop."));
	expect(requests.length).toBe(1);
	// Luna's get() shares the entry
	expect(await requestCache.get(page, async () => unreachable())).toEqual({ v: 1 });

	// Fresh: served without re-fetching
	vi.advanceTimersByTime(30_000);
	expect(await (await fetch(page)).json()).toEqual({ v: 1 });
	await settle();
	expect(requests.length).toBe(1);

	// Stale and unchanged: served, re-fetched, no change
	vi.advanceTimersByTime(31_000);
	expect(await (await fetch(page)).json()).toEqual({ v: 1 });
	await settle();
	expect(requests.length).toBe(2);
	expect(changed).toEqual([]);

	// Stale and changed: the old response is served, the new one reported and served next
	bodies.set("/v1/pages/album", `{"v":2}`);
	vi.advanceTimersByTime(61_000);
	expect(await (await fetch(page)).json()).toEqual({ v: 1 });
	await settle();
	expect(changed).toEqual([page]);
	expect(await (await fetch(page)).json()).toEqual({ v: 2 });
	expect(requests.length).toBe(3);

	// Days old is still served (and re-fetched)
	vi.advanceTimersByTime(7 * 24 * 60 * 60_000);
	expect(await (await fetch(page)).json()).toEqual({ v: 2 });
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
	vi.advanceTimersByTime(61_000);
	await fetch(page);
	await settle();
	expect(requests.length).toBe(7);
	expect(changed).toEqual([]);
});

test("a mutation drops entries mentioning the ids it changes", async () => {
	requestCache.clear();
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
	expect(await requestCache.get(track, async () => unreachable())).toEqual({ id: 1 });
	// 404s are cached as undefined
	expect(
		await requestCache.get("https://desktop.tidal.com/v1/tracks/2?countryCode=US", () =>
			fetch("https://desktop.tidal.com/v1/tracks/2?countryCode=US").then(() => undefined),
		),
	).toBe(undefined);
	// A response that doesn't parse is dropped rather than retried forever
	bodies.set("/v1/tracks/3", "not json");
	const broken = "https://desktop.tidal.com/v1/tracks/3?countryCode=US";
	await fetch(broken);
	expect(await requestCache.get(broken, async () => ({ id: 3 }))).toEqual({ id: 3 });
	requestCache.clear();
	await requestCache.get(track, async () => ({ id: 1 }));
});

test("respond rules answer TIDAL from any fresh entry, without answering their own fetcher", async () => {
	requestCache.register(unloads, {
		pattern: /\/v1\/videos\/\d+\/playbackinfo/,
		maxAgeMs: 60_000,
		respond: (value, headers) => ({ ...(<object>value), session: headers.get("x-session") }),
	});
	requests.length = 0;
	bodies.set("/v1/videos/1/playbackinfo", `{"id":1}`);
	const info = "https://desktop.tidal.com/v1/videos/1/playbackinfo?q=HIGH";
	// Luna's fetcher goes through the hook to the network
	expect(await requestCache.get(info, () => fetch(info).then((res) => res.json()))).toEqual({ id: 1 });
	expect(requests.length).toBe(1);
	// TIDAL is answered from it with its own header
	const res = await fetch(info.replace("desktop.", "api."), { headers: { "x-session": "abc" } });
	expect(await res.json()).toEqual({ id: 1, session: "abc" });
	expect(requests.length).toBe(1);
	// Too old: fetched again, by both
	vi.advanceTimersByTime(61_000);
	await fetch(info, { headers: { "x-session": "def" } });
	expect(requests.length).toBe(2);
	vi.advanceTimersByTime(61_000);
	expect(await requestCache.get(info, () => fetch(info).then((res) => res.json()))).toEqual({ id: 1 });
	expect(requests.length).toBe(3);
	expect(requestCache.stats().served > 0).toBe(true);
});

test("an swr rule's maxAgeMs caps how long it is served", async () => {
	requestCache.clear();
	requests.length = 0;
	const mix = "https://api.tidal.com/v1/mixes/0019136b/items?countryCode=US";
	requestCache.register(unloads, { pattern: /\/v1\/mixes\//, swr: true, maxAgeMs: 30_000 });
	bodies.set("/v1/mixes/0019136b/items", `{}`);
	await fetch(mix);
	await fetch(mix);
	expect(requests.length).toBe(1);
	vi.advanceTimersByTime(31_000);
	await fetch(mix);
	expect(requests.length).toBe(2);
});
