import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sharedRequests, tidalModules } from "@luna/core";

import { resetTidalState, setTidalState } from "../../../../../test/harness/tidalStore";

import { TidalApi } from "./index";

/**
 * `getCredentials` looks TIDAL's credentials module up in TIDAL's module registry, which tests start empty.
 * Seeded here, before any `TidalApi.fetch` runs, so `getAuthHeaders` has credentials to send.
 */
const credentials = { token: "test-token", clientId: "test-client" };
tidalModules["luna.test/credentials"] = { getCredentials: async () => credentials };

type MockedOpenApi = { GET: ReturnType<typeof vi.fn>; POST: ReturnType<typeof vi.fn>; DELETE: ReturnType<typeof vi.fn> };

const jsonResponse = (body: unknown, init: { status?: number; statusText?: string; headers?: Record<string, string> } = {}) =>
	new Response(JSON.stringify(body), {
		status: init.status,
		statusText: init.statusText,
		headers: { "content-type": "application/json", ...init.headers },
	});
const errorResponse = (status: number, statusText: string, headers: Record<string, string> = {}) =>
	new Response("", { status, statusText, headers });
/** An `openApi` response with a body, as `openapi-fetch` returns it */
const openApiOk = (data: unknown) => ({ data, response: jsonResponse(data) });
const openApiError = (status: number, statusText: string) => ({ data: undefined, response: errorResponse(status, statusText) });
/** The url of every request the code under test made */
const fetchedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));
/** Lets pending promise chains and timers run; only for tests using real timers */
const settle = async () => {
	await new Promise((resolve) => setTimeout(resolve, 0));
};
/** `trace.err` logs through `console.error`; error tests keep the output readable */
const silenceErrorLogs = () => vi.spyOn(console, "error").mockImplementation(() => {});
const setPlaybackContext = (actualProductId: string) =>
	setTidalState({ playbackControls: { playbackContext: { actualProductId } } } as unknown as Parameters<typeof setTidalState>[0]);
const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
	const items: T[] = [];
	for await (const item of iterable) items.push(item);
	return items;
};

const fetchMock = vi.fn();
let openApi: MockedOpenApi;

