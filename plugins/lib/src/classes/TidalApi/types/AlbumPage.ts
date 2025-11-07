import type { redux } from "@luna/lib";

export type AlbumPage = {
	id: string;
	title: string;
	rows: {
		modules: {
			/** ALBUM_ITEMS is what we want */
			type: string;
			pagedList?: {
				items: redux.MediaItem[];
			};
		}[];
	}[];
};
