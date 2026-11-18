/** An entry of a playlist as returned by openapi `playlists/{id}/relationships/items` */
export interface TApiPlaylistItemRef {
	/** Track or video id */
	id: string;
	type: "tracks" | "videos";
	meta: {
		/** Identifies this entry in the playlist, duplicates of a track each have their own */
		itemId: string;
		addedAt?: string;
	};
}
