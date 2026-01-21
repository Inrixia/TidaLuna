import type { ItemId } from "../store";

export type SortOrder = "ALBUM" | "ARTIST" | "DATE_UPDATED" | "DATE" | "INDEX" | "LENGTH" | "MIX_TYPE" | "NAME" | "POPULARITY" | "RELEASE_DATE";
export type SortDirection = "ASC" | "DESC";

export interface SortFields {
	cursor?: string | null;
	error?: string | null;
	isFullyLoaded: boolean;
	items: ItemId[];
	loading?: boolean | null;
	offset: number;
}
export type StoredSortOrder = [SortOrder, SortDirection];
export interface StoredSortOrders {
	createdAndFavoritePlaylistsPage?: StoredSortOrder;
	createdAndFavoritePlaylistsSidebar?: StoredSortOrder;
	favoriteAlbums?: StoredSortOrder;
	favoriteArtists?: StoredSortOrder;
	favoriteMixes?: StoredSortOrder;
	favoriteTracks?: StoredSortOrder;
	favoriteVideos?: StoredSortOrder;
	playlists?: Record<string, StoredSortOrder | [null, null]>;
}