beforeEach(() => {
	// Separate tests must not answer each other's requests, and `queryArgs` keeps what it read the first time
	sharedRequests.clear();
	TidalApi.queryArgs.clear();
	resetTidalState();
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () => jsonResponse({}));
	openApi = { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() };
	openApi.GET.mockResolvedValue(openApiOk(undefined));
	openApi.POST.mockResolvedValue(openApiOk(undefined));
	openApi.DELETE.mockResolvedValue(openApiOk(undefined));
	(TidalApi as unknown as { openApi: MockedOpenApi }).openApi = openApi;
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

afterAll(() => {
	delete tidalModules["luna.test/credentials"];
});

describe("queryArgs", () => {
	test("formats the locale like TIDAL's v1 api and adds the session's country and device type", () => {
		expect(TidalApi.queryArgs()).toBe("countryCode=US&deviceType=DESKTOP&locale=en_US");
	});

	test("uses the bundle's language alone when it names no region", () => {
		setTidalState({ session: { userId: "1", countryCode: "AU" }, locale: { currentBundleName: "en" } });
		expect(TidalApi.queryArgs()).toBe("countryCode=AU&deviceType=DESKTOP&locale=en");
	});

	test("treats a script subtag as no region", () => {
		setTidalState({ locale: { currentBundleName: "en-Latn-US" } });
		expect(TidalApi.queryArgs()).toBe("countryCode=US&deviceType=DESKTOP&locale=en");
	});

	test("is memoized until cleared", () => {
		expect(TidalApi.queryArgs()).toContain("countryCode=US");
		setTidalState({ session: { userId: "1", countryCode: "DE" } });
		expect(TidalApi.queryArgs()).toContain("countryCode=US");

		TidalApi.queryArgs.clear();
		expect(TidalApi.queryArgs()).toContain("countryCode=DE");
	});
});

describe("fetch", () => {
	test("returns the parsed body of a 200 response", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ id: 11, title: "A Track" }));
		await expect(TidalApi.fetch("https://desktop.tidal.com/v1/tracks/11?countryCode=US")).resolves.toEqual({ id: 11, title: "A Track" });
	});

	test("sends the credentials as auth headers", async () => {
		await TidalApi.fetch("https://desktop.tidal.com/v1/tracks/12?countryCode=US");
		expect(fetchMock).toHaveBeenCalledWith("https://desktop.tidal.com/v1/tracks/12?countryCode=US", {
			headers: { Authorization: "Bearer test-token", "x-tidal-token": "test-client" },
		});
	});

	test("returns undefined for 403 and 404", async () => {
		fetchMock.mockResolvedValueOnce(errorResponse(403, "Forbidden")).mockResolvedValueOnce(errorResponse(404, "Not Found"));

		await expect(TidalApi.fetch("https://desktop.tidal.com/v1/tracks/13?countryCode=US")).resolves.toBeUndefined();
		await expect(TidalApi.fetch("https://desktop.tidal.com/v1/tracks/14?countryCode=US")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("retries a failing request once after a second, then throws its status text", async () => {
		silenceErrorLogs();
		vi.useFakeTimers();
		fetchMock.mockImplementation(async () => errorResponse(500, "Internal Server Error"));

		const request = TidalApi.fetch("https://desktop.tidal.com/v1/tracks/15?countryCode=US");
		const failed = expect(request).rejects.toThrow("500 Internal Server Error");

		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// The retry waits a whole second
		await vi.advanceTimersByTimeAsync(999);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await failed;
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Exactly one retry
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("throws without a retry when the response is an offline miss", async () => {
		silenceErrorLogs();
		vi.useFakeTimers();
		fetchMock.mockImplementation(async () => errorResponse(503, "Service Unavailable", { "x-luna-offline-miss": "1" }));

		const request = TidalApi.fetch("https://desktop.tidal.com/v1/tracks/16?countryCode=US");
		const failed = expect(request).rejects.toThrow("503 Service Unavailable");
		await vi.advanceTimersByTimeAsync(0);
		await failed;
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("shares one response between matching requests", async () => {
		fetchMock.mockImplementation(async () => jsonResponse({ id: 17 }));

		const [concurrent, shared] = await Promise.all([
			TidalApi.fetch("https://desktop.tidal.com/v1/tracks/17?countryCode=US"),
			TidalApi.fetch("https://desktop.tidal.com/v1/tracks/17?countryCode=US"),
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(concurrent).toBe(shared);

		// And the cached response answers later calls too
		await expect(TidalApi.fetch("https://desktop.tidal.com/v1/tracks/17?countryCode=US")).resolves.toBe(concurrent);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("the v1 urls", () => {
	const queryArgs = "countryCode=US&deviceType=DESKTOP&locale=en_US";

	test("track", async () => {
		fetchMock.mockImplementation(async () => jsonResponse({ id: 123 }));
		await expect(TidalApi.track(123)).resolves.toEqual({ id: 123 });
		expect(fetchedUrls()).toEqual([`https://desktop.tidal.com/v1/tracks/123?${queryArgs}`]);
	});

	test("album", async () => {
		fetchMock.mockImplementation(async () => jsonResponse({ id: 456 }));
		await expect(TidalApi.album(456)).resolves.toEqual({ id: 456 });
		expect(fetchedUrls()).toEqual([`https://desktop.tidal.com/v1/albums/456?${queryArgs}`]);
	});

	test("artist", async () => {
		fetchMock.mockImplementation(async () => jsonResponse({ id: 789 }));
		await expect(TidalApi.artist(789)).resolves.toEqual({ id: 789 });
		expect(fetchedUrls()).toEqual([`https://desktop.tidal.com/v1/artists/789?${queryArgs}`]);
	});

	test("playlist", async () => {
		fetchMock.mockImplementation(async () => jsonResponse({ uuid: "playlist-uuid" }));
		await expect(TidalApi.playlist("playlist-uuid")).resolves.toEqual({ uuid: "playlist-uuid" });
		expect(fetchedUrls()).toEqual([`https://desktop.tidal.com/v1/playlists/playlist-uuid?${queryArgs}`]);
	});

	test("playlistItems asks for every item", async () => {
		const body = { items: [{ id: 1 }], totalNumberOfItems: 1, offset: 0, limit: -1 };
		fetchMock.mockImplementation(async () => jsonResponse(body));
		await expect(TidalApi.playlistItems("playlist-uuid")).resolves.toEqual(body);
		expect(fetchedUrls()).toEqual([`https://desktop.tidal.com/v1/playlists/playlist-uuid/items?${queryArgs}&limit=-1`]);
	});

	test("albumItems reads the ALBUM_ITEMS page module", async () => {
		const items = [{ id: 1 }, { id: 2 }];
		fetchMock.mockImplementation(async () =>
			jsonResponse({
				id: "album-page",
				rows: [
					{ modules: [{ type: "ALBUM_HEADER" }, { type: "ALBUM_ITEMS", pagedList: { items } }] },
					{ modules: [{ type: "ALBUM_ITEMS", pagedList: { items: [{ id: 3 }] } }] },
				],
			}),
		);
		await expect(TidalApi.albumItems(456)).resolves.toEqual(items);
		expect(fetchedUrls()).toEqual([`https://desktop.tidal.com/v1/pages/album?albumId=456&${queryArgs}`]);
	});

	test("albumItems is undefined without an ALBUM_ITEMS module", async () => {
		fetchMock.mockImplementation(async () => jsonResponse({ id: "album-page", rows: [{ modules: [{ type: "ALBUM_ITEMS" }] }] }));
		await expect(TidalApi.albumItems(457)).resolves.toBeUndefined();
	});
});

describe("playbackInfo", () => {
	test("requests the playback info at the wanted quality", async () => {
		fetchMock.mockImplementation(async () => jsonResponse({ trackId: 101, audioQuality: "LOSSLESS" }));
		await expect(TidalApi.playbackInfo(101, "LOSSLESS")).resolves.toEqual({ trackId: 101, audioQuality: "LOSSLESS" });
		expect(fetchedUrls()).toEqual([
			"https://desktop.tidal.com/v1/tracks/101/playbackinfo?audioquality=LOSSLESS&playbackmode=STREAM&assetpresentation=FULL",
		]);
	});

	test("remembers unavailable tracks instead of asking again", async () => {
		fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));

		await expect(TidalApi.playbackInfo(102, "LOSSLESS")).resolves.toBeUndefined();
		// Another quality is another url, so only the unavailable set stops this one
		await expect(TidalApi.playbackInfo(102, "HIGH")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("keeps at most two requests in flight", async () => {
		const pending: ((response: Response) => void)[] = [];
		fetchMock.mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));

		const requests = [TidalApi.playbackInfo(103, "LOSSLESS"), TidalApi.playbackInfo(104, "LOSSLESS"), TidalApi.playbackInfo(105, "LOSSLESS")];
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);

		pending[0](jsonResponse({ trackId: 103 }));
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchedUrls()[2]).toContain("/tracks/105/playbackinfo");

		pending[1](jsonResponse({ trackId: 104 }));
		pending[2](jsonResponse({ trackId: 105 }));
		await expect(Promise.all(requests)).resolves.toEqual([{ trackId: 103 }, { trackId: 104 }, { trackId: 105 }]);
	});

	test("gives the playing item the next free slot", async () => {
		const pending: ((response: Response) => void)[] = [];
		fetchMock.mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));

		const requests = [TidalApi.playbackInfo(106, "LOSSLESS"), TidalApi.playbackInfo(107, "LOSSLESS")];
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);

		setPlaybackContext("108");
		requests.push(TidalApi.playbackInfo(108, "LOSSLESS"), TidalApi.playbackInfo(109, "LOSSLESS"));
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// The playing item is queued first even though 109 asked before it got a slot
		pending[0](jsonResponse({ trackId: 106 }));
		await settle();
		expect(fetchedUrls()[2]).toContain("/tracks/108/playbackinfo");

		pending[2](jsonResponse({ trackId: 108 }));
		await settle();
		expect(fetchedUrls()[3]).toContain("/tracks/109/playbackinfo");

		pending[1](jsonResponse({ trackId: 107 }));
		pending[3](jsonResponse({ trackId: 109 }));
		await expect(Promise.all(requests)).resolves.toHaveLength(4);
	});
});

describe("videoPlaybackInfo", () => {
	test("requests the wanted video quality", async () => {
		fetchMock.mockImplementation(async () => jsonResponse({ videoId: 201 }));
		await TidalApi.videoPlaybackInfo(201, "LOW");
		await TidalApi.videoPlaybackInfo(202);
		expect(fetchedUrls()).toEqual([
			"https://desktop.tidal.com/v1/videos/201/playbackinfo?videoquality=LOW&playbackmode=STREAM&assetpresentation=FULL",
			"https://desktop.tidal.com/v1/videos/202/playbackinfo?videoquality=HIGH&playbackmode=STREAM&assetpresentation=FULL",
		]);
	});
});

describe("lyrics", () => {
	test("returns the v1 lyrics when TIDAL has them", async () => {
		const v1Lyrics = { trackId: 301, lyricsProvider: "TIDAL", lyrics: "v1 lyrics", isRightToLeft: false };
		fetchMock.mockImplementation(async () => jsonResponse(v1Lyrics));

		await expect(TidalApi.lyrics(301)).resolves.toEqual(v1Lyrics);
		expect(fetchedUrls()).toEqual(["https://desktop.tidal.com/v1/tracks/301/lyrics?countryCode=US&deviceType=DESKTOP&locale=en_US"]);
		expect(openApi.GET).not.toHaveBeenCalled();
	});

	test("falls back to the OpenAPI for a track without v1 lyrics and maps a third party provider", async () => {
		fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
		setTidalState({ session: { userId: "1", countryCode: "AU" } });
		openApi.GET.mockResolvedValue(
			openApiOk({
				data: { id: "302", type: "tracks" },
				included: [
					{
						id: "lyrics-302",
						type: "lyrics",
						attributes: {
							text: "OpenAPI lyrics",
							lrcText: "[00:01.00] OpenAPI lyrics",
							direction: "RIGHT_TO_LEFT",
							provider: { name: "Musixmatch", source: "THIRD_PARTY", commonTrackId: "commontrack-302", lyricsId: "lyrics-id-302" },
						},
					},
				],
			}),
		);

		await expect(TidalApi.lyrics(302)).resolves.toEqual({
			trackId: 302,
			lyricsProvider: "Musixmatch",
			providerCommontrackId: "commontrack-302",
			providerLyricsId: "lyrics-id-302",
			lyrics: "OpenAPI lyrics",
			subtitles: "[00:01.00] OpenAPI lyrics",
			isRightToLeft: true,
		});
		expect(openApi.GET).toHaveBeenCalledWith("/tracks/{id}", {
			params: { path: { id: "302" }, query: { countryCode: "AU", include: ["lyrics"] } },
		});
	});

	test("keeps the provider ids empty for a non third party source", async () => {
		fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
		openApi.GET.mockResolvedValue(
			openApiOk({
				data: { id: "303", type: "tracks" },
				included: [
					{
						id: "lyrics-303",
						type: "lyrics",
						attributes: {
							text: "TIDAL lyrics",
							direction: "LEFT_TO_RIGHT",
							provider: { source: "TIDAL", commonTrackId: "commontrack-303", lyricsId: "lyrics-id-303" },
						},
					},
				],
			}),
		);

		await expect(TidalApi.lyrics(303)).resolves.toEqual({
			trackId: 303,
			lyricsProvider: "TIDAL",
			providerCommontrackId: "",
			providerLyricsId: "",
			lyrics: "TIDAL lyrics",
			subtitles: null,
			isRightToLeft: false,
		});
	});

	test("is undefined when the OpenAPI track has no lyrics text", async () => {
		fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
		openApi.GET.mockResolvedValue(
			openApiOk({ data: { id: "304", type: "tracks" }, included: [{ id: "lyrics-304", type: "lyrics", attributes: { text: "" } }] }),
		);
		await expect(TidalApi.lyrics(304)).resolves.toBeUndefined();
	});

	test("is undefined when the OpenAPI request fails", async () => {
		silenceErrorLogs();
		fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
		openApi.GET.mockResolvedValue(openApiError(500, "Internal Server Error"));
		await expect(TidalApi.lyrics(305)).resolves.toBeUndefined();
	});

	test("looks the OpenAPI lyrics up only once per track", async () => {
		fetchMock.mockResolvedValueOnce(errorResponse(404, "Not Found"));
		openApi.GET.mockResolvedValue(
			openApiOk({ data: { id: "306", type: "tracks" }, included: [{ id: "lyrics-306", type: "lyrics", attributes: { text: "Once" } }] }),
		);

		const first = await TidalApi.lyrics(306);
		await expect(TidalApi.lyrics(306)).resolves.toEqual(first);
		expect(openApi.GET).toHaveBeenCalledTimes(1);
	});
});

describe("playlistItemIds", () => {
	test("requests an uncached url and returns the item uuids", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const now = new Date("2024-05-06T07:08:09.000Z").getTime();
		vi.setSystemTime(now);
		fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ item: { itemUuid: "item-a" } }, { item: { itemUuid: "item-b" } }] }));

		await expect(TidalApi.playlistItemIds("playlist-uuid")).resolves.toEqual(["item-a", "item-b"]);
		const url = `https://desktop.tidal.com/v1/playlists/playlist-uuid/items?countryCode=US&deviceType=DESKTOP&locale=en_US&limit=-1&_=${now}`;
		expect(fetchedUrls()).toEqual([url]);
		expect(fetchMock).toHaveBeenCalledWith(url, { headers: { Authorization: "Bearer test-token", "x-tidal-token": "test-client" } });
	});

	test("throws on a response that is not ok", async () => {
		silenceErrorLogs();
		fetchMock.mockResolvedValueOnce(errorResponse(500, "Internal Server Error"));
		await expect(TidalApi.playlistItemIds("playlist-uuid")).rejects.toThrow("500 Internal Server Error");
	});
});

