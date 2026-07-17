import type { Album, Artist, Playlist, Track, UserProfile, Video } from "../store";

export type PagedSearchResult<T> = {
	items: Array<T>;
	limit: number;
	offset: number;
	totalNumberOfItems: number;
};
export type ResponseTopHits =
	| {
			type: "ALBUMS";
			value: Album;
	  }
	| {
			type: "PLAYLISTS";
			value: Playlist;
	  }
	| {
			type: "TRACKS";
			value: Track;
	  }
	| {
			type: "VIDEOS";
			value: Video;
	  }
	| {
			type: "USERPROFILES";
			value: any;
	  };

export type SearchResultPayload = {
	albums: PagedSearchResult<Album>;
	artists: PagedSearchResult<Artist>;
	genres: {
		apiPath: string;
		title: string;
	}[];
	playlists: PagedSearchResult<Playlist>;
	topHits: ResponseTopHits;
	tracks: PagedSearchResult<Track>;
	userProfiles: {
		items: UserProfile[];
		limit: number;
		totalNumberOfItems: number;
	};
	videos: PagedSearchResult<Video>;
};
