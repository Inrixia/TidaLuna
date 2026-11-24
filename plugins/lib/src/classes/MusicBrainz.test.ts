import { afterEach, describe, expect, it, vi } from "vitest";

import { Cache, CacheStore, MapBackend } from "@luna/core";

import { MusicBrainz } from "./MusicBrainz";

let seq = 0;
const newCache = () =>
	Cache.from(`test.musicBrainz.${++seq}`, () => ({
		memory: new CacheStore({ meta: new MapBackend(), data: new MapBackend<unknown>() }),
	}));

const jsonResponse = (body: unknown, status = 200, statusText = "OK") =>
	new Response(JSON.stringify(body), { status, statusText, headers: { "content-type": "application/json" } });

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("MusicBrainz", () => {
	it("shares one in-flight request across concurrent callers and serves later calls from cache", async () => {
		const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ id: "rec-1" }));
		vi.stubGlobal("fetch", fetchMock);
		const mb = new MusicBrainz(newCache());
		const url = "https://musicbrainz.org/ws/2/recording/rec-1?fmt=json";

		const [a, b] = await Promise.all([mb.json<{ id: string }>(url), mb.json<{ id: string }>(url)]);
		expect(a).toEqual({ id: "rec-1" });
		expect(b).toBe(a);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await expect(mb.json(url)).resolves.toEqual({ id: "rec-1" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries 503 busy responses before succeeding", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("", { status: 503, statusText: "Service Unavailable" }))
			.mockResolvedValueOnce(jsonResponse({ ok: true }));
		vi.stubGlobal("fetch", fetchMock);
		const mb = new MusicBrainz(newCache());

		const pending = mb.json("https://musicbrainz.org/ws/2/isrc/US123?fmt=json");
		await vi.advanceTimersByTimeAsync(500);
		await expect(pending).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not cache failed requests so a subsequent call retries", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("", { status: 404, statusText: "Not Found" }))
			.mockResolvedValueOnce(jsonResponse({ found: true }));
		vi.stubGlobal("fetch", fetchMock);
		const cache = newCache();
		const mb = new MusicBrainz(cache);
		const url = "https://musicbrainz.org/ws/2/isrc/US404?fmt=json";

		await expect(mb.json(url)).rejects.toThrow("404 Not Found");
		expect(cache.has(url)).toBe(false);

		await expect(mb.json(url)).resolves.toEqual({ found: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
