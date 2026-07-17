import type { ItemId } from "..";
import type { Album } from "./Album";
import type { ArtistInline } from "./Artist";
import type { StreamingFlags } from "./StreamingFlags";

export type ContentType = "track" | "video";
export interface MediaItemBase extends StreamingFlags {
	contentType: ContentType;

	id: ItemId;
	title: string;
	version?: string | null;
	duration: number;

	trackNumber: number;
	volumeNumber: number;

	/** @example "2013-11-05T00:00:00.000+0000" */
	streamStartDate: string;
	/** @example "2013-11-05T00:00:00.000+0000" */
	releaseDate?: string | null;

	explicit: boolean;
	popularity: number;

	artist?: ArtistInline;
	artists: ArtistInline[];

	album?: Album | null;
	mixes?: Record<string, string> | null;
}
