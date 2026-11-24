import type { DashManifest } from "../../helpers/parseDashManifest";
import type { AudioQuality } from "../../redux";
import type { PlaybackInfoResponse, VideoPlaybackInfoResponse } from "../TidalApi";

export type TidalManifest = {
	mimeType: string;
	codecs: string;
	encryptionType: string;
	keyId: string;
	urls: string[];
};
interface TrackPlaybackInfoBase extends Omit<PlaybackInfoResponse, "manifest"> {
	mimeType: string;
}
interface BtsPlaybackInfo extends TrackPlaybackInfoBase {
	manifestMimeType: "application/vnd.tidal.bts";
	manifest: TidalManifest;
}
interface DashPlaybackInfo extends TrackPlaybackInfoBase {
	manifestMimeType: "application/dash+xml";
	manifest: DashManifest;
}
/** A track's playback info with its manifest decoded. BTS streams play in TIDAL's native player, DASH in the page */
export type TrackPlaybackInfo = DashPlaybackInfo | BtsPlaybackInfo;

export type HlsManifest = {
	mimeType: string;
	urls: string[];
};
/** A video's playback info with its manifest decoded */
export interface VideoPlaybackInfo extends Omit<VideoPlaybackInfoResponse, "manifest"> {
	manifest: HlsManifest;
	mimeType: string;
}

/** A stream's format, as far as it is known */
export type MediaFormat = {
	bitDepth?: number;
	sampleRate?: number;
	codec?: string;
	duration?: number;
	bytes?: number;
	bitrate?: number;
	/** The quality the stream is at, lower than the one asked for when the track has no better (e.g. a spatial only track asked for at hi-res) */
	audioQuality?: AudioQuality;
};
