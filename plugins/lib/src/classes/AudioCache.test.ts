import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { interceptors, ReactiveStore } from "@luna/core";

// By path: `test/*` is a vitest alias only, so `tsc` would not resolve these imports
import { resetTidalState, setTidalState, type TidalState } from "../../../../test/harness/tidalStore";

import { AudioCache, cacheFileName } from "./AudioCache";
import { MediaItem } from "./MediaItem";

/**
 * AudioCache is the renderer half of the native audio cache: it turns track ids into the url TIDAL's native player
 * plays, and asks the main process to fill its memory and disk. The native side is a set of IPC stubs, so every
 * `audioCache*` call is captured here, and `getPlaybackInfo` is replaced so no request is made.
 */
const nativeFns = vi.hoisted(() => ({
	audioCacheHover: vi.fn(async (_url: string): Promise<void> => undefined),
	audioCacheOpenFolder: vi.fn(async (): Promise<string> => ""),
	audioCachePersist: vi.fn(async (_url: string, _filePath?: string): Promise<void> => undefined),
	audioCacheSetLimit: vi.fn(async (_bytes?: number): Promise<void> => undefined),
	audioCacheStats: vi.fn(async () => ({})),
	audioCacheStatus: vi.fn(async (_url: string) => ({}) as { filledBytes?: number; complete?: boolean }),
	audioCacheWaitFilled: vi.fn(async (_url: string): Promise<string | undefined> => undefined),
	audioCacheWindow: vi.fn(async (_urls: string[]): Promise<void> => undefined),
}));
// MediaItem.download.native reaches the same bridge for its progress stream
vi.mock("../../../lib.native/src/index.native", () => ({ ...nativeFns, fetchMediaItemStream: vi.fn() }));

const getPlaybackInfo = vi.hoisted(() => vi.fn());
vi.mock("../helpers/getPlaybackInfo", () => ({ getPlaybackInfo, getVideoPlaybackInfo: vi.fn() }));

const bts = (url: string) => ({ manifestMimeType: "application/vnd.tidal.bts" as const, manifest: { urls: [url] } });
const dash = { manifestMimeType: "application/dash+xml" as const, manifest: {} };

/** The harness store is typed from an abbreviated TIDAL store, so slices it lacks (`settings`) are written through a cast */
const setState = (patch: Record<string, unknown>) => setTidalState(patch as unknown as Partial<TidalState>);

type QueueElement = { mediaItemId: string };
/** The state the static block and `url()` read: the streaming quality, the queue and what is playing */
const playback = (options: { elements?: QueueElement[]; currentIndex?: number; actualProductId?: string } = {}) =>
	setState({
		settings: { quality: { streaming: "LOSSLESS" } },
		playQueue: { elements: options.elements ?? [], currentIndex: options.currentIndex ?? -1, shuffleModeEnabled: false, repeatMode: 0 },
		playbackControls: {
			playbackState: "PLAYING",
			desiredPlaybackState: "PLAYING",
			latestCurrentTime: 0,
			playbackContext: options.actualProductId === undefined ? undefined : { actualProductId: options.actualProductId },
		},
	});

/**
 * TIDAL patches its action creators so Luna's interceptors run before an action dispatches
 * (render/src/exposeTidalInternals.patchAction.ts). test/setup-dom.ts seeds plain creators, so the transition is run
 * through its interceptors by hand, which is what AudioCache's static block listens to.
 */
const TRANSITION = "playbackControls/MEDIA_PRODUCT_TRANSITION";
const runTransition = () => {
	for (const interceptor of interceptors[TRANSITION] ?? []) {
		(interceptor as unknown as (payload: unknown, type: string) => unknown)(undefined, TRANSITION);
	}
};

const fromId = vi.spyOn(MediaItem, "fromId");

