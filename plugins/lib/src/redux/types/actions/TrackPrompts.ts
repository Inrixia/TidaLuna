export interface ArtistPromptData {
	name: string;
	picture: string;
}

export interface TrackPromptArtist {
	id: number;
	name: string;
	picture: string;
	type: string;
}

export interface AlbumPromptData {
	albumName: string;
	artists: TrackPromptArtist[];
	cover: string;
}
export interface TrackPromptData {
	albumName: string;
	artists: TrackPromptArtist[];
	cover: string;
}

export interface BasePrompt {
	colors: {
		primary: string;
		secondary: string;
	};
	data?: AlbumPromptData | ArtistPromptData | TrackPromptData;
	description: string;
	id: number;
	supportedContentType: "ALBUM" | "ARTIST" | "TRACK";
	title: string;
	trn?: string;
}

export interface BasePromptState {
	enabled: boolean;
	promptSearchValue: string;
	trackPrompts: BasePrompt[];
}
