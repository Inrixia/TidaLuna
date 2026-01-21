export interface TApiTracks {
	data: TApiTrack[];
	links: Links;
}

export interface TApiTrack {
	attributes: Attributes;
	relationships: Relationships;
	links: Links;
	id: string;
	type: string;
}

export interface Attributes {
	title: string;
	isrc: string;
	duration: string;
	copyright: string;
	explicit: boolean;
	popularity: number;
	availability: string[];
	mediaTags: string[];
	externalLinks: ExternalLink[];
}

export interface ExternalLink {
	href: string;
	meta: {
		type: string;
	};
}

export interface Relationships {
	albums: LinksContainer;
	artists: LinksContainer;
	similarTracks: LinksContainer;
	providers: LinksContainer;
	radio: LinksContainer;
}

export interface LinksContainer {
	links: Links;
}

export interface Links {
	self: string;
	next?: string;
}
