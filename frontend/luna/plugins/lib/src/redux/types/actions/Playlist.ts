import type { ItemId } from "../store";

export interface CreatePlaylistPayload {
	description: string;
	folderId?: ItemId | null;
	fromPlaylist?: ItemId | null;
	ids?: ItemId[];
	title: string;
}

export interface PlaylistMeta {
	description: string;
	folderId?: string | null;
	title: string;
}
