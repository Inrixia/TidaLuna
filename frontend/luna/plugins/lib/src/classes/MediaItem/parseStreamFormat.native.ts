import { parseStream, type IAudioMetadata } from "music-metadata";

import { fetchMediaItemStream, type FetchProgress } from "@luna/lib.native";

import type { PlaybackInfo } from "../../helpers";

export const parseStreamFormat = async (playbackInfo: PlaybackInfo): Promise<{ format: IAudioMetadata["format"]; bytes?: number }> => {
	const progress: FetchProgress = {};
	const isDash = playbackInfo.manifestMimeType === "application/dash+xml";
	// For DASH, only fetch init segment (contains metadata without media data)
	// For BTS/FLAC, fetch first 8KB which contains all metadata
	const stream = await fetchMediaItemStream(playbackInfo, {
		bytesWanted: isDash ? undefined : 8192,
		initSegmentOnly: isDash,
		progress,
	});
	const mimeType = isDash ? "audio/mp4" : playbackInfo.manifest.mimeType;
	const { format } = await parseStream(stream, { mimeType });
	return { format, bytes: progress.total };
};
export const getStreamBytes = async (playbackInfo: PlaybackInfo): Promise<any> => {
	const progress: FetchProgress = {};
	const stream = await fetchMediaItemStream(playbackInfo, { progress, reqInit: { method: "HEAD" } });
	// Consume the entire stream to ensure we get the total bytes
	for await (const _ of stream) {
	}
	return progress.total;
};
