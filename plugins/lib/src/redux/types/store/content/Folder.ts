import type { Playlist } from "./Playlist";

interface FolderItemBase {
	name: string;
	trn: string;
	lastModifiedAt: string;
	addedAt: string;
	parent?: { id: string; name: string } | null;
}

export interface FolderData {
	contentType: "folder";
	itemType: "FOLDER";
	id: string;
	trn: string;
	name: string;
	createdAt: string;
	lastModifiedAt: string;
	totalNumberOfItems: number;
}
export interface Folder extends FolderItemBase {
	itemType: "FOLDER";
	data: FolderData;
}

export type FolderPlaylistData = Omit<Playlist, "type"> & {
	contentType: "folderPlaylist";
	itemType: "PLAYLIST";
	trn: string;
	type: "ARTIST" | "EDITORIAL" | "PODCAST" | "PUBLIC" | "USER";
};
export interface FolderPlaylist extends FolderItemBase {
	itemType: "PLAYLIST";
	data: FolderPlaylistData;
}

export type FolderItem = Folder | FolderPlaylist;
