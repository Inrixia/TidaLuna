import type { TrackPlaybackInfo, VideoPlaybackInfo } from "@luna/lib";
import { Readable } from "stream";

import { audioStreamsStore } from "../native";
import { makeDecipher } from "./decrypt";
import { fetchStream, type TrackStreamOptions } from "./fetchStream";
import { fetchTidal } from "./guards";
import { tagStream, type StreamTags } from "./tagStream";

import { rejectNotOk, Semaphore } from "@inrixia/helpers";

interface FetchOptions extends Omit<TrackStreamOptions, "deciper"> {
	tags?: StreamTags;
	/** For DASH streams, only fetch the init segment (for metadata parsing) */
	initSegmentOnly?: boolean;
}

export { FetchProgress } from "./fetchStream";

const fetchLines = async (url: string) => {
	const text = await (await fetchTidal(url).then(rejectNotOk)).text();
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
};

/** Resolves a HLS playlist to the segment urls of its highest bandwidth variant */
const hlsSegmentUrls = async (playlistUrl: string): Promise<string[]> => {
	let lines = await fetchLines(playlistUrl);
	// Master playlist, pick the variant with the highest bandwidth
	if (lines.some((line) => line.startsWith("#EXT-X-STREAM-INF"))) {
		let best: { bandwidth: number; url: string } | undefined;
		for (let i = 0; i < lines.length - 1; i++) {
			if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
			const bandwidth = parseInt(/[:,]BANDWIDTH=(\d+)/.exec(lines[i])?.[1] ?? "0", 10);
			if (best === undefined || bandwidth > best.bandwidth) best = { bandwidth, url: new URL(lines[i + 1], playlistUrl).href };
		}
		if (best === undefined) throw new Error("HLS master playlist has no variants");
		playlistUrl = best.url;
		lines = await fetchLines(playlistUrl);
	}
	if (lines.some((line) => line.startsWith("#EXT-X-KEY") && !line.includes("METHOD=NONE")))
		throw new Error("Encrypted HLS streams are not supported");
	return lines.filter((line) => !line.startsWith("#")).map((line) => new URL(line, playlistUrl).href);
};

// Lock to 2 concurrent streams
const fetchMediaItemStremaSemaphore = new Semaphore(2);
export const fetchMediaItemStream = (
	{ manifestMimeType, manifest }: TrackPlaybackInfo | VideoPlaybackInfo,
	options: FetchOptions = {},
): Promise<Readable> =>
	fetchMediaItemStremaSemaphore.with(async () => {
		switch (manifestMimeType) {
			case "application/vnd.tidal.bts": {
				options.decipher = makeDecipher(manifest);
				const stream = Readable.from(fetchStream(manifest.urls, options), { objectMode: false });
				if (options.tags === undefined) return stream;

				return tagStream(stream, options.tags, manifest.mimeType === "audio/mp4" ? "m4a" : "flac");
			}
			case "application/dash+xml": {
				const trackManifest = manifest.tracks.audios[0];
				const segments = options.initSegmentOnly ? trackManifest.segments.filter((segment) => segment.init) : trackManifest.segments;
				return Readable.from(
					fetchStream(
						segments.map((segment) => segment.url),
						options,
					),
					{ objectMode: false },
				);
			}
			case "application/vnd.tidal.emu": {
				const segmentUrls = await hlsSegmentUrls(manifest.urls[0]);
				return Readable.from(fetchStream(segmentUrls, options), { objectMode: false });
			}
			default: {
				throw new Error(`Unsupported Stream Info manifest mime type: ${manifestMimeType}`);
			}
		}
	});

/**
 * Reads a filled live BTS audio stream once, decrypts and tags it in-flight, and stores it into `AudioStreams.cache`
 * (memory + disk tiers). Releases the live buffer's `persisting` pin even if skipped or failed
 */
export const persistAudioStream = async (
	url: string,
	playbackInfo?: TrackPlaybackInfo,
	relativePath?: string,
	tags?: StreamTags,
): Promise<void> => {
	if (playbackInfo?.manifestMimeType !== "application/vnd.tidal.bts" || !relativePath) {
		await audioStreamsStore(url);
		return;
	}
	let stored = false;
	try {
		const stream = await fetchMediaItemStream(playbackInfo, { tags });
		stored = true;
		await audioStreamsStore(url, <ReadableStream<Uint8Array>>Readable.toWeb(stream), {
			path: relativePath,
			type: playbackInfo.manifest.mimeType,
		});
	} finally {
		if (!stored) await audioStreamsStore(url);
	}
};
