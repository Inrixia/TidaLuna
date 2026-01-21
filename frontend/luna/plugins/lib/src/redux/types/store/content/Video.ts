import type { MediaItemBase } from "./BaseMediaItem";

export interface Video extends MediaItemBase {
	contentType: "video";

	imagePath?: string | null;
	/** @example "8c7a83d4-136c-49bb-b307-bd7844355f5b" */
	imageId: string;
	/** @example "#d5c396" */
	vibrantColor: string;
	quality: "MP4_1080P";

	type: string;

	adsUrl?: unknown;
	adsPrePaywallOnly: boolean;
}
