import { asyncDebounce } from "@inrixia/helpers";
import { store as obyStore } from "oby";

import type { LunaUnload, LunaUnloads } from "@luna/core";

import { playbackFormats, playbackInfos } from "../../caches";
import { libTrace } from "../../index.safe";
import type * as redux from "../../redux";
import { getStreamBytes, parseStreamFormat } from "../MediaItem/parseStreamFormat.native";
import { TidalApi, type VideoQuality } from "../TidalApi";
import { decodePlaybackInfo, decodeVideoPlaybackInfo, extensionOf } from "./PlaybackInfo.manifest";
import type { MediaFormat, TrackPlaybackInfo, VideoPlaybackInfo } from "./PlaybackInfo.types";

/**
 * A track's stream at one quality: its playback info (the manifest of TIDAL's playbackinfo request) and its format, kept across restarts.
 * `MediaItem.playback` gives one per quality. What it knows is in the static caches by item and quality, so every one of a stream shares it
 */
export class PlaybackInfo {
	private static readonly trace = libTrace.withSource(".PlaybackInfo").trace;

	// The caches are built in caches.ts: decoded infos (the raw responses are `TidalApi`'s, shared with TIDAL's player) and formats (oby stores)
	private static readonly infos = playbackInfos;
	private static readonly formats = playbackFormats;

	/** A track's decoded playback info at `audioQuality`. Calls in flight share one request */
	public static get(trackId: redux.ItemId, audioQuality: redux.AudioQuality): Promise<TrackPlaybackInfo | undefined> {
		const key = `${trackId}:${audioQuality}`;
		const cached = this.infos.get(key);
		if (cached !== undefined) return cached;
		const info = TidalApi.playbackInfo(trackId, audioQuality).then((response) => response && decodePlaybackInfo(response));
		// A rejection drops it once sized
		this.infos.set(key, info).catch(this.trace.err.withContext("get", key));
		return info;
	}
	/** A video's decoded playback info, not cached: a download reads it once */
	public static async video(videoId: redux.ItemId, videoQuality?: VideoQuality): Promise<VideoPlaybackInfo | undefined> {
		const response = await TidalApi.videoPlaybackInfo(videoId, videoQuality);
		return response && decodeVideoPlaybackInfo(response);
	}

	public readonly key: string;
	public constructor(
		public readonly trackId: redux.ItemId,
		public readonly audioQuality: redux.AudioQuality,
		/** The track's duration in seconds, for its bitrate when the stream doesn't say */
		private readonly duration?: number,
	) {
		this.key = `${trackId}:${audioQuality}`;
	}

	/** The decoded playback info. Not memoized: the cache drops it before its manifest urls expire */
	public async info(): Promise<TrackPlaybackInfo | undefined> {
		const [info, format] = await Promise.all([PlaybackInfo.get(this.trackId, this.audioQuality), this.format()]);
		if (info === undefined) return;
		// An oby store skips writing an equal value, so only a change is saved and heard
		format.bitDepth = info.bitDepth;
		format.sampleRate = info.sampleRate;
		format.audioQuality = info.audioQuality;
		return info;
	}
	/** The extension of the file `MediaItem.download` writes of this stream */
	public async fileExtension(): Promise<string> {
		const info = await this.info();
		if (info === undefined) throw new Error(`Track ${this.trackId} is not available`);
		return extensionOf(info);
	}

	/** What is known of the stream's format. An oby store: changes to it are saved and heard by `withFormat` */
	public format(): Promise<MediaFormat> {
		const held = PlaybackInfo.formats.get(this.key);
		return held === undefined ? PlaybackInfo.loadFormat(this.key) : Promise.resolve(held);
	}
	/** The format of `key` from persist, else a new empty one. Callers for a key share one, and never reject: a failure gives an unsaved format */
	private static readonly loadFormat = asyncDebounce(async (key: string): Promise<MediaFormat> => {
		try {
			const read = await PlaybackInfo.formats.read(key);
			if (read !== undefined) return read;
			await PlaybackInfo.formats.set(key, {});
			// Held in memory now, as the oby store every caller shares
			return PlaybackInfo.formats.get(key) ?? obyStore<MediaFormat>({});
		} catch (err) {
			PlaybackInfo.trace.err.withContext("format", key)(err);
			return obyStore<MediaFormat>({});
		}
	});
	/** Calls `listener` with the format now if any of it is known, then whenever it changes, until unloaded */
	public withFormat(unloads: LunaUnloads, listener: (format: MediaFormat) => void): LunaUnload {
		let stopListening: (() => void) | undefined;
		let unloaded = false;
		const unload = () => {
			unloaded = true;
			stopListening?.();
			unloads.delete(unload);
		};
		unloads.add(unload);
		const call = (format: MediaFormat) => {
			try {
				listener(format);
			} catch (err) {
				PlaybackInfo.trace.err.withContext("withFormat", this.key)(err);
			}
		};
		this.format()
			.then((format) => {
				if (unloaded) return;
				stopListening = obyStore.on(format, () => call(format));
				if (Object.keys(format).length !== 0) call(format);
			})
			.catch(PlaybackInfo.trace.err.withContext("withFormat", this.key));
		return unload;
	}
	/** Fills in the format from the stream itself where the playback info lacks it, `force` reads it again. Calls for a stream share one */
	public updateFormat(force?: true): Promise<MediaFormat | undefined> {
		return PlaybackInfo.readFormat(this.trackId, this.audioQuality, this.duration, force === true);
	}
	// Static over the stream's values so every PlaybackInfo of the stream shares the one in flight
	private static readonly readFormat = asyncDebounce(
		async (
			trackId: redux.ItemId,
			audioQuality: redux.AudioQuality,
			duration: number | undefined,
			force: boolean,
		): Promise<MediaFormat | undefined> => {
			const playback = new PlaybackInfo(trackId, audioQuality, duration);
			const format = await playback.format();
			if (format.bitrate !== undefined && format.sampleRate !== undefined && !force) return format;

			const info = await playback.info();
			if (info === undefined) return undefined;
			format.duration = duration;

			if (format.bitDepth === undefined || format.sampleRate === undefined || format.duration === undefined || format.bytes === undefined) {
				const { format: streamFormat, bytes } = await parseStreamFormat(info);
				format.bytes = bytes;
				format.bitDepth = streamFormat.bitsPerSample || format.bitDepth;
				format.sampleRate = streamFormat.sampleRate || format.sampleRate;
				format.duration = streamFormat.duration ?? format.duration;
				format.codec = streamFormat.codec?.toLowerCase() ?? format.codec;
				// Complement with DASH manifest data if available
				if (info.manifestMimeType === "application/dash+xml") {
					format.bitrate = info.manifest.tracks.audios[0].bitrate.bps ?? format.bitrate;
					format.bytes = info.manifest.tracks.audios[0].size?.b ?? format.bytes;
				}
			} else {
				format.bytes = (await getStreamBytes(info)) ?? format.bytes;
			}

			format.bitrate ??= !!format.bytes && !!format.duration ? (format.bytes / format.duration) * 8 : undefined;

			// Also known at the quality the stream is at (e.g. Atmos/Sony360 tracks fall back to another quality)
			if (info.audioQuality !== audioQuality) Object.assign(await new PlaybackInfo(trackId, info.audioQuality).format(), obyStore.unwrap(format));
			return format;
		},
	);
}
