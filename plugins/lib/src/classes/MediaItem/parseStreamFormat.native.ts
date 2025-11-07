import { parseStream, type IAudioMetadata } from "music-metadata";

import { fetchMediaItemStream, type FetchProgress } from "@luna/lib.native";

import type { PlaybackInfo } from "../../helpers";

export const parseStreamFormat = async (playbackInfo: PlaybackInfo): Promise<{ format: IAudioMetadata["format"]; bytes?: number }> => {
	const progress: FetchProgress = {};
	// note that you cannot trust bytes to be populated until the stream is finished. parseStream will read the entire stream ensuring this
	const stream = await fetchMediaItemStream(playbackInfo, { bytesWanted: 8192, progress });
	const mimeType = playbackInfo.manifestMimeType === "application/vnd.tidal.bts" ? playbackInfo.manifest.mimeType : "audio/mp4";
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
