import {
	audioCacheHover,
	audioCacheOpenFolder,
	audioCachePersist,
	audioCacheSetLimit,
	audioCacheStats,
	audioCacheStatus,
	audioCacheWaitFilled,
	audioCacheWindow,
	type AudioCacheStats,
	type AudioCacheStatus,
} from "../../../lib.native/src/index.native";

import { ReactiveStore } from "@luna/core";

import { getPlaybackInfo } from "../helpers/getPlaybackInfo";
import { safeTimeout } from "../helpers/safeTimeout";
import { libTrace, unloads } from "../index.safe";
import * as redux from "../redux";
import { MediaItem } from "./MediaItem";
import { PlayState } from "./PlayState";

export type { AudioCacheStats, AudioCacheStatus };

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

/**
 * The cache TIDAL's native player plays audio from, see native/audioCache.ts. It holds the audio of tracks played, hovered, next and previous
 * in the queue, and of every `MediaItem` read (downloads, formats). Only tracks the native player plays (BTS manifests), DASH plays in the page.
 */
export class AudioCache {
	private static readonly trace = libTrace.withSource("AudioCache").trace;
	private static readonly persisting = new Set<string>();

	/** The url of a track's audio at the streaming quality, the url TIDAL's player plays */
	public static async url(trackId: redux.ItemId): Promise<string | undefined> {
		const info = await getPlaybackInfo(trackId, redux.store.getState().settings.quality.streaming).catch(() => undefined);
		if (info?.manifestMimeType === "application/vnd.tidal.bts") return info.manifest.urls[0];
	}
	/** How much of a track's audio is cached */
	public static async status(trackId: redux.ItemId): Promise<AudioCacheStatus | undefined> {
		const url = await this.url(trackId);
		if (url !== undefined) return audioCacheStatus(url);
	}
	/** Fetches what a track needs to start playing at once, ahead of everything but the playing track. The latest call goes first */
	public static async prefetch(trackId: redux.ItemId): Promise<void> {
		const url = await this.url(trackId);
		if (url !== undefined) await audioCacheHover(url);
	}
	/** Waits for a track's audio to finish filling in memory, then persists it to disk decrypted and tagged via `MediaItem.download` */
	private static async persist(trackId: redux.ItemId, url: string): Promise<void> {
		if (this.persisting.has(url)) return;
		this.persisting.add(url);
		try {
			const dir = await audioCacheWaitFilled(url);
			if (dir === undefined) return;
			let filePath: string | undefined;
			try {
				const mediaItem = await MediaItem.fromId(trackId);
				if (mediaItem === undefined) return;
				const quality = redux.store.getState().settings.quality.streaming;
				const [{ tags }, ext] = await Promise.all([mediaItem.flacTags(), mediaItem.fileExtension(quality)]);
				const artist = tags.artist?.join(", ") || "Unknown Artist";
				const title = tags.title || String(trackId);
				// The track id keeps names unique: download skips a path that already exists, so two tracks with the same artist and title would share one file.
				// File names are cut to 255 bytes from the end, so the name is shortened first to keep the id and extension
				filePath = await mediaItem.download([dir, `${fitBytes(`${artist} - ${title}`, 200)} [${trackId}].${ext}`], quality);
			} finally {
				await audioCachePersist(url, filePath);
			}
		} finally {
			this.persisting.delete(url);
		}
	}
	public static stats(): Promise<AudioCacheStats> {
		return audioCacheStats();
	}
	/** 0 for the default */
	private static readonly storage: Promise<{ limitBytes: number }> = ReactiveStore.getPluginStorage("@luna/lib.AudioCache", { limitBytes: 0 });
	/** Bytes the cache may use, kept across restarts. 0 for the default of 128GB. It never uses more than 75% of free disk space */
	public static async setLimit(bytes: number): Promise<void> {
		(await this.storage).limitBytes = bytes;
		return audioCacheSetLimit(bytes || undefined);
	}
	public static openFolder(): Promise<string> {
		return audioCacheOpenFolder();
	}

	static {
		this.storage.then(({ limitBytes }) => (limitBytes ? audioCacheSetLimit(limitBytes) : undefined)).catch(this.trace.err.withContext("limit"));

		// The current, next and previous track are fetched in the background and persisted to disk once filled,
		// debounced as skipping through tracks shouldn't fetch each
		let cancelWindow: (() => void) | undefined;
		const updateWindow = async () => {
			const { elements, currentIndex } = PlayState.playQueue;
			const currentId = PlayState.playbackContext?.actualProductId ?? elements[currentIndex]?.mediaItemId;
			const windowIds = [currentIndex + 1, currentIndex - 1].map((index) => elements[index]?.mediaItemId);
			const [currentUrl, ...windowUrls] = await Promise.all([currentId, ...windowIds].map((id) => (id === undefined ? undefined : this.url(id))));
			await audioCacheWindow(windowUrls.filter((url) => url !== undefined));
			for (const [id, url] of <const>[
				[currentId, currentUrl],
				[windowIds[0], windowUrls[0]],
				[windowIds[1], windowUrls[1]],
			]) {
				if (id !== undefined && url !== undefined) this.persist(id, url).catch(this.trace.err.withContext("persist", id));
			}
		};
		redux.intercept("playbackControls/MEDIA_PRODUCT_TRANSITION", unloads, () => {
			cancelWindow?.();
			cancelWindow = safeTimeout(unloads, () => updateWindow().catch(this.trace.err.withContext("window")), 1000);
		});

		// Hovered tracks are fetched so they start at once when played, rows have data-track-id
		let hoveredId: string | null = null;
		let cancelHover: (() => void) | undefined;
		const onPointerOver = (event: PointerEvent) => {
			const id = (<Element>event.target).closest?.("[data-track-id]")?.getAttribute("data-track-id") ?? null;
			if (id === hoveredId) return;
			hoveredId = id;
			cancelHover?.();
			if (id !== null) cancelHover = safeTimeout(unloads, () => this.prefetch(id).catch(this.trace.warn.withContext("prefetch")), 100);
		};
		document.addEventListener("pointerover", onPointerOver, { passive: true });
		unloads.add(() => document.removeEventListener("pointerover", onPointerOver));
	}
}
