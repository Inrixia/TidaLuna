import type { ItemId } from "../store";
import type { MediaCollectionContext } from "./MediaCollection";

export type ContextMenuLocationContext = "none" | "player" | "playQueue" | "trackCredits" | "trackList";

export interface ContextMenuBase {
	position: [number, number];
	id: ItemId;
}

export interface CommonContextMenu extends ContextMenuBase {
	type:
		| "FOLDER_SORT_ORDER"
		| "MY_ALBUMS_SORT_ORDER"
		| "MY_ARTISTS_SORT_ORDER"
		| "MY_MIXES_SORT_ORDER"
		| "MY_PLAYLISTS_SORT_ORDER"
		| "MY_VIDEOS_SORT_ORDER"
		| "PROFILE_PICTURE_CONTEXT_MENU"
		| "SELECT_SOUND_OUTPUT"
		| "SELECT_SOUND_QUALITY"
		| "SIDEBAR_ADD_NEW"
		| "SIDEBAR_PLAYLISTS_SORT_ORDER"
		| "USER_PROFILE"
		| "ADD_TO"
		| "ALBUM_SHARE"
		| "ALBUM"
		| "ARTIST_SHARE"
		| "ARTIST"
		| "CONTRIBUTOR_SHARE"
		| "MIX_SHARE"
		| "MIX"
		| "PLAYLIST_SHARE"
		| "PLAYLIST"
		| "USER_PROFILE_MORE"
		| "USER_SHARE"
		| "FOLDER";
}

export interface MediaItemContextMenu extends ContextMenuBase {
	canBlock: boolean;
	clearSelection?: () => void;
	contextMenuLocation: ContextMenuLocationContext;
	index?: number;
	sourceContext: MediaCollectionContext;
	type: "MEDIA_ITEM";
}
export interface MultiMediaItemContextMenu extends Omit<ContextMenuBase, "id"> {
	clearSelection?: () => void;
	ids: ItemId[];
	indices?: number[];
	sourceContext: MediaCollectionContext;
	type: "MULTI_MEDIA_ITEM";
}
export interface InputFieldClipboardContextMenu extends ContextMenuBase {
	targetElement?: EventTarget | HTMLInputElement | HTMLTextAreaElement;
	type: "INPUT_FIELD_CLIPBOARD";
}
export interface EmptyFolderContextMenu extends ContextMenuBase {
	pageType: string;
	type: "EMPTY_FOLDER";
}
export interface BlockItemContextMenu extends ContextMenuBase {
	clearSelection?: () => void;
	sourceContext: MediaCollectionContext;
	type: "BLOCK_ITEM";
}
export interface TrackPromptContextMenu extends ContextMenuBase {
	promptId: number;
	type: "ALBUM_PROMPT" | "ARTIST_PROMPT" | "TRACK_PROMPT";
	userId: ItemId;
}

export type ContextMenu =
	| CommonContextMenu
	| MediaItemContextMenu
	| MultiMediaItemContextMenu
	| InputFieldClipboardContextMenu
	| EmptyFolderContextMenu
	| BlockItemContextMenu
	| TrackPromptContextMenu;