/** A MediaItem only as far as `persist` reads it: its tags, the extension of the chosen quality and its download */
const fakeMediaItem = (options: { artist?: string[]; title?: string; ext?: string; saved?: string } = {}) => {
	const download = vi.fn(async (_path: string | string[], _quality?: unknown): Promise<string> => options.saved ?? "/saved/track.flac");
	return {
		download,
		mediaItem: {
			flacTags: async () => ({ tags: { artist: options.artist, title: options.title } }),
			fileExtension: async () => options.ext ?? "flac",
			download,
		} as unknown as MediaItem,
	};
};

/** Rows added for the hover test, removed after each so they cannot be found by a later dispatch */
const rows: HTMLElement[] = [];
const row = (trackId?: string) => {
	const element = document.createElement("div");
	if (trackId !== undefined) element.setAttribute("data-track-id", trackId);
	document.body.append(element);
	rows.push(element);
	return element;
};
const pointerOver = (element: Element) => element.dispatchEvent(new Event("pointerover", { bubbles: true }));

beforeEach(() => {
	resetTidalState();
	// `url()` reads the streaming quality off TIDAL's store, which the abbreviated harness store has no settings slice for
	playback();
	vi.clearAllMocks();
	getPlaybackInfo.mockReset();
	getPlaybackInfo.mockImplementation(async (trackId: unknown) => bts(`https://audio.example/${trackId}`));
	fromId.mockReset();
	fromId.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
	for (const element of rows.splice(0)) element.remove();
});

afterAll(() => {
	vi.restoreAllMocks();
});

describe("url", () => {
	test("is the first url of a BTS manifest at the streaming quality", async () => {
		getPlaybackInfo.mockResolvedValue(bts("https://audio.example/first"));

		await expect(AudioCache.url("42")).resolves.toBe("https://audio.example/first");
		expect(getPlaybackInfo).toHaveBeenCalledWith("42", "LOSSLESS");
	});

	test("reads the streaming quality from TIDAL's store, not a fixed one", async () => {
		playback({ elements: [] });
		setState({ settings: { quality: { streaming: "HI_RES_LOSSLESS" } } });

		await AudioCache.url("42");

		expect(getPlaybackInfo).toHaveBeenCalledWith("42", "HI_RES_LOSSLESS");
	});

	test("is undefined for a DASH manifest, which TIDAL's page plays itself", async () => {
		getPlaybackInfo.mockResolvedValue(dash);

		await expect(AudioCache.url("42")).resolves.toBeUndefined();
	});

	test("is undefined when TIDAL has no playback info for the track", async () => {
		getPlaybackInfo.mockResolvedValue(undefined);

		await expect(AudioCache.url("42")).resolves.toBeUndefined();
	});

	test("is undefined instead of throwing when the request fails", async () => {
		getPlaybackInfo.mockRejectedValue(new Error("401"));

		await expect(AudioCache.url("42")).resolves.toBeUndefined();
	});
});

describe("status", () => {
	test("asks the native cache about the url of the track", async () => {
		const status = { filledBytes: 1024, complete: false };
		nativeFns.audioCacheStatus.mockResolvedValue(status);

		await expect(AudioCache.status("42")).resolves.toBe(status);
		expect(nativeFns.audioCacheStatus).toHaveBeenCalledWith("https://audio.example/42");
	});

	test("asks nothing, and is undefined, for a track it has no url for", async () => {
		getPlaybackInfo.mockResolvedValue(dash);

		await expect(AudioCache.status("42")).resolves.toBeUndefined();
		expect(nativeFns.audioCacheStatus).not.toHaveBeenCalled();
	});
});

describe("prefetch", () => {
	test("has the native cache fetch what the track needs to start at once", async () => {
		await AudioCache.prefetch("42");

		expect(nativeFns.audioCacheHover).toHaveBeenCalledWith("https://audio.example/42");
	});

	test("does nothing without a url", async () => {
		getPlaybackInfo.mockResolvedValue(undefined);

		await AudioCache.prefetch("42");

		expect(nativeFns.audioCacheHover).not.toHaveBeenCalled();
	});
});

