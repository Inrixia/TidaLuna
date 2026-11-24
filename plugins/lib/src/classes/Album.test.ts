import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resetTidalState, setTidalState } from "test/harness/tidalStore";

import type * as redux from "../redux";
import { Album } from "./Album";
import { Artist } from "./Artist";
import { ContentBase } from "./ContentBase";
import { TidalApi } from "./TidalApi";

// MusicBrainz is a network call: `musicBrainz.json` is stubbed so `brainzAlbum`, `title`, `upc` and `brainzId` can be driven
vi.mock("../caches", async (importActual) => ({ ...(await importActual<typeof import("../caches")>()), musicBrainz: { json: vi.fn() } }));
import { musicBrainz } from "../caches";
const brainzJson = musicBrainz.json;

/**
 * `ContentBase` caches instances by itemId for the life of the process, so every test uses its own ids.
 * No default `upc`, so `brainzAlbum` doesn't ask MusicBrainz unless a test gives the album one.
 */
const tidalAlbum = (fields: Partial<redux.Album> = {}): redux.Album =>
	({
		id: "album",
		title: "An Album",
		cover: "11111111-2222-3333-4444-555555555555",
		vibrantColor: "#1a1a1a",
		numberOfTracks: 10,
		releaseDate: "2020-01-31",
		streamStartDate: "2020-02-01T00:00:00.000+0000",
		...fields,
	}) as redux.Album;
const makeAlbum = (id: string, fields: Partial<redux.Album> = {}) => new Album(id, tidalAlbum(fields));
const tidalArtist = (id: redux.ItemId, name: string): redux.Artist => ({ id, name, type: "MAIN", picture: "" }) as redux.Artist;
/** A release as MusicBrainz's release search answers it, `track-count` is what `brainzAlbum` validates against the album */
const release = (fields: Record<string, unknown> = {}) => ({ id: "brainz-release", title: "Brainz Album", "track-count": 10, ...fields });
/** The store slices `fromStore` reads, `content.albums`/`content.artists` have to exist */
const setContent = (content: { albums?: Record<string, redux.Album>; artists?: Record<string, redux.Artist> }) => setTidalState({ content });

beforeEach(() => {
	resetTidalState();
	vi.mocked(brainzJson).mockReset();
});
afterEach(() => {
	vi.restoreAllMocks();
	resetTidalState();
});

describe("fromId", () => {
	test("has no album without an id", async () => {
		expect(await Album.fromId()).toBeUndefined();
	});

	test("uses the album TIDAL's store already has", async () => {
		const albumId = "album-fromid-store";
		setContent({ albums: { [albumId]: tidalAlbum({ title: "In the store" }) } });
		const api = vi.spyOn(TidalApi, "album");

		const album = await Album.fromId(albumId);

		expect(api).not.toHaveBeenCalled();
		expect(album).toBeInstanceOf(Album);
		expect(album?.id).toBe(albumId);
		expect(album?.tidalAlbum.title).toBe("In the store");
	});

	test("fetches the album when TIDAL's store doesn't have it", async () => {
		const albumId = "album-fromid-fetch";
		setContent({ albums: {} });
		const api = vi.spyOn(TidalApi, "album").mockResolvedValue(tidalAlbum({ title: "Fetched" }));

		const album = await Album.fromId(albumId);

		expect(api).toHaveBeenCalledWith(albumId);
		expect(album?.tidalAlbum.title).toBe("Fetched");
	});

	test("has no album when TIDAL doesn't have it either", async () => {
		setContent({ albums: {} });
		vi.spyOn(TidalApi, "album").mockResolvedValue(undefined);

		expect(await Album.fromId("album-fromid-missing")).toBeUndefined();
	});

	test("returns the same instance for the same id", async () => {
		const albumId = "album-fromid-cached";
		setContent({ albums: {} });
		const api = vi.spyOn(TidalApi, "album").mockResolvedValue(tidalAlbum());

		const first = await Album.fromId(albumId);
		const second = await Album.fromId(albumId);

		expect(second).toBe(first);
		expect(api).toHaveBeenCalledTimes(1);
	});
});

