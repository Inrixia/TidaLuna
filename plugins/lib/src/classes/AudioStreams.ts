import {
	audioStreamsHover,
	audioStreamsStatus,
	audioStreamsWaitFilled,
	audioStreamsWindow,
	persistAudioStream,
	type AudioStreamStatus,
} from "../../../lib.native/src/index.native";

import { asyncDebounce, Semaphore } from "@inrixia/helpers";
import { ReactiveStore, type LunaUnload } from "@luna/core";

import { safeTimeout } from "../helpers/safeTimeout";
import { libTrace, unloads } from "../index.safe";
import * as redux from "../redux";
import { MediaItem } from "./MediaItem";
import { PlayState } from "./PlayState";
import { PlaybackInfo } from "./PlaybackInfo";
import { Quality } from "./Quality";

export type { AudioStreamStatus };

const settings = await ReactiveStore.getPluginStorage("@luna/lib.AudioStreams", { ahead: 1, behind: 1 });

const encoder = new TextEncoder();
/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character */
const fitBytes = (text: string, maxBytes: number): string => {
	if (encoder.encode(text).length <= maxBytes) return text;
	let out = "";
	for (const char of text) {
		if (encoder.encode(out + char).length > maxBytes) break;
		out += char;
	}
	return out;
};

/** Keeps a path segment on one directory level, non-empty and within 200 UTF-8 bytes so suffix + extension fit in 255 bytes */
const cleanSegment = (text: string | undefined, fallback: string, maxBytes = 200): string => {
	const cleaned = fitBytes((text ?? "").replace(/[\\/]/g, "_").replace(/^\.+$/, "").trim(), maxBytes);
	return cleaned || fallback;
};

/**
 * Renderer coordinator for main-process `AudioStreams` (`native/AudioStreams`). Maps track ids to BTS audio urls, drives the queue prefetch
 * window (`ahead` / `behind`) and row hover heads, and once a wanted track fills its live buffer, streams it decrypted + tagged into the
 * tiered `audio` cache under `Artist/Album/Title [trackId][.quality].<ext>`. Cache limits and stats live on `NativeCache` (`native:audio`).
 */
export class AudioStreams {
	private static readonly trace = libTrace.withSource(".AudioStreams").trace;
	/** How many tracks `ahead` of and `behind` the playing one in the queue are fetched in the background, kept across restarts */
	public static readonly settings = settings;

	/** The url of a track's BTS audio at `quality` (TIDAL's streaming quality by default), `undefined` for DASH or unavailable tracks */
	public static async url(trackId: redux.ItemId, quality = PlayState.streamingQuality): Promise<string | undefined> {
		const info = await PlaybackInfo.get(trackId, quality).catch(() => undefined);
		if (info?.manifestMimeType === "application/vnd.tidal.bts") return info.manifest.urls[0];
	}
	/** How much of a track's audio is cached or buffered live */
	public static async status(trackId: redux.ItemId): Promise<AudioStreamStatus | undefined> {
		const url = await this.url(trackId);
		if (url !== undefined) return audioStreamsStatus(url);
	}
	/** Prefetches the start of a track's audio ahead of everything except the playing track */
	public static async prefetch(trackId: redux.ItemId): Promise<void> {
		const url = await this.url(trackId);
		if (url !== undefined) await audioStreamsHover(url);
	}

	// Decrypting, tagging and writing a whole track runs one at a time, with the playing track first
	private static readonly persistSemaphore = new Semaphore(1);
	/**
	 * Waits for a track's live audio buffer to fill, then streams it decrypted and tagged into `audio` cache.
	 * Logs errors instead of rejecting: `asyncDebounce` leaves rejections of its shared promise unhandled
	 */
	private static readonly persist = asyncDebounce(async (trackId: redux.ItemId, url: string, quality: redux.AudioQuality): Promise<void> => {
		try {
			if (!(await audioStreamsWaitFilled(url))) return;
			const write = () => this.write(trackId, url, quality);
			if (String(trackId) === String(PlayState.currentId)) return await this.persistSemaphore.withFirst(write);
			return await this.persistSemaphore.with(write);
		} catch (err) {
			this.trace.err.withContext("persist", trackId)(err);
		}
	});
	private static async write(trackId: redux.ItemId, url: string, quality: redux.AudioQuality): Promise<void> {
		let handedOff = false;
		try {
			const mediaItem = await MediaItem.fromId(trackId);
			if (mediaItem === undefined) return;
			const [title, artists, albumItem, ext, info, tags] = await Promise.all([
				mediaItem.title(),
				MediaItem.artistNames(mediaItem.artists()),
				mediaItem.album(),
				mediaItem.fileExtension(quality),
				mediaItem.playbackInfo(quality),
				mediaItem.flacTags(),
			]);
			if (info === undefined) return;
			const albumTitle = (await albumItem?.title()) ?? mediaItem.tidalItem.album?.title;
			const artist = cleanSegment(artists.join(", "), "Unknown Artist");
			const album = cleanSegment(albumTitle, "Unknown Album");
			// Lossy streams carry their quality (.high, .low), lossless ones don't
			const actual = Quality.fromAudioQuality(info.audioQuality ?? quality);
			const qualitySuffix = actual !== undefined && actual < Quality.High ? `.${actual.audioQuality.toLowerCase()}` : "";
			const fileName = `${cleanSegment(title, String(trackId))} [${trackId}]${qualitySuffix}.${ext}`;
			handedOff = true;
			await persistAudioStream(url, info, `${artist}/${album}/${fileName}`, tags);
		} finally {
			if (!handedOff) await persistAudioStream(url);
		}
	}

	/** Updates the background prefetch window (`settings.ahead`, `settings.behind`) and schedules persistence for current + window tracks */
	public static async updateWindow(): Promise<void> {
		const quality = PlayState.streamingQuality;
		const currentId = PlayState.currentId;
		const windowIds = PlayState.queueWindow(settings.ahead, settings.behind);
		const [currentUrl, ...windowUrls] = await Promise.all(
			[currentId, ...windowIds].map((id) => (id === undefined ? undefined : this.url(id, quality))),
		);
		await audioStreamsWindow(windowUrls.filter((url) => url !== undefined));
		[currentId, ...windowIds].forEach((id, index) => {
			const url = index === 0 ? currentUrl : windowUrls[index - 1];
			if (id !== undefined && url !== undefined) void this.persist(id, url, quality);
		});
	}

	private static cancelUpdate?: LunaUnload;
	/** `updateWindow` a second after the last call, debouncing rapid track skips or window-size edits. Cancelled on unload */
	public static updateWindowSoon() {
		this.cancelUpdate?.();
		this.cancelUpdate = safeTimeout(unloads, () => this.updateWindow().catch(this.trace.err.withContext("window")), 1000);
	}

	static {
		redux.intercept("playbackControls/MEDIA_PRODUCT_TRANSITION", unloads, () => this.updateWindowSoon());
		MediaItem.onHover(unloads, (id) => this.prefetch(id).catch(this.trace.warn.withContext("prefetch")));
	}
}
