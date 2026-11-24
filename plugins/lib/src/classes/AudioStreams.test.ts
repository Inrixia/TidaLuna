import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { interceptors } from "@luna/core";

import { resetTidalState, setTidalState, type TidalState } from "../../../../test/harness/tidalStore";

import { AudioStreams, type AudioStreamStatus } from "./AudioStreams";
import { MediaItem } from "./MediaItem";
import { PlaybackInfo, type TrackPlaybackInfo } from "./PlaybackInfo";

const nativeFns = vi.hoisted(() => ({
	audioStreamsHover: vi.fn(async (_url: string): Promise<void> => undefined),
	audioStreamsStatus: vi.fn(async (_url: string): Promise<AudioStreamStatus> => ({ cachedBytes: 0, complete: false })),
	audioStreamsWaitFilled: vi.fn(async (_url: string): Promise<boolean> => false),
	audioStreamsWindow: vi.fn(async (_urls: string[]): Promise<void> => undefined),
	persistAudioStream: vi.fn(async (_url: string, _info?: unknown, _path?: string, _tags?: unknown): Promise<void> => undefined),
}));
vi.mock("../../../lib.native/src/index.native", () => ({ ...nativeFns, fetchMediaItemStream: vi.fn() }));

const bts = (url: string, audioQuality: "LOSSLESS" | "HIGH" | "LOW" = "LOSSLESS"): TrackPlaybackInfo =>
	({
		trackId: 200,
		audioQuality,
		manifestMimeType: "application/vnd.tidal.bts",
		manifest: { mimeType: audioQuality === "LOSSLESS" ? "audio/flac" : "audio/mp4", codecs: "flac", encryptionType: "NONE", urls: [url] },
	}) as unknown as TrackPlaybackInfo;

const dash = {
	trackId: 200,
	audioQuality: "HI_RES_LOSSLESS",
	manifestMimeType: "application/dash+xml",
	manifest: {},
} as unknown as TrackPlaybackInfo;

const setState = (patch: Record<string, unknown>) => setTidalState(patch as unknown as Partial<TidalState>);

type QueueElement = { mediaItemId: string };
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

const TRANSITION = "playbackControls/MEDIA_PRODUCT_TRANSITION";
const runTransition = () => {
	for (const interceptor of interceptors[TRANSITION] ?? []) {
		(interceptor as unknown as (payload: unknown, type: string) => unknown)(undefined, TRANSITION);
	}
};

const playbackGet = vi.spyOn(PlaybackInfo, "get");
const fromId = vi.spyOn(MediaItem, "fromId");
const artistNames = vi.spyOn(MediaItem, "artistNames");

const fakeMediaItem = (
	options: {
		artists?: string[];
		album?: string;
		fallbackAlbum?: string;
		title?: string;
		ext?: string;
		info?: TrackPlaybackInfo;
	} = {},
) => {
	const info = options.info ?? bts("https://audio.example/200");
	const tags = { tags: { artist: options.artists, title: options.title } };
	artistNames.mockResolvedValue(options.artists ?? []);
	return {
		tags,
		info,
		mediaItem: {
			title: async () => options.title,
			artists: async () => [],
			album: async () => (options.album === undefined ? undefined : { title: async () => options.album }),
			tidalItem: { album: options.fallbackAlbum === undefined ? undefined : { title: options.fallbackAlbum } },
			fileExtension: async () => options.ext ?? "flac",
			playbackInfo: async () => info,
			flacTags: async () => tags,
		} as unknown as MediaItem,
	};
};

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
	playback();
	AudioStreams.settings.ahead = 1;
	AudioStreams.settings.behind = 1;
	vi.clearAllMocks();
	playbackGet.mockReset();
	playbackGet.mockImplementation(async (trackId: unknown) => bts(`https://audio.example/${trackId}`));
	fromId.mockReset();
	fromId.mockResolvedValue(undefined);
	artistNames.mockReset();
	artistNames.mockResolvedValue([]);
});

afterEach(() => {
	vi.useRealTimers();
	for (const element of rows.splice(0)) element.remove();
});

afterAll(() => {
	vi.restoreAllMocks();
});

