import type { Image } from ".";

export interface Mix {
	contentBehavior: "UNRESTRICTED";
	contentType: "mix";
	detailImages: Images;
	images: Images;
	master?: unknown;
	mixNumber?: unknown;
	mixType: MixType;
	sharingImages?: unknown;
	shortSubtitle: string;
	subTitle: string;
	/** @example "#C3D8E6" */
	subTitleColor: string;
	title: string;
	/** @example "#C3D8E6" */
	titleColor: string;
	id: string;
}

export interface Images {
	SMALL: Image;
	MEDIUM: Image;
	LARGE: Image;
}

export type MixType = "VIDEO_MIX" | "TRACK_MIX" | "ALBUM_MIX" | "ARTIST_MIX";