describe("addPlaylistItems", () => {
	test("maps the meta.itemId of the entries TIDAL returns", async () => {
		openApi.POST.mockResolvedValue(
			openApiOk({
				data: [
					{ id: "track-1", type: "tracks", meta: { itemId: "item-1" } },
					{ id: "track-2", type: "tracks" },
				],
			}),
		);

		const items = [
			{ id: "track-1", type: "tracks" },
			{ id: "track-2", type: "tracks" },
		] as const;
		await expect(TidalApi.addPlaylistItems("playlist-uuid", [...items])).resolves.toEqual([
			{ id: "track-1", type: "tracks", meta: { itemId: "item-1" } },
		]);
		expect(openApi.POST).toHaveBeenCalledWith("/playlists/{id}/relationships/items", {
			params: { path: { id: "playlist-uuid" } },
			body: { data: [...items], meta: undefined },
		});
	});

	test("sends positionBefore when given", async () => {
		openApi.POST.mockResolvedValue(openApiOk({ data: [{ id: "track-1", type: "tracks", meta: { itemId: "item-1" } }] }));
		await TidalApi.addPlaylistItems("playlist-uuid", [{ id: "track-1", type: "tracks" }], "item-0");
		expect(openApi.POST).toHaveBeenCalledWith("/playlists/{id}/relationships/items", {
			params: { path: { id: "playlist-uuid" } },
			body: { data: [{ id: "track-1", type: "tracks" }], meta: { onDuplicates: "ADD", positionBefore: "item-0" } },
		});
	});

	test("attaches the response status to the error it throws", async () => {
		silenceErrorLogs();
		openApi.POST.mockResolvedValue(openApiError(422, "Unprocessable Entity"));
		await expect(TidalApi.addPlaylistItems("playlist-uuid", [{ id: "track-1", type: "tracks" }])).rejects.toMatchObject({
			status: 422,
			message: "422 Unprocessable Entity",
		});
	});
});

