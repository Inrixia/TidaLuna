import type { AudioQuality } from "./content";

export interface AccumulatedPlaybackTime {
	lastPlayingTimestamp: number;
	playbackState: PlaybackState;
	productId: string;
	storedTimes: Record<string, number>;
}

export type PlaybackState = "PLAYING" | "IDLE" | "PAUSED" | "NOT_PLAYING" | "STALLED";
export type Player = "BOOMBOX" | "GOOGLE_CAST" | "REMOTE_PLAYBACK";

export interface PlaybackContext {
	actualAssetPresentation: string;
	actualAudioMode: string;
	actualAudioQuality: AudioQuality;
	actualDuration: number;
	actualProductId: string;
	actualStreamType: string;
	actualVideoQuality: string;
	assetPosition: number;
	bitDepth: number | null;
	codec: string;
	playbackSessionId: string;
	sampleRate: number | null;
}

export interface PlaybackControls {
	desiredPlaybackState: PlaybackState;
	latestCurrentTime: number;
	latestCurrentTimeSyncTimestamp: number;
	mediaProduct: {
		productId: string;
		productType: string;
		referenceId: string;
		sourceId: string;
		sourceType: string;
	};
	muted: boolean;
	playbackContext: PlaybackContext;
	playbackState: PlaybackState;
	prefilled: boolean;
	startAt: number;
	/** @example 0-100 */
	volume: number;
	volumeUnmute: 100;
}