describe("title", () => {
	test("is the TIDAL title without a MusicBrainz release", async () => {
		const album = makeAlbum("album-title-tidal", { title: "Just Tidal" });

		expect(await album.title()).toBe("Just Tidal");
		expect(brainzJson).not.toHaveBeenCalled();
	});

	test("appends the TIDAL version", async () => {
		expect(await makeAlbum("album-title-version", { title: "Deluxe", version: "Remastered" }).title()).toBe("Deluxe (Remastered)");
	});

	test("uses the MusicBrainz title for a matching barcode", async () => {
		const album = makeAlbum("album-title-brainz", { title: "Tidal Song", upc: "602547086175", numberOfTracks: 12 });
		vi.mocked(brainzJson).mockResolvedValue({ releases: [release({ id: "brainz-mbid", title: "Brainz Song", "track-count": 12 })] });

		expect(await album.title()).toBe("Brainz Song");
		expect(await album.brainzId()).toBe("brainz-mbid");
		expect(brainzJson).toHaveBeenCalledWith(expect.stringContaining("barcode:602547086175"));
	});

	test("sums the media track counts when the release has no total", async () => {
		const album = makeAlbum("album-title-media-count", { title: "Tidal Song", upc: "111", numberOfTracks: 2 });
		vi
			.mocked(brainzJson)
			.mockResolvedValue({ releases: [release({ "track-count": undefined, media: [{ "track-count": 1 }, { "track-count": 1 }] })] });

		expect(await album.title()).toBe("Brainz Album");
	});

	test("ignores a release whose track count doesn't match the album", async () => {
		const album = makeAlbum("album-title-mismatch", { title: "Tidal Song", upc: "222", numberOfTracks: 2 });
		vi.mocked(brainzJson).mockResolvedValue({ releases: [release({ "track-count": 3 })] });

		expect(await album.title()).toBe("Tidal Song");
		expect(await album.brainzId()).toBeUndefined();
		expect(await album.upc()).toBe("222");
	});

	test("asks MusicBrainz once per album", async () => {
		const album = makeAlbum("album-title-once", { title: "Tidal Song", upc: "333", numberOfTracks: 10 });
		vi.mocked(brainzJson).mockResolvedValue({ releases: [release()] });

		await album.title();
		await album.brainzId();

		expect(brainzJson).toHaveBeenCalledTimes(1);
	});
});

describe("upc", () => {
	test("is TIDAL's upc even when MusicBrainz has a barcode", async () => {
		const album = makeAlbum("album-upc-tidal", { upc: "5060147584135", numberOfTracks: 10 });
		vi.mocked(brainzJson).mockResolvedValue({ releases: [release({ barcode: "9999999999999" })] });

		expect(await album.upc()).toBe("5060147584135");
	});

	test("has no MusicBrainz barcode to fall back on", async () => {
		// brainzAlbum skips albums without a upc, so upc's `?? brainzAlbum()?.barcode` fallback is unreachable: an album
		// whose TIDAL upc is missing never gets a MusicBrainz release to take a barcode from either
		const album = makeAlbum("album-upc-brainz", { numberOfTracks: 10 });
		vi.mocked(brainzJson).mockResolvedValue({ releases: [release({ barcode: "999" })] });

		expect(await album.upc()).toBeUndefined();
		expect(brainzJson).not.toHaveBeenCalled();
	});

	test("has no upc without TIDAL's or MusicBrainz's", async () => {
		const album = makeAlbum("album-upc-none", { numberOfTracks: 10 });

		expect(await album.upc()).toBeUndefined();
		expect(brainzJson).not.toHaveBeenCalled();
	});
});

describe("coverUrl", () => {
	test("is the cover at 1280 by default", () => {
		expect(makeAlbum("album-cover", { cover: "aaaa-bbbb-cccc" }).coverUrl()).toBe(
			"https://resources.tidal.com/images/aaaa/bbbb/cccc/1280x1280.jpg",
		);
	});

	test("takes the resolution option", () => {
		expect(makeAlbum("album-cover-res", { cover: "aaaa-bbbb-cccc" }).coverUrl({ res: "320" })).toBe(
			"https://resources.tidal.com/images/aaaa/bbbb/cccc/320x320.jpg",
		);
	});

	test("formats the video cover for a video request", () => {
		expect(makeAlbum("album-cover-video", { cover: "aaaa-bbbb-cccc", videoCover: "dddd-eeee-ffff" }).coverUrl({ type: "video" })).toBe(
			"https://resources.tidal.com/videos/dddd/eeee/ffff/1280x1280.mp4",
		);
	});

	test("has no url without a cover", () => {
		expect(makeAlbum("album-cover-none", { cover: "" }).coverUrl()).toBeUndefined();
	});
});

