/** `GET openapi.tidal.com/v2/tracks/{id}?include=lyrics`, only the parts used for lyrics */
export interface TApiTrackWithLyrics {
	included?: TApiLyrics[];
}

export interface TApiLyrics {
	id: string;
	type: "lyrics";
	attributes: {
		text?: string;
		lrcText?: string;
		direction?: "LEFT_TO_RIGHT" | "RIGHT_TO_LEFT";
		technicalStatus?: string;
		provider?: {
			source: string;
			name?: string;
			commonTrackId?: string;
			lyricsId?: string;
		};
	};
}
