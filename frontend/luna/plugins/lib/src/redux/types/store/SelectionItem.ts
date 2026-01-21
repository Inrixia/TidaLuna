import type { ItemId } from ".";

export type ItemType =
	| "album"
	| "article"
	| "artist"
	| "contributor"
	| "folder"
	| "folderPlaylist"
	| "genre"
	| "mix"
	| "playlist"
	| "search"
	| "track"
	| "user"
	| "userProfile"
	| "userPublicPlaylist"
	| "video";
export interface SelectionItem {
	itemId: ItemId;
	itemType: ItemType;
	index: number;
}

export type SelectionItems = SelectionItem[];
export type SelectionState = {
	indices: number[];
	isDragging: boolean;
	items: SelectionItems;
	loadedFolders: string[];
	openFolders: string[];
};
