import type { ItemId } from "..";

export type ArtistType = "MAIN" | "FEATURED" | "COMPOSER" | "PRODUCER";
export type ArtistRoleCategory = "Artist" | "Songwriter" | "Performer" | "Producer" | "Production team" | "Engineer" | "Misc";

export interface ArtistInline {
	id: ItemId;
	name: string;
	handle?: unknown;
	type: ArtistType;
	/** @example "8c7a83d4-136c-49bb-b307-bd7844355f5b" */
	picture: string;
}

export interface Artist extends ArtistInline {
	artistTypes: ("ARTIST" | "CONTRIBUTOR")[];

	url: `http://www.tidal.com/artist/${string}`;

	/** @example "1f711373-9a3d-49a6-a25d-f77fb6876a11" */
	selectedAlbumCoverFallback: string;

	artistRoles: {
		categoryId: number;
		category: ArtistRoleCategory;
	}[];

	popularity?: number;
	mixes?: unknown;
}

export interface ArtistRole {
	categoryId: number;
	category: ArtistRoleCategory;
}

export interface ArtistContribution {
	name: string;
	category: ArtistRoleCategory;
	categoryId: number;
	trackId: number;
}

export interface ArtistBio {
	source: string | null /** @example "TiVo" */;
	lastUpdated?: string /** @example "2025-04-15T03:18:19.619+0000" */;
	text: string | null;
	summary?: string;
}
