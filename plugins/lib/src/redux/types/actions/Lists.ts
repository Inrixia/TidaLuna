import type { Artist, Track, UserProfile, Video } from "../store";

export type ItemsPageListType = "album" | "artist" | "mediaItems" | "mix" | "playlist";

export type ListType = "artists" | "tracks" | "users" | "videos";
export interface ListBase {
	offset: number;
	totalNumberOfItems: number;
}
export interface ArtistList extends ListBase {
	items: {
		item: Artist;
		type: string;
	}[];
	listType: "artists";
}
export interface UserList extends ListBase {
	items: {
		item: UserProfile;
		type: string;
	}[];
	listType: "users";
}
export interface TrackList extends ListBase {
	items: {
		item: Track;
		type: string;
	}[];
	listType: "tracks";
}
export interface VideoList extends ListBase {
	items: {
		item: Video;
		type: string;
	}[];
	listType: "videos";
}
export type List = ArtistList | UserList | TrackList | VideoList;