describe("native passthroughs", () => {
	test("stats() reads the native cache's stats", async () => {
		const stats = { bytes: 1 };
		nativeFns.audioCacheStats.mockResolvedValue(stats);

		await expect(AudioCache.stats()).resolves.toBe(stats);
	});

	test("openFolder() opens the native cache folder", async () => {
		nativeFns.audioCacheOpenFolder.mockResolvedValue("C:\\cache");

		await expect(AudioCache.openFolder()).resolves.toBe("C:\\cache");
	});
});

describe("limit", () => {
	test("setLimit stores the limit for the next start and applies it now", async () => {
		await AudioCache.setLimit(4096);

		expect(nativeFns.audioCacheSetLimit).toHaveBeenCalledWith(4096);
		const storage = await ReactiveStore.getPluginStorage("@luna/lib.AudioCache", { limitBytes: 0 });
		expect(storage.limitBytes).toBe(4096);
	});

	test("setLimit(0) restores the default, which the main process reads as no limit", async () => {
		await AudioCache.setLimit(4096);
		nativeFns.audioCacheSetLimit.mockClear();

		await AudioCache.setLimit(0);

		expect(nativeFns.audioCacheSetLimit).toHaveBeenCalledWith(undefined);
		const storage = await ReactiveStore.getPluginStorage("@luna/lib.AudioCache", { limitBytes: 0 });
		expect(storage.limitBytes).toBe(0);
	});
});

