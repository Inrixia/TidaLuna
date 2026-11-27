import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

import { Cache, CacheStore, MapBackend } from "../../cache";
import { FsBackend } from "../cache/FsBackend";
import { OfflineResponses, type OfflineCache, type OfflineMeta } from "./OfflineResponses";

/**
 * `OfflineResponses` keeps the last good GET response in a Cache of files and hands it back when the network fails, so TIDAL
 * never notices it is offline. `staleIfError` takes the fetch function, so nothing here touches the network.
 *
 * Every test builds a cache (memory + a FsBackend in a fresh temp dir) and gives the code its own `globalThis.luna` to report offline
 * state to. Keeping a response is fire-and-forget (the page reads the other branch of the tee), so tests that expect a kept entry
 * wait for the cache instead of sleeping.
 */

let cacheId = 0;
let tmp: string;
let dataDir: string;
let cache: OfflineCache;
let offline: OfflineResponses;
let sendToRender: ReturnType<typeof vi.fn>;
let warn: MockInstance;
let errorLog: MockInstance;

const makeCache = (dir: string): OfflineCache =>
	Cache.from(`offline-test-${++cacheId}`, () => ({
		memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<Uint8Array>() }),
		persist: new CacheStore({ meta: new MapBackend(), data: new FsBackend<OfflineMeta>(dir) }),
	}));

const staleIfError = (...args: Parameters<OfflineResponses["staleIfError"]>) => offline.staleIfError(...args);
const dataFiles = () => readdir(dataDir).catch(() => []);
/** Resolves once `count` responses are kept */
const waitForKept = (count = 1) => vi.waitFor(() => expect(cache.persistStore.size).toBe(count), { timeout: 5000 });
const keptMeta = () => cache.meta([...cache.keys()][0])!;

/** A fetch that hands out a fresh response per call (a Response body can only be read once) */
const serving = (make: () => Response) => vi.fn(async () => make());
/** The page always reads its body, so do the same and let keep() have the other branch of the tee */
const keepOnline = async (url: string, make: () => Response, req?: Request) => {
	const res = await staleIfError(url, serving(make), req);
	await res.text();
};
const failing = (err: unknown = new TypeError("fetch failed")) =>
	vi.fn(async (): Promise<Response> => {
		throw err;
	});

const jsonOf = (body: unknown, init: { status?: number; statusText?: string; headers?: Record<string, string> } = {}) =>
	new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		statusText: init.statusText ?? "OK",
		headers: { "content-type": "application/json", ...init.headers },
	});