describe("createPlaylist", () => {
	test("creates the playlist and returns its id", async () => {
		openApi.POST.mockResolvedValue(openApiOk({ data: { id: "new-playlist", type: "playlists" } }));

		await expect(TidalApi.createPlaylist("My Playlist", { description: "A description" })).resolves.toBe("new-playlist");
		expect(openApi.POST).toHaveBeenCalledWith("/playlists", {
			body: { data: { type: "playlists", attributes: { name: "My Playlist", description: "A description", accessType: "UNLISTED" } } },
		});
	});

	test("creates a public playlist when asked for", async () => {
		openApi.POST.mockResolvedValue(openApiOk({ data: { id: "public-playlist", type: "playlists" } }));
		await TidalApi.createPlaylist("Public", { accessType: "PUBLIC" });
		expect(openApi.POST).toHaveBeenCalledWith("/playlists", {
			body: { data: { type: "playlists", attributes: { name: "Public", description: undefined, accessType: "PUBLIC" } } },
		});
	});

	test("throws the response status when the request is rejected", async () => {
		silenceErrorLogs();
		openApi.POST.mockResolvedValue(openApiError(403, "Forbidden"));
		await expect(TidalApi.createPlaylist("My Playlist")).rejects.toThrow("403 Forbidden");
	});

	test("throws when the response holds no playlist id", async () => {
		silenceErrorLogs();
		openApi.POST.mockResolvedValue(openApiOk({ data: { type: "playlists" } }));
		await expect(TidalApi.createPlaylist("My Playlist")).rejects.toThrow("No playlist id in the response");
	});
});

