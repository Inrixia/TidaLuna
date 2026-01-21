import type { EventAction } from ".";
import type { ItemId } from "../store";

export interface AddAlbumModal {
	albumId: ItemId;
	contentType: "CONTENT_TYPE_ALBUM";
}
export interface AddMediaItemModal {
	contentType: "CONTENT_TYPE_MEDIA_ITEM";
	mediaItemIdsToAdd: ItemId[];
}
export interface AddMixModal {
	contentType: "CONTENT_TYPE_MIX";
	mixId: ItemId;
}
export interface AddPlaylistModal {
	contentType: "CONTENT_TYPE_PLAYLIST";
	playlistId: ItemId;
}

export type AddToPlaylistModal = AddAlbumModal | AddMediaItemModal | AddMixModal | AddPlaylistModal;

interface CreatePlaylistModalBase {
	action: EventAction;
	folderId?: ItemId;
	formattedDate?: string;
	fromPlaylist?: ItemId;
	mediaItemIds: ItemId[];
	moduleId?: ItemId | null;
}

export interface CreatePlaylistModal extends CreatePlaylistModalBase {
	mode: "create" | "createWithDefaultTitle";
	type: "CREATE_PLAYLIST";
}

export interface CreateAiPlaylistModal extends CreatePlaylistModalBase {
	mode: "createWithDefaultTitle";
	type: "CREATE_AI_PLAYLIST";
}

export interface UnblockItem {
	id: ItemId;
	itemTitle: string;
	itemType: "artist" | "track" | "user" | "video";
}
export interface ConfirmModalAdditionalValues {
	addToIndex?: number;
	fromPlaylistUuid?: ItemId;
	isPublic?: boolean;
	itemToUnblock?: UnblockItem;
	mediaItemIdsToAdd?: Array<ItemId>;
	totalNumberOfItems?: number;
}
export interface ConfirmModal {
	additionalValues?: ConfirmModalAdditionalValues;
	mode:
		| "addMediaItemsToPlaylist"
		| "addPlaylistToIndex"
		| "deleteFolder"
		| "deletePlaylist"
		| "deleteProfilePicture"
		| "togglePublicPlaylist"
		| "unblockItem";
	type: "CONFIRM";
	value: ItemId;
}

export interface PickItemModal {
	promptId: number;
	userId: ItemId;
}