describe("artists", () => {
	test("artist is the album's main artist", async () => {
		const artistId = "artist-album-main";
		setContent({ artists: { [artistId]: tidalArtist(artistId, "Main Artist") } });
		const album = makeAlbum("album-artist-main", { artist: tidalArtist(artistId, "Main Artist") });

		const artist = await album.artist();

		expect(artist).toBeInstanceOf(Artist);
		expect(artist?.name).toBe("Main Artist");
	});

	test("artist falls back to the first of its artists", async () => {
		const artistId = "artist-album-first";
		setContent({ artists: { [artistId]: tidalArtist(artistId, "First Artist") } });
		const album = makeAlbum("album-artist-fallback", {
			artists: [tidalArtist(artistId, "First Artist"), tidalArtist("artist-album-other", "Other Artist")],
		});

		expect((await album.artist())?.name).toBe("First Artist");
	});

	test("artist is undefined without one", async () => {
		expect(await makeAlbum("album-artist-none").artist()).toBeUndefined();
	});

	test("artists names every artist in order", async () => {
		setContent({ artists: { "artist-names-a": tidalArtist("artist-names-a", "A"), "artist-names-b": tidalArtist("artist-names-b", "B") } });
		const album = makeAlbum("album-artist-names", {
			artists: [tidalArtist("artist-names-a", "A"), tidalArtist("artist-names-b", "B")],
		});

		expect(await ContentBase.artistNames(album.artists())).toEqual(["A", "B"]);
	});
});

describe("items", () => {
	test("count is TIDAL's number of tracks", async () => {
		expect(await makeAlbum("album-count", { numberOfTracks: 7 }).count()).toBe(7);
	});

	test("tMediaItems are the items of TIDAL's album page", async () => {
		const items = [
			{ item: { id: 1 }, type: "track" },
			{ item: { id: 2 }, type: "video" },
		];
		const api = vi.spyOn(TidalApi, "albumItems").mockResolvedValue(items as never);
		const album = makeAlbum("album-items");

		expect(await album.tMediaItems()).toEqual(items);
		expect(api).toHaveBeenCalledWith("album-items");
	});

	test("tMediaItems are cached", async () => {
		const api = vi.spyOn(TidalApi, "albumItems").mockResolvedValue([] as never);
		const album = makeAlbum("album-items-cached");

		await album.tMediaItems();
		await album.tMediaItems();

		expect(api).toHaveBeenCalledTimes(1);
	});

	test("tMediaItems are empty when TIDAL has no album page", async () => {
		vi.spyOn(TidalApi, "albumItems").mockResolvedValue(undefined as never);

		expect(await makeAlbum("album-items-missing").tMediaItems()).toEqual([]);
	});

	test("mediaItems yields nothing for an album without items", async () => {
		vi.spyOn(TidalApi, "albumItems").mockResolvedValue([] as never);
		const album = makeAlbum("album-media-items-empty");

		const mediaItems: unknown[] = [];
		for await (const mediaItem of await album.mediaItems()) mediaItems.push(mediaItem);

		expect(mediaItems).toEqual([]);
	});
});

describe("getters", () => {
	test("expose TIDAL's album fields", () => {
		const album = makeAlbum("album-getters", {
			genre: "Electronic",
			recordLabel: "Label",
			numberOfTracks: 9,
			releaseDate: "2019-05-17",
			releaseYear: "2019",
		});

		expect(album.genre).toBe("Electronic");
		expect(album.recordLabel).toBe("Label");
		expect(album.numberOfTracks).toBe(9);
		expect(album.releaseDate).toBe("2019-05-17");
		expect(album.releaseYear).toBe("2019");
	});

	test("releaseDate falls back to the stream start date", () => {
		const album = makeAlbum("album-getters-stream", { releaseDate: undefined, streamStartDate: "2018-01-02T00:00:00.000+0000" });

		expect(album.releaseDate).toBe("2018-01-02T00:00:00.000+0000");
	});

	test("releaseYear and the labels are undefined when TIDAL has none", () => {
		const album = makeAlbum("album-getters-none", { releaseYear: null, genre: null, recordLabel: null });

		expect(album.releaseYear).toBeUndefined();
		expect(album.genre).toBeUndefined();
		expect(album.recordLabel).toBeUndefined();
	});
});
