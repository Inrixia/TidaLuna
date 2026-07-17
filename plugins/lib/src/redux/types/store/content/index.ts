import type { Album } from "./Album";
import type { Article } from "./Article";
import type { Artist, ArtistBio, ArtistContribution, ArtistRole } from "./Artist";
import type { ContentType } from "./BaseMediaItem";
import type { List } from "./Lists";
import type { Mix } from "./Mix";
import type { Playlist } from "./Playlist";
import type { Track } from "./Track";
import type { Video } from "./Video";

export * from "./Album";
export * from "./Article";
export * from "./Artist";
export * from "./BaseMediaItem";
export * from "./Lists";
export * from "./Mix";
export * from "./Playlist";
export * from "./Track";
export * from "./Video";

export interface Content {
	albumCredits: Record<string, AlbumCredit[]>;
	albumLists: Record<string, List>;
	albumReviews: Record<string, AlbumReview>;
	albums: Record<string, Album>;
	articleLists: Record<string, List>;
	articles: Record<string, Article>;
	artistBios: Record<string, ArtistBio>;
	artistContributions: Record<string, Record<string, ArtistContribution[]>>;
	artistLists: Record<string, List>;
	artistRoleCategories: Record<string, ArtistRole[]>;
	artists: Record<string, Artist>;
	dateAddedMaps: Record<string, Record<string, string>>;
	dynamicPages: Record<string, Page>;
	folders: unknown;
	lyrics: unknown;
	mediaItemProxies: Record<string, string>;
	mediaItems: Record<string, MediaItem>;
	mixLists: Record<string, List>;
	mixedTypesLists: Record<string, List>;
	mixes: Record<string, Mix>;
	playlistLists: Record<string, List>;
	playlists: Record<string, Playlist>;
	trackContributors: unknown;
	trackLists: Record<string, List>;
	videoContributors: unknown;
}

export interface Image {
	width: number;
	height: number;
	url: string;
}

export interface Page {
	eTag: string;
	error?: string | null;
	id: string;
	isLoading: boolean;
	rows: unknown[];
	title: string;
}

export type MediaItem<T extends ContentType = ContentType> = { type: T; item: T extends "track" ? Track : Video };

export interface AlbumCredit {
	contributors: AlbumCreditContributor[];
	type: string;
}

export interface AlbumCreditContributor {
	name: string;
	id?: number | null;
}

export interface AlbumReview {
	text?: string | null /** @example "Although it picks up a thread left hanging..." */;
	source?: string | null /** @example "TiVo" */;
}
