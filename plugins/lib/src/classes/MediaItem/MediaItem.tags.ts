import { MediaItem } from "./MediaItem";

export type FlacTags = {
	title?: string;
	trackNumber?: string;
	discNumber?: string;
	bpm?: string;
	year?: string;
	date?: string;
	copyright?: string;
	REPLAYGAIN_TRACK_GAIN?: string;
	REPLAYGAIN_TRACK_PEAK?: string;
	comment?: string;
	isrc?: string;
	upc?: string;
	musicbrainz_trackid?: string;
	musicbrainz_albumid?: string;
	artist?: string[];
	album?: string;
	albumArtist?: string[];
	genres?: string;
	organization?: string;
	totalTracks?: string;
	lyrics?: string;
};
export const availableTags: (keyof FlacTags)[] = [
	"title",
	"trackNumber",
	"discNumber",
	"bpm",
	"year",
	"date",
	"copyright",
	"REPLAYGAIN_TRACK_GAIN",
	"REPLAYGAIN_TRACK_PEAK",
	"comment",
	"isrc",
	"upc",
	"musicbrainz_trackid",
	"musicbrainz_albumid",
	"artist",
	"album",
	"albumArtist",
	"genres",
	"organization",
	"totalTracks",
	"lyrics",
];

export type MetaTags = {
	tags: FlacTags;
	coverUrl: string | undefined;
};

export const makeTags = async (mediaItem: MediaItem): Promise<MetaTags> => {
	const tags: FlacTags = {};

	const [title, releaseDate, releaseDateStr, copyright, bpm, artistNames, brainzId, isrc, album, lyrics, coverUrl] = await Promise.all([
		mediaItem.title(),
		mediaItem.releaseDate(),
		mediaItem.releaseDateStr(),
		mediaItem.copyright(),
		mediaItem.bpm(),
		MediaItem.artistNames(mediaItem.artists()),
		mediaItem.brainzId(),
		mediaItem.isrc(),
		mediaItem.album(),
		mediaItem.lyrics(),
		mediaItem.coverUrl(),
	]);

	tags.title = title;

	tags.trackNumber = mediaItem.trackNumber?.toString();

	tags.year = releaseDate?.getFullYear().toString();
	tags.date = releaseDateStr;

	tags.REPLAYGAIN_TRACK_PEAK = mediaItem.replayGainPeak?.toString();
	tags.REPLAYGAIN_TRACK_GAIN = mediaItem.replayGain?.toString();
	tags.comment = mediaItem.url;
	tags.copyright = copyright;
	tags.bpm = bpm?.toString();
	tags.discNumber = mediaItem.volumeNumber?.toString();

	tags.artist = artistNames;
	if (tags.artist.length === 0) tags.artist = ["Unknown Artist"];

	tags.musicbrainz_trackid = brainzId;

	tags.isrc = isrc;

	if (album) {
		const [upc, brainzAlbumId, albumTitle, artistNames] = await Promise.all([
			album.upc(),
			album.brainzId(),
			album.title(),
			MediaItem.artistNames(album.artists()),
		]);
		tags.upc = upc;
		tags.musicbrainz_albumid = brainzAlbumId;
		tags.album = albumTitle;

		tags.albumArtist = artistNames;
		if (tags.albumArtist.length === 0) tags.albumArtist = ["Unknown Artist"];

		tags.genres = album.genre;
		tags.organization = album.recordLabel;

		tags.totalTracks = album.numberOfTracks?.toString();

		tags.date = album.releaseDate ?? tags.date;
		tags.year = album.releaseYear ?? tags.year;
	}

	tags.lyrics = lyrics?.subtitles ?? lyrics?.lyrics;

	// Ensure core tags are set
	tags.album ??= "Unknown Album";

	return { tags, coverUrl };
};
