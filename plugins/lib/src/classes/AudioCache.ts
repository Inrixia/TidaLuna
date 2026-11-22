import {
	audioCacheHover,
	audioCacheOpenFolder,
	audioCacheSetLimit,
	audioCacheStats,
	audioCacheStatus,
	audioCacheWindow,
	type AudioCacheStats,
	type AudioCacheStatus,
} from "../../../lib.native/src/index.native";

import { ReactiveStore } from "@luna/core";

import { getPlaybackInfo } from "../helpers/getPlaybackInfo";
import { safeTimeout } from "../helpers/safeTimeout";
import { libTrace, unloads } from "../index.safe";
import * as redux from "../redux";
import { PlayState } from "./PlayState";

export type { AudioCacheStats, AudioCacheStatus };

/**
 * The cache TIDAL's native player plays audio from, see native/audioCache.ts. It holds the audio of tracks played, hovered, next and previous
 * in the queue, and of every `MediaItem` read (downloads, formats). Only tracks the native player plays (BTS manifests), DASH plays in the page.
 */
export class AudioCache {
	private static readonly trace = libTrace.withSource("AudioCache").trace;

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

		// The next and previous track are fetched in the background, debounced as skipping through tracks shouldn't fetch each
		let cancelWindow: (() => void) | undefined;
		const updateWindow = async () => {
			const { elements, currentIndex } = PlayState.playQueue;
			const ids = [currentIndex + 1, currentIndex - 1].map((index) => elements[index]?.mediaItemId);
			const urls = await Promise.all(ids.map((id) => (id === undefined ? undefined : this.url(id))));
			await audioCacheWindow(urls.filter((url) => url !== undefined));
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
