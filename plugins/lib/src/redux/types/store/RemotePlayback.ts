import type { ItemId } from ".";
import type { AudioMode, AudioQuality } from "./content";

// #endregion
// #region RemotePlayback
export type RemotePlaybackDeviceType = "chromeCast" | "tidalConnect" | "cloudConnect";
export type RemotePlaybackDevice = {
	/** @example 127.0.0.1 */
	addresses: string[];
	friendlyName: string;
	/** @example `${string}._googlecast._tcp.local` */
	fullname: string;
	id: string;
	port: number;
	type: RemotePlaybackDeviceType;
};
export type RemotePlayerStates = "BUFFERING" | "IDLE" | "PAUSED" | "PLAYING";
export interface TidalConnectQueueInfo {
	maxAfterSize: number;
	maxBeforeSize: number;
	queueId: string;
	repeatMode: unknown;
	shuffled: boolean;
}
export interface TidalConnectMediaInfo {
	customData: {
		audioMode: AudioMode;
		audioQuality: AudioQuality;
	};
	itemId: string;
	mediaId: string;
	metadata: {
		albumName: string;
		artists: ItemId[];
		duration: number;
		images: unknown;
		title: string;
	};
}
export interface RemotePlayback {
	connectedDevice: unknown;
	deviceToConnectTo: unknown;
	devices: {
		chromeCast: RemotePlaybackDevice[];
		cloudConnect: RemotePlaybackDevice[];
		tidalConnect: RemotePlaybackDevice[];
	};
	isConnected: boolean;
	remotePlaybackReceiverState: number;
	session: unknown;
	sessionStatus: "nosession";
}
