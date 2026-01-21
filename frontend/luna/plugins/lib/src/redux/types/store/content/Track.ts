import type { MediaItemBase } from "./BaseMediaItem";

export type AudioMode = "STEREO" | "DOLBY_ATMOS" | "SONY_360RA";
export type AudioQuality = "HI_RES_LOSSLESS" | "HI_RES" | "LOSSLESS" | "HIGH" | "LOW";
export type MediaMetadataTag = "LOSSLESS" | "SONY_360RA" | "DOLBY_ATMOS" | "HIRES_LOSSLESS" | "MQA";

export interface Track extends MediaItemBase {
	contentType: "track";

	url: `http://www.tidal.com/track/${string}`;

	replayGain: number;
	peak: number;

	editable: false;

	audioQuality: AudioQuality;
	audioModes: AudioMode[];
	mediaMetadata: {
		tags: MediaMetadataTag[];
	};

	bpm?: number | null;
	isrc?: string | null;
	copyright?: string | null;

	upload: false;
}
