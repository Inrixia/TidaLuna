import type { PlaybackInfo, VideoPlaybackInfo } from "@luna/lib";
import { pipeline, Readable } from "stream";

import { makeDecipher } from "./decrypt";
import { fetchStream, type TrackStreamOptions } from "./fetchStream";
import { fetchTidal } from "./guards";

import { rejectNotOk, Semaphore, toArrayBuffer } from "@inrixia/helpers";
import { FlacStreamTagger, PictureType } from "flac-stream-tagger";

interface FetchOptions extends Omit<TrackStreamOptions, "deciper"> {
	tags?: {
		tags: Record<string, string[] | string>;
		coverUrl?: string;
	};
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
	{ manifestMimeType, manifest }: PlaybackInfo | VideoPlaybackInfo,
	options: FetchOptions = {},
): Promise<Readable> =>
	fetchMediaItemStremaSemaphore.with(async () => {
		switch (manifestMimeType) {
			case "application/vnd.tidal.bts": {
				options.decipher = makeDecipher(manifest);
				const stream = Readable.from(fetchStream(manifest.urls, options), { objectMode: false });
				if (options.tags === undefined) return stream;

				const { tags, coverUrl } = options.tags;
				let picture;
				if (coverUrl !== undefined) {
					picture = await fetchTidal(coverUrl)
						.then(rejectNotOk)
						.then(toArrayBuffer)
						.then((arrayBuffer) => ({
							pictureType: PictureType.FrontCover,
							buffer: Buffer.from(arrayBuffer),
						}))
						.catch(() => undefined);
				}
				// pipeline forwards source errors to the tagger, pipe() would leave them unhandled
				return pipeline(
					stream,
					new FlacStreamTagger({
						tagMap: tags,
						picture,
					}),
					() => {},
				);
			}
			case "application/dash+xml": {
				const trackManifest = manifest.tracks.audios[0];
				const segments = options.initSegmentOnly
					? trackManifest.segments.filter((segment) => segment.init)
					: trackManifest.segments;
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
