import type { ItemId } from ".";

export interface Lyrics {
	trackId: ItemId;
	lyricsProvider: string;
	providerCommontrackId: ItemId;
	providerLyricsId: ItemId;
	lyrics: string;
	subtitles?: string | null;
	isRightToLeft: boolean;
}
