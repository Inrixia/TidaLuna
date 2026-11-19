import type { redux } from "@luna/lib";

export type PlaybackInfoResponse = {
	trackId: number;
	assetPresentation: string;
	audioMode: redux.AudioMode;
	audioQuality: redux.AudioQuality;
	manifestMimeType: "application/vnd.tidal.bts" | "application/dash+xml";
	manifestHash: string;
	manifest: string;
	albumReplayGain: number;
	albumPeakAmplitude: number;
	trackReplayGain: number;
	trackPeakAmplitude: number;
	bitDepth: number;
	sampleRate: number;
};

export type VideoQuality = "HIGH" | "MEDIUM" | "LOW";
export type VideoPlaybackInfoResponse = {
	videoId: number;
	streamType: string;
	assetPresentation: string;
	videoQuality: VideoQuality;
	manifestMimeType: "application/vnd.tidal.emu";
	manifestHash: string;
	manifest: string;
};