describe("url, status & prefetch", () => {
	test("url returns the first BTS manifest url at streaming quality and undefined for DASH, missing or failed lookups", async () => {
		playbackGet.mockResolvedValueOnce(bts("https://audio.example/first"));
		await expect(AudioStreams.url("42")).resolves.toBe("https://audio.example/first");
		expect(playbackGet).toHaveBeenCalledWith("42", "LOSSLESS");

		setState({ settings: { quality: { streaming: "HI_RES_LOSSLESS" } } });
		await AudioStreams.url("42");
		expect(playbackGet).toHaveBeenCalledWith("42", "HI_RES_LOSSLESS");

		playbackGet.mockResolvedValueOnce(dash);
		await expect(AudioStreams.url("42")).resolves.toBeUndefined();

		playbackGet.mockResolvedValueOnce(undefined);
		await expect(AudioStreams.url("42")).resolves.toBeUndefined();

		playbackGet.mockRejectedValueOnce(new Error("401"));
		await expect(AudioStreams.url("42")).resolves.toBeUndefined();
	});

	test("status queries native audioStreamsStatus only when a BTS url exists", async () => {
		const status: AudioStreamStatus = { size: 2048, cachedBytes: 1024, complete: false };
		nativeFns.audioStreamsStatus.mockResolvedValue(status);

		await expect(AudioStreams.status("42")).resolves.toBe(status);
		expect(nativeFns.audioStreamsStatus).toHaveBeenCalledWith("https://audio.example/42");

		playbackGet.mockResolvedValueOnce(dash);
		await expect(AudioStreams.status("42")).resolves.toBeUndefined();
		expect(nativeFns.audioStreamsStatus).toHaveBeenCalledTimes(1);
	});

	test("prefetch triggers audioStreamsHover only when a BTS url exists", async () => {
		await AudioStreams.prefetch("42");
		expect(nativeFns.audioStreamsHover).toHaveBeenCalledWith("https://audio.example/42");

		playbackGet.mockResolvedValueOnce(undefined);
		await AudioStreams.prefetch("42");
		expect(nativeFns.audioStreamsHover).toHaveBeenCalledTimes(1);
	});
});

describe("playback window & persistence", () => {
	const elements = [{ mediaItemId: "101" }, { mediaItemId: "102" }, { mediaItemId: "103" }];

	test("debounces transitions by 1s and updates native window with ahead/behind neighbours", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements, currentIndex: 1, actualProductId: "200" });

		runTransition();
		await vi.advanceTimersByTimeAsync(500);
		runTransition();
		await vi.advanceTimersByTimeAsync(999);
		expect(nativeFns.audioStreamsWindow).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(nativeFns.audioStreamsWindow).toHaveBeenCalledTimes(1);
		expect(nativeFns.audioStreamsWindow).toHaveBeenCalledWith(["https://audio.example/103", "https://audio.example/101"]);
		expect(nativeFns.audioStreamsWaitFilled.mock.calls.map(([u]) => u)).toEqual([
			"https://audio.example/200",
			"https://audio.example/103",
			"https://audio.example/101",
		]);
	});

	test("builds Artist/Album/Title [id][.quality].ext path, sanitizing slashes, fallbacks and 200-byte UTF-8 segments", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		playback({ elements: [], currentIndex: -1, actualProductId: "200" });
		nativeFns.audioStreamsWaitFilled.mockResolvedValue(true);

		// Standard lossless track with slash in artist
		const first = fakeMediaItem({ artists: ["AC/DC", "Guest"], album: "Back In Black", title: "Hells Bells" });
		fromId.mockResolvedValueOnce(first.mediaItem);

		await AudioStreams.updateWindow();
		await vi.waitFor(() =>
			expect(nativeFns.persistAudioStream).toHaveBeenCalledWith(
				"https://audio.example/200",
				first.info,
				"AC_DC, Guest/Back In Black/Hells Bells [200].flac",
				first.tags,
			),
		);

		// Lossy HIGH track with missing tags + 240-byte emoji title truncated cleanly at 200 UTF-8 bytes
		nativeFns.persistAudioStream.mockClear();
		const lossyInfo = bts("https://audio.example/201", "HIGH");
		playback({ elements: [], currentIndex: -1, actualProductId: "201" });
		const emojiTitle = "🎵".repeat(60);
		const second = fakeMediaItem({ title: emojiTitle, ext: "m4a", info: lossyInfo });
		fromId.mockResolvedValueOnce(second.mediaItem);

		await AudioStreams.updateWindow();
		await vi.waitFor(() => expect(nativeFns.persistAudioStream).toHaveBeenCalledTimes(1));
		const [, passedInfo, passedPath] = nativeFns.persistAudioStream.mock.calls[0];
		expect(passedInfo).toBe(lossyInfo);
		expect(passedPath).toBe(`Unknown Artist/Unknown Album/${"🎵".repeat(50)} [201].high.m4a`);
	});

	test("calls persistAudioStream(url) to release live buffer pin when MediaItem is unavailable", async () => {
		playback({ elements: [], currentIndex: -1, actualProductId: "200" });
		nativeFns.audioStreamsWaitFilled.mockResolvedValue(true);
		fromId.mockResolvedValue(undefined);

		await AudioStreams.updateWindow();
		await vi.waitFor(() => expect(nativeFns.persistAudioStream).toHaveBeenCalledWith("https://audio.example/200"));
	});
});

describe("hover listener", () => {
	test("debounces row pointerover by 100ms and ignores repeated or trackless rows", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const first = row("77");
		const second = row("78");
		const plain = row();

		pointerOver(first);
		await vi.advanceTimersByTimeAsync(99);
		expect(nativeFns.audioStreamsHover).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		pointerOver(first);
		await vi.advanceTimersByTimeAsync(100);
		expect(nativeFns.audioStreamsHover).toHaveBeenCalledTimes(1);

		pointerOver(second);
		await vi.advanceTimersByTimeAsync(100);
		pointerOver(plain);
		await vi.advanceTimersByTimeAsync(100);

		expect(nativeFns.audioStreamsHover.mock.calls).toEqual([["https://audio.example/77"], ["https://audio.example/78"]]);
	});
});