describe("removePlaylistItems", () => {
	test("sends the items with their meta.itemId", async () => {
		const items = [
			{ id: "track-1", type: "tracks", meta: { itemId: "item-1" } },
			{ id: "track-2", type: "tracks", meta: { itemId: "item-2" } },
		] as unknown as Parameters<typeof TidalApi.removePlaylistItems>[1];

		await TidalApi.removePlaylistItems("playlist-uuid", items);
		expect(openApi.DELETE).toHaveBeenCalledWith("/playlists/{id}/relationships/items", {
			params: { path: { id: "playlist-uuid" } },
			body: {
				data: [
					{ id: "track-1", type: "tracks", meta: { itemId: "item-1" } },
					{ id: "track-2", type: "tracks", meta: { itemId: "item-2" } },
				],
			},
		});
	});

	test("throws the response status when the request is rejected", async () => {
		silenceErrorLogs();
		openApi.DELETE.mockResolvedValue(openApiError(404, "Not Found"));
		await expect(TidalApi.removePlaylistItems("playlist-uuid", [])).rejects.toThrow("404 Not Found");
	});
});

describe("isrc", () => {
	test("pages through the tracks with the cursor and stops when there is none", async () => {
		openApi.GET.mockResolvedValueOnce(
			openApiOk({ data: [{ id: "track-1", type: "tracks" }], links: { meta: { nextCursor: "cursor-1" } } }),
		).mockResolvedValueOnce(openApiOk({ data: [{ id: "track-2", type: "tracks" }], links: { meta: {} } }));

		await expect(collect(TidalApi.isrc("ISRC-1"))).resolves.toEqual([
			{ id: "track-1", type: "tracks" },
			{ id: "track-2", type: "tracks" },
		]);
		expect(openApi.GET).toHaveBeenCalledTimes(2);
		expect(openApi.GET).toHaveBeenNthCalledWith(1, "/tracks", {
			params: { query: { countryCode: "US", "filter[isrc]": ["ISRC-1"], "page[cursor]": undefined } },
		});
		expect(openApi.GET).toHaveBeenNthCalledWith(2, "/tracks", {
			params: { query: { countryCode: "US", "filter[isrc]": ["ISRC-1"], "page[cursor]": "cursor-1" } },
		});
	});

	test("stops on an empty first page", async () => {
		openApi.GET.mockResolvedValueOnce(openApiOk({ data: [], links: { meta: {} } }));
		await expect(collect(TidalApi.isrc("ISRC-2"))).resolves.toEqual([]);
		expect(openApi.GET).toHaveBeenCalledTimes(1);
	});

	test("fetches each page once for repeated iterations", async () => {
		openApi.GET.mockResolvedValueOnce(
			openApiOk({ data: [{ id: "track-3", type: "tracks" }], links: { meta: { nextCursor: "cursor-3" } } }),
		).mockResolvedValueOnce(openApiOk({ data: [{ id: "track-4", type: "tracks" }], links: { meta: {} } }));

		await collect(TidalApi.isrc("ISRC-3"));
		await collect(TidalApi.isrc("ISRC-3"));
		expect(openApi.GET).toHaveBeenCalledTimes(2);
	});
});
