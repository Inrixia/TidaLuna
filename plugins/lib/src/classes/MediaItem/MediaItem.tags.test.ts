import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resetTidalState, setTidalState } from "test/harness/tidalStore";

import type * as redux from "../../redux";
import { MediaItem } from "./MediaItem";
import { availableTags, makeTags } from "./MediaItem.tags";
import { TidalApi } from "../TidalApi";

/**
 * `makeTags` only assembles what `MediaItem`'s accessors return, so these tests give it a real `MediaItem` over a
 * TIDAL-shaped track, seed TIDAL's store with the album and artists it looks up, and assert on the tag bag.
 *
 * Nothing here may reach the network: `fetch` is stubbed to reject (which is MusicBrainz being unknown to us, so the
 * accessors fall back to TIDAL's data) and the TIDAL api methods a minimal fixture hits are stubbed out.
 */

let idSeq = 0;
const nextId = () => 200_000 + ++idSeq;

const artistInline = (id: redux.ItemId, name = "An Artist"): redux.ArtistInline => ({ id, name, type: "MAIN", picture: "" });

const album = (id: redux.ItemId, fields: Partial<redux.Album> = {}): redux.Album =>
	({
		id,
		title: "An Album",
		cover: "album-cover",
		vibrantColor: "#000000",
		duration: 1_000,
		streamStartDate: "2020-01-01T00:00:00.000+0000",
		numberOfTracks: 10,
		numberOfVideos: 0,
		numberOfVolumes: 1,
		releaseDate: "2020-01-01",
		copyright: "(C) 2020",
		type: "ALBUM",
		url: "http://www.tidal.com/album/1",
		explicit: false,
		upc: "0123456789012",
		popularity: 0,
		audioQuality: "LOSSLESS",
		audioModes: ["STEREO"],
		mediaMetadata: { tags: ["LOSSLESS"] },
		upload: false,
		artist: artistInline(id),
		artists: [],
		...fields,
	}) as redux.Album;

const track = (id: redux.ItemId, fields: Partial<redux.Track> = {}): redux.Track =>
	({
		contentType: "track",
		id,
		title: "A Track",
		duration: 201,
		trackNumber: 3,
		volumeNumber: 1,
		streamStartDate: "2020-01-01T00:00:00.000+0000",
		explicit: false,
		popularity: 0,
		artist: undefined,
		artists: [],
		album: undefined,
		url: `http://www.tidal.com/track/${id}`,
		replayGain: -7.5,
		peak: 0.98,
		editable: false,
		audioQuality: "LOSSLESS",
		audioModes: ["STEREO"],
		mediaMetadata: { tags: ["LOSSLESS"] },
		upload: false,
		...fields,
	}) as redux.Track;

const makeMediaItem = (id: redux.ItemId, fields: Partial<redux.Track> = {}) =>
	new MediaItem(id, { type: "track", item: track(id, fields) }, "track", {});

/**
 * `ContentBase` reads TIDAL's content slices directly, so a slice a lookup needs has to exist even when it is empty.
 * Empty slices are seeded here and tests add what they want found.
 */
const seedContent = (content: Record<string, Record<string, unknown>> = {}) =>
	setTidalState({ content: { mediaItems: {}, albums: {}, artists: {}, ...content } as never });

/** An item with everything `makeTags` asks for, whose album is in TIDAL's store */
const fullMediaItem = () => {
	const id = nextId();
	const albumId = nextId();
	const artistId = nextId();
	const albumArtistId = nextId();
	seedContent({
		albums: {
			[albumId]: album(albumId, {
				title: "Album Title",
				cover: "cover-uuid",
				upc: "0123456789012",
				genre: "Rock",
				recordLabel: "Label Records",
				numberOfTracks: 12,
				releaseDate: "1999-12-31",
				releaseYear: "1999",
				artists: [artistInline(albumArtistId)],
			}),
		},
		artists: { [artistId]: { name: "Track Artist" }, [albumArtistId]: { name: "Album Artist" } },
	});
	return makeMediaItem(id, {
		title: "Real Title",
		version: null,
		trackNumber: 3,
		volumeNumber: 2,
		replayGain: -6.5,
		peak: 0.97,
		copyright: "(C) 2020 Label",
		bpm: 128,
		isrc: "US1234567890",
		releaseDate: "2021-07-08T00:00:00.000+0000",
		artists: [artistInline(artistId)],
		album: album(albumId, { cover: "cover-uuid" }),
	});
};