describe("the playback window", () => {
	const elements = [{ mediaItemId: "101" }, { mediaItemId: "102" }, { mediaItemId: "103" }];

	test("fetches the next and previous track a second after playback moves", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements, currentIndex: 1, actualProductId: "200" });

		runTransition();
		await vi.advanceTimersByTimeAsync(999);
		expect(nativeFns.audioCacheWindow).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		// The playing track is the one TIDAL's player already plays, so only its neighbours are handed over
		expect(nativeFns.audioCacheWindow).toHaveBeenCalledWith(["https://audio.example/103", "https://audio.example/101"]);
	});

	test("skips through tracks without fetching each: a second transition restarts the wait", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements, currentIndex: 0, actualProductId: "200" });

		runTransition();
		await vi.advanceTimersByTimeAsync(500);
		runTransition();
		await vi.advanceTimersByTimeAsync(999);
		expect(nativeFns.audioCacheWindow).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		expect(nativeFns.audioCacheWindow).toHaveBeenCalledTimes(1);
	});

	test("drops the neighbours that have no audio url", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements, currentIndex: 1, actualProductId: "200" });
		getPlaybackInfo.mockImplementation(async (trackId: unknown) => (String(trackId) === "101" ? dash : bts(`https://audio.example/${trackId}`)));

		runTransition();
		await vi.advanceTimersByTimeAsync(1000);

		expect(nativeFns.audioCacheWindow).toHaveBeenCalledWith(["https://audio.example/103"]);
	});

	test("persists the current, next and previous track once their audio has filled", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements, currentIndex: 1, actualProductId: "200" });

		runTransition();
		await vi.advanceTimersByTimeAsync(1000);

		expect(nativeFns.audioCacheWaitFilled.mock.calls.map(([url]) => url)).toEqual([
			"https://audio.example/200",
			"https://audio.example/103",
			"https://audio.example/101",
		]);
		// Nothing filled yet: nothing to hand to TIDAL as a finished download
		expect(nativeFns.audioCachePersist).not.toHaveBeenCalled();
		expect(fromId).not.toHaveBeenCalled();
	});

	test("downloads the filled audio through the MediaItem, then asks the native cache to keep the file", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements, currentIndex: 1, actualProductId: "200" });
		nativeFns.audioCacheWaitFilled.mockResolvedValue("/cache/audio");
		const { mediaItem, download } = fakeMediaItem({ artist: ["Artist"], title: "Title" });
		fromId.mockResolvedValue(mediaItem);

		runTransition();
		await vi.advanceTimersByTimeAsync(1000);

		expect(download).toHaveBeenCalledWith(["/cache/audio", "Artist - Title [200].flac"], "LOSSLESS");
		expect(nativeFns.audioCachePersist).toHaveBeenCalledWith("https://audio.example/200", "/saved/track.flac");
	});

	test("names the file after the tags, falling back to the id and to a placeholder artist", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements: [], currentIndex: -1, actualProductId: "200" });
		nativeFns.audioCacheWaitFilled.mockResolvedValue("/cache/audio");
		const { mediaItem, download } = fakeMediaItem({});
		fromId.mockResolvedValue(mediaItem);

		runTransition();
		await vi.advanceTimersByTimeAsync(1000);

		expect(download).toHaveBeenCalledWith(["/cache/audio", "Unknown Artist - 200 [200].flac"], "LOSSLESS");
	});

	test("joins every artist, and keeps the id and extension when the name has to be cut", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements: [], currentIndex: -1, actualProductId: "200" });
		nativeFns.audioCacheWaitFilled.mockResolvedValue("/cache/audio");
		// 60 four-byte emoji: 240 bytes, past the 200 byte budget for the name
		const artist = "🎵".repeat(60);
		const { mediaItem, download } = fakeMediaItem({ artist: [artist, "Guest"], title: "Title" });
		fromId.mockResolvedValue(mediaItem);

		runTransition();
		await vi.advanceTimersByTimeAsync(1000);

		const [[, name]] = download.mock.calls[0] as unknown as [[string, string]];
		expect(name.endsWith(" [200].flac")).toBe(true);
		const cut = name.slice(0, -" [200].flac".length);
		// Cut at a character boundary, not mid-emoji, and within the byte budget
		expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(200);
		expect(cut).toBe("🎵".repeat(50));
	});

	test("keeps the file path the MediaItem download returned", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements: [], currentIndex: -1, actualProductId: "200" });
		nativeFns.audioCacheWaitFilled.mockResolvedValue("/cache/audio");
		fromId.mockResolvedValue(fakeMediaItem({ saved: "/music/Artist - Title [200].flac" }).mediaItem);

		runTransition();
		await vi.advanceTimersByTimeAsync(1000);

		expect(nativeFns.audioCachePersist).toHaveBeenCalledWith("https://audio.example/200", "/music/Artist - Title [200].flac");
	});

	test("hands the cache an empty path when the track has no MediaItem", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements: [], currentIndex: -1, actualProductId: "200" });
		nativeFns.audioCacheWaitFilled.mockResolvedValue("/cache/audio");

		runTransition();
		await vi.advanceTimersByTimeAsync(1000);

		expect(nativeFns.audioCachePersist).toHaveBeenCalledWith("https://audio.example/200", undefined);
	});

	test("persists a track once, even when the window is updated again while it fills", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements, currentIndex: 1, actualProductId: "200" });
		const resolvers: (() => void)[] = [];
		nativeFns.audioCacheWaitFilled.mockImplementation(
			() =>
				new Promise<string | undefined>((resolve) => {
					resolvers.push(() => resolve(undefined));
				}),
		);

		runTransition();
		await vi.advanceTimersByTimeAsync(1000);
		expect(nativeFns.audioCacheWaitFilled).toHaveBeenCalledTimes(3);

		runTransition();
		await vi.advanceTimersByTimeAsync(1000);

		// Still filling: the same urls are not waited on twice
		expect(nativeFns.audioCacheWaitFilled).toHaveBeenCalledTimes(3);
		for (const resolve of resolvers) resolve();
	});
});

