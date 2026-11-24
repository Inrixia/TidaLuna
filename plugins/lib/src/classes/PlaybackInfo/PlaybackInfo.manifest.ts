import { parseDashManifest } from "../../helpers/parseDashManifest";
import type { PlaybackInfoResponse, VideoPlaybackInfoResponse } from "../TidalApi";
import type { HlsManifest, TidalManifest, TrackPlaybackInfo, VideoPlaybackInfo } from "./PlaybackInfo.types";

/** Decodes a track's playbackinfo response: its base64 manifest is BTS json or DASH xml */
export const decodePlaybackInfo = async (response: PlaybackInfoResponse): Promise<TrackPlaybackInfo> => {
	switch (response.manifestMimeType) {
		case "application/vnd.tidal.bts": {
			const manifest: TidalManifest = JSON.parse(atob(response.manifest));
			return { ...response, manifestMimeType: response.manifestMimeType, manifest, mimeType: manifest.mimeType };
		}
		case "application/dash+xml": {
			const manifest = parseDashManifest(atob(response.manifest), "https://sp-ad-cf.audio.tidal.com");
			return { ...response, manifestMimeType: response.manifestMimeType, manifest, mimeType: "audio/mp4" };
		}
		default: {
			throw new Error(`Unsupported Stream Info manifest mime type: ${response.manifestMimeType}`);
		}
	}
};

/** Decodes a video's playbackinfo response: its base64 manifest is json listing HLS urls */
export const decodeVideoPlaybackInfo = (response: VideoPlaybackInfoResponse): VideoPlaybackInfo => {
	if (response.manifestMimeType !== "application/vnd.tidal.emu") {
		throw new Error(`Unsupported Video Stream Info manifest mime type: ${response.manifestMimeType}`);
	}
	const manifest: HlsManifest = JSON.parse(atob(response.manifest));
	return { ...response, manifest, mimeType: "video/mp4" };
};

/** The extension of the file `MediaItem.download` writes of a track's stream */
export const extensionOf = (info: TrackPlaybackInfo): string => {
	switch (info.manifestMimeType) {
		case "application/dash+xml":
			// Lossless DASH streams carry FLAC in MP4, which is remuxed into a native FLAC file
			return info.manifest.tracks.audios[0]?.codec === "FLAC" ? "flac" : "m4a";
		case "application/vnd.tidal.bts":
			return info.manifest.mimeType === "audio/mp4" ? "m4a" : "flac";
		default: {
			const unsupported: never = info;
			throw new Error(`Unsupported Stream Info manifest mime type: ${(unsupported as TrackPlaybackInfo).manifestMimeType}`);
		}
	}
};
