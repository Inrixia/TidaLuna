import type { ContentType, ItemId } from ".";

// #region PlayQueue
export interface PlayQueueContext {
	id?: ItemId | null;
	playQueueItemsLimit?: number | null;
	type: PlayQueueSourceType;
}

export type PlayQueueSourceType =
	| "active"
	| "album"
	| "artist"
	| "credits"
	| "FEED"
	| "mix"
	| "MY_TRACKS"
	| "MY_VIDEOS"
	| "playlist"
	| "search"
	| "suggestedItemsForPlaylist"
	| "suggestions"
	| "trackList"
	| "UNKNOWN"
	| "user";
export type PlayQueuePriority = "priority_history" | "priority_keep" | "priority_none";

export interface PlayQueueElement {
	context: PlayQueueContext;
	mediaItemId: ItemId;
	priority: PlayQueuePriority;
	uid: string;
}

export type PlayQueuePosition = number | "last" | "next" | "now";

export enum RepeatMode {
	Off = 0,
	All = 1,
	One = 2,
}

export interface PlayQueue {
	backupElements: PlayQueueElement[];
	backupSource: PlayQueueElement[];
	currentIndex: number;
	elements: PlayQueueElement[];
	lastShuffleSeed: number;
	originalSource: PlayQueueElement[];
	repeatMode: RepeatMode;
	shuffleModeEnabled: boolean;
	sourceEntityId: string;
	sourceEntityType: string;
	sourceName: string;
	sourceTrackListName: string;
	sourceUrl: string;
	type: string;
	uniqueIdCounter: number;
}
// #endregion

// #region CloudQueue
export type CloudQueueAddItemMode = "append" | "prepend";
export interface CloudQueueItem {
	id: string;
	media_id: string;
	properties: {
		active: "false" | "true";
		original_order: string;
		sourceId?: number | string | null;
		sourceType: PlayQueueSourceType;
	};
	type: ContentType;
}
export interface CloudQueue {
	currentItemId: string;
	etag: string;
	headPosition: number;
	historyMediaItemIds: unknown[];
	itemsEtag: string;
	properties: null;
	queueId: string;
	repeatMode: RepeatMode;
	shuffled: boolean;
	tailItemId: string;
	tailPosition: number;
}
// #endregion