describe("hover", () => {
	test("prefetches the track of a hovered row, debounced", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const element = row("77");

		pointerOver(element);
		await vi.advanceTimersByTimeAsync(99);
		expect(nativeFns.audioCacheHover).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		expect(nativeFns.audioCacheHover).toHaveBeenCalledWith("https://audio.example/77");
	});

	test("does nothing when the pointer stays on the same row", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		// The hovered id is kept by the module, so each case uses its own track
		const element = row("78");

		pointerOver(element);
		await vi.advanceTimersByTimeAsync(100);
		pointerOver(element);
		await vi.advanceTimersByTimeAsync(100);

		expect(nativeFns.audioCacheHover).toHaveBeenCalledTimes(1);
	});

	test("moves to the row the pointer entered, and stops on a row without a track", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const first = row("80");
		const second = row("81");
		const plain = row();

		pointerOver(first);
		await vi.advanceTimersByTimeAsync(100);
		pointerOver(second);
		await vi.advanceTimersByTimeAsync(100);
		expect(nativeFns.audioCacheHover.mock.calls).toEqual([["https://audio.example/80"], ["https://audio.example/81"]]);

		pointerOver(plain);
		await vi.advanceTimersByTimeAsync(100);
		// On a row with no track: the pending prefetch is cancelled, and none is started
		expect(nativeFns.audioCacheHover).toHaveBeenCalledTimes(2);
	});
});

describe("the stored limit at startup", () => {
	test("is applied to the native cache, unless it is the default", async () => {
		// A start of TIDAL reads the limit the last run saved, before anything asks for it
		const storage = await ReactiveStore.getPluginStorage("@luna/lib.AudioCache", { limitBytes: 0 });
		storage.limitBytes = 4321;
		await vi.waitFor(async () => {
			expect(await ReactiveStore.getStore("@luna/pluginStorage").get("@luna/lib.AudioCache")).toEqual({ limitBytes: 4321 });
		});

		vi.resetModules();
		const { AudioCache: restarted } = await import("./AudioCache");
		await vi.waitFor(() => expect(nativeFns.audioCacheSetLimit).toHaveBeenCalledWith(4321));
		// The restarted class is a whole new generation of the module
		expect(restarted).not.toBe(AudioCache);

		// Its document listener is this generation's: drop it so it doesn't double every hover of a later case
		const { unloads } = await import("../index.safe");
		for (const unload of [...unloads]) unload();
		await vi.waitFor(async () => {
			expect(await ReactiveStore.getStore("@luna/pluginStorage").get("@luna/lib.AudioCache")).toEqual({ limitBytes: 4321 });
		});
		storage.limitBytes = 0;
	});
});

describe("cacheFileName", () => {
	test("a cached track's name is one path segment", () => {
		// A track by AC/DC was stored as `AC/DC - Through the Mists of Time.flac`, which made a folder called AC inside
		// the cache folder. The next start's scan met a directory where it expects files, failed to remove it, and
		// reported `Failed to read the cache folder` every launch from then on.
		expect(cacheFileName("AC/DC", "Through the Mists of Time", 123, "flac")).toBe("AC-DC - Through the Mists of Time [123].flac");
		// Backslash too: Windows accepts either, and the name is passed to join
		expect(cacheFileName("a\\b", "t", 1, "flac")).toBe("a-b - t [1].flac");
		// The id and extension are what keep two tracks with the same artist and title apart, so they survive
		expect(cacheFileName("a/b", "t", 42, "m4a")).toContain("[42].m4a");
	});

	test("a name Windows refuses is not the download's problem", () => {
		// A title holds these: `Chapter 1: Intro`, `Why?`, `"Heroes"`. Windows rejects each in a name, so the download
		// failed rather than the cache holding it
		expect(cacheFileName("a", 'Chapter 1: "Intro"?', 7, "flac")).toBe("a - Chapter 1- -Intro-- [7].flac");
		expect(cacheFileName("a|b", "t*c<d>e", 8, "flac")).toBe("a-b - t-c-d-e [8].flac");
	});
});
