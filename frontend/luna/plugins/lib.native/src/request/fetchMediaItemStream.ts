import type { PlaybackInfo } from "@luna/lib";
import { Readable } from "stream";

import { makeDecipher } from "./decrypt";
import { fetchStream, type TrackStreamOptions } from "./fetchStream";

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
// Lock to 2 concurrent streams
const fetchMediaItemStremaSemaphore = new Semaphore(2);
export const fetchMediaItemStream = ({ manifestMimeType, manifest }: PlaybackInfo, options: FetchOptions = {}): Promise<Readable> =>
	fetchMediaItemStremaSemaphore.with(async () => {
		switch (manifestMimeType) {
			case "application/vnd.tidal.bts": {
				options.decipher = makeDecipher(manifest);
				const stream = Readable.from(fetchStream(manifest.urls, options), { objectMode: false });
				if (options.tags === undefined) return stream;

				const { tags, coverUrl } = options.tags;
				let picture;
				if (coverUrl !== undefined) {
					picture = await fetch(coverUrl)
						.then(rejectNotOk)
						.then(toArrayBuffer)
						.then((arrayBuffer) => ({
							pictureType: PictureType.FrontCover,
							buffer: Buffer.from(arrayBuffer),
						}))
						.catch(() => undefined);
				}
				return stream.pipe(
					new FlacStreamTagger({
						tagMap: tags,
						picture,
					}),
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
			default: {
				throw new Error(`Unsupported Stream Info manifest mime type: ${manifestMimeType}`);
			}
		}
	});
