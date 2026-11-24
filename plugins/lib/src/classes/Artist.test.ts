import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resetTidalState, setTidalState } from "test/harness/tidalStore";

import type * as redux from "../redux";
import { Artist } from "./Artist";
import { TidalApi } from "./TidalApi";

// `ContentBase` caches instances by itemId for the life of the process, so every test uses its own ids
const tidalArtist = (fields: Partial<redux.Artist> = {}): redux.Artist =>
	({ id: "artist", name: "An Artist", type: "MAIN", picture: "aaaa-bbbb-cccc", ...fields }) as redux.Artist;
const makeArtist = (id: string, fields: Partial<redux.Artist> = {}) => new Artist(id, tidalArtist(fields));
/** The store slice `fromStore` reads, `content.artists` has to exist */
const setArtists = (artists: Record<string, redux.Artist>) => setTidalState({ content: { artists } });

beforeEach(() => {
	resetTidalState();
});
afterEach(() => {
	vi.restoreAllMocks();
	resetTidalState();
});

describe("fromId", () => {
	test("has no artist without an id", async () => {
		expect(await Artist.fromId()).toBeUndefined();
	});

	test("uses the artist TIDAL's store already has", async () => {
		const artistId = "artist-fromid-store";
		setArtists({ [artistId]: tidalArtist({ name: "In the store" }) });
		const api = vi.spyOn(TidalApi, "artist");

		const artist = await Artist.fromId(artistId);

		expect(api).not.toHaveBeenCalled();
		expect(artist).toBeInstanceOf(Artist);
		expect(artist?.id).toBe(artistId);
		expect(artist?.name).toBe("In the store");
	});

	test("fetches the artist when TIDAL's store doesn't have it", async () => {
		const artistId = "artist-fromid-fetch";
		setArtists({});
		const api = vi.spyOn(TidalApi, "artist").mockResolvedValue(tidalArtist({ name: "Fetched" }));

		const artist = await Artist.fromId(artistId);

		expect(api).toHaveBeenCalledWith(artistId);
		expect(artist?.name).toBe("Fetched");
	});

	test("has no artist when TIDAL doesn't have it either", async () => {
		setArtists({});
		vi.spyOn(TidalApi, "artist").mockResolvedValue(undefined);

		expect(await Artist.fromId("artist-fromid-missing")).toBeUndefined();
	});

	test("returns the same instance for the same id", async () => {
		const artistId = "artist-fromid-cached";
		setArtists({});
		const api = vi.spyOn(TidalApi, "artist").mockResolvedValue(tidalArtist());

		const first = await Artist.fromId(artistId);
		const second = await Artist.fromId(artistId);

		expect(second).toBe(first);
		expect(api).toHaveBeenCalledTimes(1);
	});
});

describe("name", () => {
	test("is TIDAL's artist name", () => {
		expect(makeArtist("artist-name", { name: "Aphex Twin" }).name).toBe("Aphex Twin");
	});
});

describe("coverUrl", () => {
	test("is the picture at 1280 by default", () => {
		expect(makeArtist("artist-cover").coverUrl()).toBe("https://resources.tidal.com/images/aaaa/bbbb/cccc/1280x1280.jpg");
	});

	test("takes the resolution", () => {
		expect(makeArtist("artist-cover-res").coverUrl("80")).toBe("https://resources.tidal.com/images/aaaa/bbbb/cccc/80x80.jpg");
		expect(makeArtist("artist-cover-res-640").coverUrl("640")).toBe("https://resources.tidal.com/images/aaaa/bbbb/cccc/640x640.jpg");
	});

	test("has no url without a picture", () => {
		expect(makeArtist("artist-cover-none", { picture: undefined }).coverUrl()).toBeUndefined();
	});
});