/** A throwaway JWT: only the payload matters, OfflineResponses reads `uid` from it */
const jwt = (payload: Record<string, unknown>) =>
	["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify(payload)).toString("base64url"), "c2lnbmF0dXJl"].join(".");
const asAccount = (url: string, uid: number) => new Request(url, { headers: { authorization: `Bearer ${jwt({ uid })}` } });

const expectRecentDate = (res: Response) => {
	const date = res.headers.get("date");
	expect(date).not.toBeNull();
	expect(Math.abs(Date.parse(date ?? "") - Date.now())).toBeLessThan(60_000);
};

describe("OfflineResponses staleIfError", () => {
	beforeEach(async () => {
		tmp = await mkdtemp(path.join(os.tmpdir(), "luna-offline-"));
		dataDir = path.join(tmp, "data");
		cache = makeCache(dataDir);
		offline = new OfflineResponses(cache);
		sendToRender = vi.fn();
		(globalThis as any).luna = { sendToRender };
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		warn.mockRestore();
		errorLog.mockRestore();
		await rm(tmp, { recursive: true, force: true });
	});

	afterAll(() => {
		(globalThis as any).luna = {};
	});

	describe("entries are keyed by url and account", () => {
		test("api.tidal.com and desktop.tidal.com share one /v1 entry, query order aside", async () => {
			await keepOnline("https://api.tidal.com/v1/tracks?country=US&limit=10", () => jsonOf({ items: [{ id: 1 }] }));
			await waitForKept();

			// Same request as Luna makes it: the other host, the other query order
			const replayed = await staleIfError("https://desktop.tidal.com/v1/tracks?limit=10&country=US", failing());
			expect(replayed.status).toBe(200);
			expect(await replayed.json()).toEqual({ items: [{ id: 1 }] });
		});

		test("/v1/ and /v2/ paths are shared between the two api hosts", async () => {
			await keepOnline("https://api.tidal.com/v2/tracks?limit=1", () => jsonOf({ version: 2 }));
			await waitForKept();

			// Both api hosts share one key for /v1/ and /v2/, see native/tidalHosts.ts
			const shared = await staleIfError("https://desktop.tidal.com/v2/tracks?limit=1", failing());
			expect(shared.status).toBe(200);
			expect(await shared.json()).toEqual({ version: 2 });
		});

		test("cdn urls are keyed by their exact url, query order included", async () => {
			const url = "https://cdn.example.com/img/cover.jpg?size=640&fmt=webp";
			await keepOnline(url, () => jsonOf({ ok: true }, { headers: { "content-type": "image/jpeg" } }));
			await waitForKept();

			const replayed = await staleIfError(url, failing());
			expect(replayed.status).toBe(200);
			expect(replayed.headers.get("content-type")).toBe("image/jpeg");

			// Same path with the query in another order is another url: no kept copy, so the error surfaces
			await expect(staleIfError("https://cdn.example.com/img/cover.jpg?fmt=webp&size=640", failing())).rejects.toThrow("fetch failed");
			// Same for another host
			await expect(staleIfError("https://other.example.com/img/cover.jpg?size=640&fmt=webp", failing())).rejects.toThrow("fetch failed");
		});
	});

	describe("keeping a good response", () => {
		test("a 200 json GET is fetched every time, kept or not", async () => {
			const url = "https://api.tidal.com/v1/tracks/1";
			const first = serving(() => jsonOf({ id: 1 }));
			expect(await (await staleIfError(url, first)).json()).toEqual({ id: 1 });
			expect(first).toHaveBeenCalledOnce();
			await waitForKept();
			const before = keptMeta().sha256;

			// Online it is not a read-through cache: the page gets the network's body
			const second = serving(() => jsonOf({ id: 1, fresh: true }));
			expect(await (await staleIfError(url, second)).json()).toEqual({ id: 1, fresh: true });
			expect(second).toHaveBeenCalledOnce();
			await vi.waitFor(() => expect(keptMeta().sha256).not.toBe(before), { timeout: 5000 });
		});

		test("the body is a file named by a hash of the key, its headers and sha256 are in the meta", async () => {
			await keepOnline("https://api.tidal.com/v1/tracks/1", () => jsonOf({ id: 1 }));
			await waitForKept();

			const meta = keptMeta();
			expect(meta.path).toMatch(/^[0-9a-f]{40}$/);
			expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(meta.headers).toEqual([["content-type", "application/json"]]);
			expect(await dataFiles()).toEqual([meta.path]);
		});

		test("when the network fails the kept response is replayed, transfer headers dropped", async () => {
			const url = "https://api.tidal.com/v1/tracks/1";
			const headers = {
				"content-type": "application/json",
				"content-length": "999",
				"content-encoding": "gzip",
				"set-cookie": "tidal=1",
				"transfer-encoding": "chunked",
				date: "Thu, 01 Jan 2000 00:00:00 GMT",
				"x-kept": "kept",
			};
			await keepOnline(url, () => jsonOf({ id: 1 }, { statusText: "OK", headers }));
			await waitForKept();

			const replayed = await staleIfError(url, failing());
			expect(replayed.status).toBe(200);
			expect(await replayed.json()).toEqual({ id: 1 });
			expect(replayed.headers.get("content-type")).toBe("application/json");
			// Only the content type and CORS headers are kept
			expect(replayed.headers.get("x-kept")).toBeNull();
			// The header TIDAL's trueTime asks for is the time now, not the time of the kept response
			expectRecentDate(replayed);
			for (const dropped of ["content-length", "content-encoding", "set-cookie", "transfer-encoding"])
				expect(replayed.headers.get(dropped)).toBeNull();
		});

		test("an unchanged body only marks the kept copy as seen", async () => {
			const url = "https://api.tidal.com/v1/tracks/1";
			const body = { id: 1, title: "kept" };
			await keepOnline(url, () => jsonOf(body));
			await waitForKept();
			const writes = cache.persistStore.dataBackend.stats().writes;
			const last = keptMeta().last;
			await new Promise((resolve) => setTimeout(resolve, 5));

			await keepOnline(url, () => jsonOf(body));
			// The sha256 matched, so keep() only counts a read
			await vi.waitFor(() => expect(keptMeta().last).toBeGreaterThan(last), { timeout: 5000 });
			expect(cache.persistStore.dataBackend.stats().writes).toBe(writes);

			// And the copy that is replayed is still the good one
			expect(await (await staleIfError(url, failing())).json()).toEqual(body);
		});

		test("a changed body replaces the kept copy", async () => {
			const url = "https://api.tidal.com/v1/tracks/1";
			await keepOnline(url, () => jsonOf({ id: 1, title: "old" }));
			await waitForKept();
			const before = keptMeta().sha256;

			await keepOnline(url, () => jsonOf({ id: 1, title: "new" }));
			await vi.waitFor(() => expect(keptMeta().sha256).not.toBe(before), { timeout: 5000 });
			// Same key, so it replaced the entry instead of adding one
			expect(cache.persistStore.size).toBe(1);
			expect(await dataFiles()).toHaveLength(1);
			expect(await (await staleIfError(url, failing())).json()).toEqual({ id: 1, title: "new" });
		});

		test("a failed keep does not break the response the page gets", async () => {
			// A file where the cache directory should be: writing fails, keep() rejects
			await rm(dataDir, { recursive: true });
			await writeFile(dataDir, "not a directory");
			const res = await staleIfError(
				"https://api.tidal.com/v1/tracks/1",
				serving(() => jsonOf({ id: 1 })),
			);
			expect(await res.json()).toEqual({ id: 1 });
			// The write fails in the data backend, the cache logs it (Cache / CacheStore loggers) and the page never sees it
			await vi.waitFor(() => expect(cache.persistStore.dataBackend.stats().errors).toBeGreaterThan(0), { timeout: 5000 });
		});

		test("files no meta names are deleted when the cache is loaded", async () => {
			const dir = path.join(tmp, "stray");
			await mkdir(dir);
			await writeFile(path.join(dir, "stray"), "x");
			const strayCache = makeCache(dir);
			new OfflineResponses(strayCache);
			await strayCache.ready;
			await vi.waitFor(async () => expect(await readdir(dir)).toEqual([]), { timeout: 5000 });
		});
	});

	describe("being offline", () => {
		test("reports going offline and coming back online to the page", async () => {
			const miss = await staleIfError("https://api.tidal.com/v1/tracks/1", failing());
			expect(miss.status).toBe(404);
			expect(sendToRender).toHaveBeenCalledWith("__Luna.offlineStatus", true);

			const online = await staleIfError(
				"https://api.tidal.com/v1/tracks/2",
				serving(() => jsonOf({ id: 2 })),
			);
			expect(await online.json()).toEqual({ id: 2 });
			expect(sendToRender).toHaveBeenCalledWith("__Luna.offlineStatus", false);
			await waitForKept();
		});

		test("/v1/ping is answered as 200 OK text so TIDAL counts itself online", async () => {
			const ping = await staleIfError("https://api.tidal.com/v1/ping", failing());
			expect(ping.status).toBe(200);
			expect(ping.headers.get("content-type")).toBe("text/plain");
			expect(await ping.text()).toBe("OK");
			expectRecentDate(ping);
			expect(await dataFiles()).toHaveLength(0);
		});

		test("/v1/ping is answered as OK even when a good ping was kept", async () => {
			await keepOnline("https://api.tidal.com/v1/ping", () => jsonOf({ status: "ok" }));
			await waitForKept();

			expect(await (await staleIfError("https://api.tidal.com/v1/ping", failing())).text()).toBe("OK");
		});

		test("an api request with nothing kept is a 404 miss the page can report", async () => {
			const url = "https://api.tidal.com/v1/tracks/42";
			const miss = await staleIfError(url, failing());
			expect(miss.status).toBe(404);
			expect(miss.statusText).toBe("Not Found (Offline Cache Miss)");
			expect(miss.headers.get("x-luna-offline-miss")).toBe("1");
			expect(miss.headers.get("content-type")).toBe("application/json");
			expectRecentDate(miss);
			expect(await miss.json()).toEqual({ status: 404, userMessage: "Offline: not in cache", errors: [{ detail: "Offline: not in cache" }] });
			expect(sendToRender).toHaveBeenCalledWith("__Luna.offlineMiss", url);
			expect(await dataFiles()).toHaveLength(0);
		});

		test("a missing app script on a TIDAL host is reported and the error rethrown", async () => {
			const url = "https://listen.tidal.com/app/main.js";
			const err = new Error("net::ERR_INTERNET_DISCONNECTED");
			await expect(staleIfError(url, failing(err))).rejects.toThrow(err);
			expect(sendToRender).toHaveBeenCalledWith("__Luna.offlineMiss", url);
		});

		test("a non-tidal host failing is just an error: no kept copy, no offline report", async () => {
			await expect(staleIfError("https://cdn.example.com/img/cover.jpg", failing())).rejects.toThrow("fetch failed");
			expect(sendToRender).not.toHaveBeenCalled();
			await expect(staleIfError("https://luna/local.json", failing())).rejects.toThrow("fetch failed");
		});

		test("an aborted request rethrows instead of being served the kept copy", async () => {
			const url = "https://api.tidal.com/v1/tracks/1";
			await keepOnline(url, () => jsonOf({ id: 1 }));
			await waitForKept();
			warn.mockClear();
			sendToRender.mockClear();

			const controller = new AbortController();
			controller.abort();
			const signal = controller.signal;
			const abortError = new DOMException("The operation was aborted.", "AbortError");
			await expect(staleIfError(url, failing(abortError), new Request(url, { signal }))).rejects.toThrow("aborted");
			// Neither a replay nor an offline report: the page asked for this one to stop
			expect(warn).not.toHaveBeenCalled();
			expect(sendToRender).not.toHaveBeenCalled();
			// /v1/ping does not swallow an abort either
			await expect(
				staleIfError("https://api.tidal.com/v1/ping", failing(abortError), new Request("https://api.tidal.com/v1/ping", { signal })),
			).rejects.toThrow("aborted");
		});

		test("a replayed playbackinfo carries the streaming session id the page sent", async () => {
			const url = "https://api.tidal.com/v1/tracks/1/playbackinfo?audioquality=LOSSLESS";
			await keepOnline(url, () => jsonOf({ trackId: 1, streamingSessionId: "stale" }));
			await waitForKept();

			const req = new Request(url, { headers: { "x-tidal-streamingsessionid": "live-123" } });
			expect(await (await staleIfError(url, failing(), req)).json()).toEqual({ trackId: 1, streamingSessionId: "live-123" });
			// Nothing was sent, so the kept id stands
			expect(await (await staleIfError(url, failing())).json()).toEqual({ trackId: 1, streamingSessionId: "stale" });
		});
	});

	describe("what is not cached", () => {
		test("only GETs: any other method is passed straight through", async () => {
			const url = "https://api.tidal.com/v1/tracks/1";
			const upstream = jsonOf({ id: 1 });
			const post = serving(() => upstream);
			expect(await staleIfError(url, post, new Request(url, { method: "POST" }))).toBe(upstream);
			expect(post).toHaveBeenCalledOnce();
			expect(await dataFiles()).toHaveLength(0);
			// Nothing kept, so a later GET for the same url has nothing to replay
			expect((await staleIfError(url, failing())).status).toBe(404);
		});

		test.each([
			["a non-200 response", () => jsonOf({ error: "nope" }, { status: 404, statusText: "Not Found" })],
			["an audio body", () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } })],
			["a body without a content type", () => new Response(new Uint8Array([1, 2, 3]))],
		] as [string, () => Response][])("does not keep %s", async (_what, make) => {
			const url = "https://api.tidal.com/v1/tracks/1";
			const upstream = make();
			const res = await staleIfError(
				url,
				serving(() => upstream),
			);
			expect(res).toBe(upstream);
			expect(await dataFiles()).toHaveLength(0);
			expect((await staleIfError(url, failing())).status).toBe(404);
		});
	});

	describe("kept api responses are per account", () => {
		const url = "https://api.tidal.com/v1/users/me/favorites?limit=10";

		test("two accounts on the same url get their own entries", async () => {
			await keepOnline(url, () => jsonOf({ favorites: ["a"] }), asAccount(url, 111));
			await keepOnline(url, () => jsonOf({ favorites: ["b"] }), asAccount(url, 222));
			await waitForKept(2);

			expect(await (await staleIfError(url, failing(), asAccount(url, 111))).json()).toEqual({ favorites: ["a"] });
			expect(await (await staleIfError(url, failing(), asAccount(url, 222))).json()).toEqual({ favorites: ["b"] });
			// A third account has nothing kept
			expect((await staleIfError(url, failing(), asAccount(url, 333))).status).toBe(404);
			// The token itself is never written: the kept entry is only the response
			expect(JSON.stringify(keptMeta())).not.toContain("Bearer");
		});

		test("a request without a token has its own entry", async () => {
			await keepOnline(url, () => jsonOf({ favorites: ["anon"] }));
			await waitForKept();

			expect(await (await staleIfError(url, failing(), new Request(url))).json()).toEqual({ favorites: ["anon"] });
			// A signed-in request must not be served the anonymous copy
			expect((await staleIfError(url, failing(), asAccount(url, 111))).status).toBe(404);
		});

		test("an authorization that names no account is ignored", async () => {
			await keepOnline(url, () => jsonOf({ favorites: ["anon"] }));
			await waitForKept();

			const authorizations = ["Bearer not-a-jwt", `Bearer ${jwt({})}`, `Token ${jwt({ uid: 111 })}`];
			for (const authorization of authorizations) {
				const req = new Request(url, { headers: { authorization } });
				expect(await (await staleIfError(url, failing(), req)).json()).toEqual({ favorites: ["anon"] });
			}
		});
	});
});
