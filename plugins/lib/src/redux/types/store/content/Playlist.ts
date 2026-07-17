import type { ItemId } from "..";
import type { ArtistInline } from "./Artist";

export interface Playlist {
	/** @example "32abca0c-a413-4745-b8d7-09440690ec3e" */
	uuid: string;
	title: string;
	creator: {
		id: ItemId;
	};

	description: string;
	duration: number;

	numberOfTracks: number;
	numberOfVideos: number;

	/** @example "2024-07-06T05:10:50.978+0000" */
	lastUpdated: string;
	/** @example "2024-07-06T05:10:12.630+0000" */
	created: string;
	/** @example "2024-07-06T05:10:50.978+0000" */
	lastItemAddedAt: string;

	type: "USER";
	publicPlaylist: true;

	url: `http://www.tidal.com/playlist/${string}`;

	/** @example "e42d8e19-4871-474a-a1bf-406e74e2f23a" */
	image: string;
	/** @example "0d754659-2634-4a2a-a2a7-2882198c806f" */
	squareImage: string;

	customImageUrl?: string | null;
	promotedArtists: ArtistInline[];

	popularity?: number;
}