beforeEach(() => {
	vi.restoreAllMocks();
	resetTidalState();
	seedContent();
	// No network in tests: MusicBrainz lookups reject and every accessor falls back to TIDAL's own data
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
	vi.spyOn(TidalApi, "track").mockResolvedValue(undefined);
	vi.spyOn(TidalApi, "artist").mockResolvedValue(undefined);
	vi.spyOn(TidalApi, "lyrics").mockResolvedValue(undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	resetTidalState();
});

describe("makeTags", () => {
	test("builds the tags from the item, its album and the artist names", async () => {
		vi.spyOn(TidalApi, "lyrics").mockResolvedValue({ lyrics: "Real Title", subtitles: "[00:01.00] Real Title" } as redux.Lyrics);
		const mediaItem = fullMediaItem();

		const { tags, coverUrl } = await makeTags(mediaItem);

		expect(tags).toEqual({
			title: "Real Title",
			trackNumber: "3",
			discNumber: "2",
			bpm: "128",
			// The album's release date and year win over the item's
			year: "1999",
			date: "1999-12-31",
			copyright: "(C) 2020 Label",
			REPLAYGAIN_TRACK_GAIN: "-6.5",
			REPLAYGAIN_TRACK_PEAK: "0.97",
			comment: `http://www.tidal.com/track/${mediaItem.id}`,
			isrc: "US1234567890",
			upc: "0123456789012",
			artist: ["Track Artist"],
			album: "Album Title",
			albumArtist: ["Album Artist"],
			genres: "Rock",
			organization: "Label Records",
			totalTracks: "12",
			lyrics: "[00:01.00] Real Title",
			// MusicBrainz isn't reachable in these tests, so neither id is known
			musicbrainz_trackid: undefined,
			musicbrainz_albumid: undefined,
		});
		expect(coverUrl).toBe("https://resources.tidal.com/images/cover/uuid/1280x1280.jpg");
	});

	test("keeps the item's own date and year when there is no album", async () => {
		const mediaItem = makeMediaItem(nextId(), {
			title: "Lonely",
			releaseDate: "2021-07-08T00:00:00.000+0000",
			artists: [],
			artist: undefined,
			album: undefined,
			isrc: undefined,
		});

		const { tags, coverUrl } = await makeTags(mediaItem);

		expect(tags.year).toBe("2021");
		expect(tags.date).toBe("2021-07-08");
		expect(coverUrl).toBeUndefined();
	});

	test("fills the core tags for an item TIDAL knows nothing more about", async () => {
		const mediaItem = makeMediaItem(nextId(), { title: "Lonely", artists: [], artist: undefined, album: undefined, isrc: undefined });

		const { tags } = await makeTags(mediaItem);

		expect(tags.artist).toEqual(["Unknown Artist"]);
		expect(tags.album).toBe("Unknown Album");
		// The album tags only exist when there is an album
		expect(tags.albumArtist).toBeUndefined();
		expect(tags.upc).toBeUndefined();
		expect(tags.genres).toBeUndefined();
		expect(tags.organization).toBeUndefined();
		expect(tags.totalTracks).toBeUndefined();
		expect(tags.musicbrainz_albumid).toBeUndefined();
	});

	test("drops artists TIDAL has no name for, but not the tag", async () => {
		const knownId = nextId();
		const unknownId = nextId();
		seedContent({ artists: { [knownId]: { name: "Known" } } });
		const mediaItem = makeMediaItem(nextId(), { artists: [artistInline(knownId, "Known"), artistInline(unknownId, "Unknown")] });

		const { tags } = await makeTags(mediaItem);

		expect(tags.artist).toEqual(["Known"]);
	});

	test("prefers the provider's synced lyrics", async () => {
		vi.spyOn(TidalApi, "lyrics").mockResolvedValue({ lyrics: "Plain", subtitles: "[00:01.00] Synced" } as redux.Lyrics);
		const mediaItem = makeMediaItem(nextId());

		expect((await makeTags(mediaItem)).tags.lyrics).toBe("[00:01.00] Synced");
	});

	test("falls back to the plain lyrics when the provider has no synced ones", async () => {
		vi.spyOn(TidalApi, "lyrics").mockResolvedValue({ lyrics: "Plain", subtitles: null } as redux.Lyrics);
		const mediaItem = makeMediaItem(nextId());

		expect((await makeTags(mediaItem)).tags.lyrics).toBe("Plain");
	});

	test("leaves the lyrics tag unset when TIDAL has no lyrics", async () => {
		const mediaItem = makeMediaItem(nextId());

		expect((await makeTags(mediaItem)).tags.lyrics).toBeUndefined();
	});

	test("only sets tags that are listed in availableTags", async () => {
		const { tags } = await makeTags(fullMediaItem());

		const unlisted = Object.entries(tags)
			.filter(([, value]) => value !== undefined)
			.map(([key]) => key)
			.filter((key) => !availableTags.includes(key as keyof typeof tags));

		expect(unlisted).toEqual([]);
	});

	test("is the tags list MediaItem exposes for its settings", () => {
		expect(MediaItem.availableTags).toBe(availableTags);
	});
});
