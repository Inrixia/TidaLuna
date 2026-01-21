import type { AudioQuality } from "neptune-types/tidal";
import type { ItemId } from "..";
import type { ArtistInline } from "./Artist";
import type { StreamingFlags } from "./StreamingFlags";
import type { AudioMode, MediaMetadataTag } from "./Track";

export interface AlbumInline {
	id: ItemId;
	title: string;
	/** @example "817f52f1-5a48-44f6-8629-8d47b31ff7c7" */
	cover: string;
	/** @example "#2e5b79" */
	vibrantColor: string;
	videoCover?: string;
}

export interface Album extends AlbumInline, StreamingFlags {
	duration: number;
	/** @example "2013-11-29T00:00:00.000+0000" */
	streamStartDate: string;

	numberOfTracks: number;
	numberOfVideos: number;
	numberOfVolumes: number;

	/** @example "2013-02-18" */
	releaseDate: string;
	releaseYear?: string | null;

	copyright: string;
	type: "ALBUM";

	version?: string | null;

	url: `http://www.tidal.com/album/${string}`;

	explicit: boolean;

	/** @example "5060186921143" */
	upc: string;

	popularity: number;

	audioQuality: AudioQuality;
	audioModes: AudioMode[];
	mediaMetadata: {
		tags: MediaMetadataTag[];
	};

	upload: boolean;

	artist: ArtistInline;
	artists: ArtistInline[];

	genre?: string | null;
	recordLabel?: string | null;
}
