import type { ItemId } from "../store";

export type MediaCollectionContextType =
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
	| "UNKNOWN"
	| "user";

export interface MediaCollectionContext {
	id?: ItemId | null;
	playQueueItemsLimit?: number | null;
	transient?: boolean;
	type: MediaCollectionContextType;
}
