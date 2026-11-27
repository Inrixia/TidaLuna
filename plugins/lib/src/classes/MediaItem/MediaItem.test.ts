import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { reduxStore, resetTidalState, setTidalState } from "test/harness/tidalStore";

import type * as redux from "../../redux";
import { MediaItem } from "./MediaItem";
import { Quality } from "../Quality";
import { TidalApi } from "../TidalApi";

/**
 * `MediaItem` wraps the track TIDAL puts in its store and derives everything else from it, so these tests hand it
 * items shaped like TIDAL's and assert on what it derives. The MusicBrainz lookups are stubbed by stubbing `fetch`:
 * with no network `brainzJson` rejects, which is exactly the "MusicBrainz doesn't know this" path the accessors fall
 * back from.
 *
 * `ContentBase` caches instances by item id and `MediaItem` keeps formats and the actual audio quality in a
 * `ReactiveStore` by id, so every test uses its own ids rather than one shared fixture.
 */

let idSeq = 0;
/** An id no other test uses, either as an item id or as an album/artist id in TIDAL's store */
const nextId = () => 100_000 + ++idSeq;

const artistInline = (id: redux.ItemId, name = "An Artist"): redux.ArtistInline => ({ id, name, type: "MAIN", picture: "" });

/** The album reference TIDAL puts on a track: only the inline fields are populated */
const albumRef = (id: redux.ItemId, fields: Partial<redux.AlbumInline> = {}): redux.Album =>
	({ id, title: "An Album", cover: "", vibrantColor: "#000000", ...fields }) as redux.Album;

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

/** The cache `MediaItem` reads/writes through its `cache` constructor argument */
type MediaItemCacheArg = ConstructorParameters<typeof MediaItem>[3];

const makeMediaItem = (
	id: redux.ItemId,
	fields: Partial<redux.Track> = {},
	opts: { type?: redux.ContentType; cache?: MediaItemCacheArg } = {},
) => {
	const contentType = opts.type ?? "track";
	const tidalItem = track(id, fields);
	const mediaItem = { type: contentType, item: tidalItem } as unknown as redux.MediaItem;
	return new MediaItem(id, mediaItem, contentType, opts.cache ?? {});
};

/**
 * `ContentBase` reads TIDAL's content slices directly, so a slice a lookup needs has to exist even when it is empty.
 * Empty slices are seeded here and tests add what they want found.
 */
const seedContent = (content: Record<string, Record<string, unknown>> = {}) =>
	setTidalState({ content: { mediaItems: {}, albums: {}, artists: {}, ...content } as never });

beforeEach(() => {
	vi.restoreAllMocks();
	resetTidalState();
	// No network in tests: the MusicBrainz lookups reject and every accessor falls back to TIDAL's own data
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in tests")));
	vi.spyOn(TidalApi, "artist").mockResolvedValue(undefined);
	seedContent();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	resetTidalState();
});

describe("constructor", () => {
	test("keeps the item TIDAL stored and the type it was loaded as", () => {
		const id = nextId();
		const tidalItem = track(id, { title: "Hello" });
		const mediaItem = new MediaItem(id, { type: "track", item: tidalItem }, "track", {});

		expect(mediaItem.id).toBe(id);
		expect(mediaItem.contentType).toBe("track");
		expect(mediaItem.tidalItem).toBe(tidalItem);
	});

	test("throws when TIDAL's media item holds no item", () => {
		// A media item without an item means TIDAL changed shape or gave a failed load's placeholder
		expect(() => new MediaItem(nextId(), {} as redux.MediaItem, "track", {})).toThrow(/Tidal media item is undefined/);
	});
});

describe("properties", () => {
	test("trackNumber, volumeNumber and duration come from TIDAL's item", () => {
		const mediaItem = makeMediaItem(nextId(), { trackNumber: 7, volumeNumber: 2, duration: 321 });

		expect(mediaItem.trackNumber).toBe(7);
		expect(mediaItem.volumeNumber).toBe(2);
		expect(mediaItem.duration).toBe(321);
	});

	test("replayGainPeak is TIDAL's peak and replayGain is the track's gain", () => {
		const mediaItem = makeMediaItem(nextId(), { peak: 0.91, replayGain: -9.5 });

		expect(mediaItem.replayGainPeak).toBe(0.91);
		expect(mediaItem.replayGain).toBe(-9.5);
	});

	test("replayGain is 0 for a video, which has no gain", () => {
		expect(makeMediaItem(nextId(), { replayGain: -9.5 }, { type: "video" }).replayGain).toBe(0);
	});

	test("url is TIDAL's url for the item", () => {
		expect(makeMediaItem(nextId()).url).toMatch(/^http:\/\/www\.tidal\.com\/track\/\d+$/);
	});
});

describe("qualityTags", () => {
	test("maps TIDAL's metadata tags in order", () => {
		const mediaItem = makeMediaItem(nextId(), { mediaMetadata: { tags: ["HIRES_LOSSLESS", "MQA"] } });

		expect(mediaItem.qualityTags).toEqual([Quality.HiRes, Quality.MQA]);
	});

	test("adds a High placeholder for a lossy track without tags, so TidalTags can show a quality", () => {
		const mediaItem = makeMediaItem(nextId(), { mediaMetadata: { tags: [] }, audioQuality: "HIGH" });

		expect(mediaItem.qualityTags).toEqual([Quality.High]);
	});

	test("adds no placeholder for a lossless track without tags", () => {
		expect(makeMediaItem(nextId(), { mediaMetadata: { tags: [] }, audioQuality: "LOSSLESS" }).qualityTags).toEqual([]);
	});

	test("is empty for a video", () => {
		expect(makeMediaItem(nextId(), { mediaMetadata: { tags: ["LOSSLESS"] } }, { type: "video" }).qualityTags).toEqual([]);
	});
});

describe("qualityTags with a tag that has no known quality", () => {
	const unknown = "NOT_A_TAG" as unknown as redux.MediaMetadataTag;

	test("leaves the unknown tag out", () => {
		const mediaItem = makeMediaItem(nextId(), { mediaMetadata: { tags: [unknown, "MQA"] }, audioQuality: "HI_RES" });

		expect(mediaItem.qualityTags).toEqual([Quality.MQA]);
	});

	test("still adds the High placeholder to a lossy track", () => {
		const mediaItem = makeMediaItem(nextId(), { mediaMetadata: { tags: [unknown] }, audioQuality: "HIGH" });

		expect(mediaItem.qualityTags).toEqual([Quality.High]);
	});
});

describe("bestQuality", () => {
	test("is the highest of the metadata tags and TIDAL's audioQuality", () => {
		const mediaItem = makeMediaItem(nextId(), { mediaMetadata: { tags: ["LOSSLESS"] }, audioQuality: "HI_RES_LOSSLESS" });

		expect(mediaItem.bestQuality).toBe(Quality.HiRes);
	});

	test("is the audioQuality when the tags don't have a quality", () => {
		expect(makeMediaItem(nextId(), { mediaMetadata: { tags: [] }, audioQuality: "LOW" }).bestQuality).toBe(Quality.Lowest);
	});

	test("ignores a tag with no known quality instead of reporting Lowest", () => {
		const unknown = "NOT_A_TAG" as unknown as redux.MediaMetadataTag;
		const mediaItem = makeMediaItem(nextId(), { mediaMetadata: { tags: [unknown, "LOSSLESS"] }, audioQuality: "LOW" });

		expect(mediaItem.bestQuality).toBe(Quality.High);
	});

	test("defaults a spatial-only track with an unknown tag to HiRes", () => {
		const unknown = "NOT_A_TAG" as unknown as redux.MediaMetadataTag;
		const mediaItem = makeMediaItem(nextId(), { mediaMetadata: { tags: ["DOLBY_ATMOS", unknown] }, audioQuality: "LOSSLESS" });

		expect(mediaItem.bestQuality).toBe(Quality.HiRes);
	});

	test("ignores the spatial tags, which say nothing about the quality of the stream", () => {
		const mediaItem = makeMediaItem(nextId(), { mediaMetadata: { tags: ["DOLBY_ATMOS", "LOSSLESS"] }, audioQuality: "LOSSLESS" });

		expect(mediaItem.bestQuality).toBe(Quality.High);
	});

	test("defaults a spatial-only track to HiRes", () => {
		const mediaItem = makeMediaItem(nextId(), { mediaMetadata: { tags: ["DOLBY_ATMOS"] }, audioQuality: "LOSSLESS" });

		expect(mediaItem.bestQuality).toBe(Quality.HiRes);
	});

	test("uses the quality TIDAL actually played for a spatial-only track", () => {
		// Atmos falls back to a lossless stereo stream, the cache holds what was played
		const mediaItem = makeMediaItem(
			nextId(),
			{ mediaMetadata: { tags: ["DOLBY_ATMOS"] }, audioQuality: "LOSSLESS" },
			{ cache: { actualAudioQuality: "LOSSLESS" } },
		);

		expect(mediaItem.bestQuality).toBe(Quality.High);
	});

	test("is High for a video, and warns that it was asked", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(makeMediaItem(nextId(), {}, { type: "video" }).bestQuality).toBe(Quality.High);
		expect(warn).toHaveBeenCalled();
	});
});

describe("coverUrl", () => {
	test("is the album cover TIDAL's item carries, at 1280 by default", async () => {
		const mediaItem = makeMediaItem(nextId(), { album: album(1, { cover: "cover-uuid" }) });

		expect(await mediaItem.coverUrl()).toBe("https://resources.tidal.com/images/cover/uuid/1280x1280.jpg");
	});

	test("takes the resolution", async () => {
		const mediaItem = makeMediaItem(nextId(), { album: album(1, { cover: "cover-uuid" }) });

		expect(await mediaItem.coverUrl({ res: "320" })).toBe("https://resources.tidal.com/images/cover/uuid/320x320.jpg");
	});

	test("falls back to the album TIDAL's store has when the item's own copy has no cover", async () => {
		const albumId = nextId();
		seedContent({ albums: { [albumId]: album(albumId, { cover: "stored-uuid" }) } });
		const mediaItem = makeMediaItem(nextId(), { album: album(albumId, { cover: "" }) });

		expect(await mediaItem.coverUrl()).toBe("https://resources.tidal.com/images/stored/uuid/1280x1280.jpg");
	});

	test("has no url without an album", async () => {
		expect(await makeMediaItem(nextId()).coverUrl()).toBeUndefined();
	});
});

describe("album, artist and artists", () => {
	test("album is the album TIDAL's item references", async () => {
		const albumId = nextId();
		seedContent({ albums: { [albumId]: album(albumId, { title: "Stored Album" }) } });
		const mediaItem = makeMediaItem(nextId(), { album: albumRef(albumId) });

		expect((await mediaItem.album())?.tidalAlbum.title).toBe("Stored Album");
	});

	test("has no album without a reference", async () => {
		expect(await makeMediaItem(nextId()).album()).toBeUndefined();
	});

	test("artist prefers TIDAL's single artist over the artists list", async () => {
		const artistId = nextId();
		const listedId = nextId();
		seedContent({ artists: { [artistId]: { name: "Preferred" }, [listedId]: { name: "Listed" } } });
		const mediaItem = makeMediaItem(nextId(), { artist: artistInline(artistId), artists: [artistInline(listedId)] });

		expect((await mediaItem.artist())?.name).toBe("Preferred");
	});

	test("artist falls back to the first artist of the list", async () => {
		const artistId = nextId();
		seedContent({ artists: { [artistId]: { name: "First Listed" } } });
		const mediaItem = makeMediaItem(nextId(), { artists: [artistInline(artistId)] });

		expect((await mediaItem.artist())?.name).toBe("First Listed");
	});

	test("artist falls back to the album's artist", async () => {
		const albumId = nextId();
		const artistId = nextId();
		seedContent({
			albums: { [albumId]: album(albumId, { artist: artistInline(artistId), artists: [] }) },
			artists: { [artistId]: { name: "Album Artist" } },
		});
		const mediaItem = makeMediaItem(nextId(), { album: albumRef(albumId) });

		expect((await mediaItem.artist())?.name).toBe("Album Artist");
	});

	test("artists are the item's artists, in order", async () => {
		const firstId = nextId();
		const secondId = nextId();
		seedContent({ artists: { [firstId]: { name: "First" }, [secondId]: { name: "Second" } } });
		const mediaItem = makeMediaItem(nextId(), { artists: [artistInline(firstId, "First"), artistInline(secondId, "Second")] });

		expect(await MediaItem.artistNames(await mediaItem.artists())).toEqual(["First", "Second"]);
	});

	test("artists fall back to the album's artists when TIDAL's item has no artists list", async () => {
		const albumId = nextId();
		const artistId = nextId();
		seedContent({
			albums: { [albumId]: album(albumId, { artists: [artistInline(artistId)] }) },
			artists: { [artistId]: { name: "Album Artist" } },
		});
		const mediaItem = makeMediaItem(nextId(), { artists: undefined, album: albumRef(albumId) });

		expect(await MediaItem.artistNames(await mediaItem.artists())).toEqual(["Album Artist"]);
	});

	test("an empty artists list on the item is used as-is, it doesn't fall back", async () => {
		// Only a missing list falls back to the album; an empty one means TIDAL says the item has no artists
		const albumId = nextId();
		const artistId = nextId();
		seedContent({
			albums: { [albumId]: album(albumId, { artists: [artistInline(artistId)] }) },
			artists: { [artistId]: { name: "Album Artist" } },
		});
		const mediaItem = makeMediaItem(nextId(), { artists: [], album: albumRef(albumId) });

		expect(await mediaItem.artists()).toEqual([]);
	});
});

describe("releaseDate", () => {
	test("is the release date TIDAL's item carries", async () => {
		const mediaItem = makeMediaItem(nextId(), { releaseDate: "2021-03-04T00:00:00.000+0000" });

		expect(await mediaItem.releaseDate()).toEqual(new Date("2021-03-04T00:00:00.000+0000"));
		expect(await mediaItem.releaseDateStr()).toBe("2021-03-04");
	});

	test("falls back to when the item started streaming", async () => {
		const mediaItem = makeMediaItem(nextId(), { releaseDate: null, streamStartDate: "2019-06-05T00:00:00.000+0000" });

		expect(await mediaItem.releaseDate()).toEqual(new Date("2019-06-05T00:00:00.000+0000"));
		expect(await mediaItem.releaseDateStr()).toBe("2019-06-05");
	});

	test("has no date when TIDAL has none either", async () => {
		const mediaItem = makeMediaItem(nextId(), { releaseDate: null, streamStartDate: "soon" });

		expect(await mediaItem.releaseDate()).toBeUndefined();
		expect(await mediaItem.releaseDateStr()).toBeUndefined();
	});
});

describe("isrc", () => {
	test("is the isrc TIDAL's item carries", async () => {
		expect(await makeMediaItem(nextId(), { isrc: "US1234567890" }).isrc()).toBe("US1234567890");
	});

	test("fills a missing isrc from the tracks api", async () => {
		const id = nextId();
		const api = vi.spyOn(TidalApi, "track").mockResolvedValue(track(id, { isrc: "GB0987654321" }));
		const mediaItem = makeMediaItem(id, { isrc: null });

		expect(await mediaItem.isrc()).toBe("GB0987654321");
		expect(api).toHaveBeenCalledWith(id);
	});

	test("has none for a video, which the tracks api wouldn't know", async () => {
		const mediaItem = makeMediaItem(nextId(), { isrc: "US1234567890" }, { type: "video" });

		expect(await mediaItem.isrc()).toBeUndefined();
	});
});

describe("title", () => {
	test("is TIDAL's title", async () => {
		expect(await makeMediaItem(nextId(), { title: "Plain Title", version: null }).title()).toBe("Plain Title");
	});

	test("appends the version TIDAL gives", async () => {
		expect(await makeMediaItem(nextId(), { title: "Song", version: "Live" }).title()).toBe("Song (Live)");
	});
});

describe("fromId", () => {
	test("has no item without an id", async () => {
		expect(await MediaItem.fromId()).toBeUndefined();
	});

	test("resolves undefined when TIDAL never answers, as it does for an item that is gone", async () => {
		const id = nextId();
		vi.useFakeTimers();
		try {
			const loaded = MediaItem.fromId(id);
			// Nothing answers the load, so the 5s wait is what ends it
			await vi.advanceTimersByTimeAsync(5000);
			await expect(loaded).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	test("uses the media item TIDAL's store already has, without asking the api", async () => {
		const id = nextId();
		const tidalItem = track(id, { title: "Stored" });
		seedContent({ mediaItems: { [id]: { type: "track", item: tidalItem } } });
		const api = vi.spyOn(TidalApi, "track");

		const mediaItem = await MediaItem.fromId(id);

		expect(mediaItem).toBeInstanceOf(MediaItem);
		expect(mediaItem?.id).toBe(id);
		expect(mediaItem?.tidalItem.title).toBe("Stored");
		expect(api).not.toHaveBeenCalled();
	});

	test("returns the same instance for the same id", async () => {
		const id = nextId();
		seedContent({ mediaItems: { [id]: { type: "track", item: track(id) } } });

		const first = await MediaItem.fromId(id);
		const second = await MediaItem.fromId(id);

		expect(second).toBe(first);
	});

	test("uses the type TIDAL stored the item with, not the caller's default", async () => {
		const id = nextId();
		// Callers default to "track"; a video stored by TIDAL must stay a video
		seedContent({ mediaItems: { [id]: { type: "video", item: track(id) } } });

		const mediaItem = await MediaItem.fromId(id);

		expect(mediaItem?.contentType).toBe("video");
	});

	test("loads the item through TIDAL when its store doesn't have it", async () => {
		const id = nextId();
		const tidalItem = track(id, { title: "Loaded" });
		const storeDispatch = reduxStore.dispatch.bind(reduxStore);
		type DispatchedAction = { type?: string; payload?: unknown };
		/**
		 * TIDAL's action creators are what run Luna's interceptors (see exposeTidalInternals.patchAction), so the load's
		 * response has to be built by a patched creator — dispatching the action object alone would not reach the wait.
		 */
		const tidalAction = (type: string) => {
			const actionCreators = { _: (actionType: string) => (payload?: unknown) => ({ type: actionType, payload }) };
			window.patchAction(actionCreators);
			return actionCreators._(type);
		};
		const dispatch = vi.spyOn(reduxStore, "dispatch").mockImplementation((action: DispatchedAction) => {
			const result = storeDispatch(action as never);
			if (action.type === "content/LOAD_SINGLE_MEDIA_ITEM") {
				// TIDAL answers a load with its own action, dispatched after the one that asked for it
				void Promise.resolve().then(() => {
					// Building the action through the patched creator is what lets the wait see it
					const loaded = tidalAction("content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS");
					reduxStore.dispatch(loaded({ mediaItem: { type: "track", item: tidalItem } }) as never);
				});
			}
			return result;
		});

		const mediaItem = await MediaItem.fromId(id);

		expect(dispatch.mock.calls.map(([action]) => (action as DispatchedAction).type)).toEqual([
			"content/LOAD_SINGLE_MEDIA_ITEM",
			"content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS",
		]);
		expect((dispatch.mock.calls[0][0] as DispatchedAction).payload).toEqual({ id, itemType: "track" });
		expect(mediaItem?.tidalItem.title).toBe("Loaded");
	});
});

describe("fromIsrc", () => {
	let isrcSeq = 0;
	/** A fresh isrc each time: fromIsrc remembers its answers */
	const nextIsrc = () => `TESTISRC${++isrcSeq}`;
	type Found = { tags?: string[]; loaded?: Quality | null };
	/** TIDAL's isrc lookup finds these tracks in this order; `loaded` is the best quality of the item MediaItem.fromId gives for it, null for none */
	const lookup = (...found: Found[]) => {
		const ids = found.map(() => String(nextId()));
		vi.spyOn(TidalApi, "isrc").mockImplementation(async function* () {
			for (const [i, { tags }] of found.entries()) yield { id: ids[i], attributes: { mediaTags: tags } } as never;
		});
		const loads: string[] = [];
		vi.spyOn(MediaItem, "fromId").mockImplementation((async (id: redux.ItemId) => {
			loads.push(String(id));
			const { loaded } = found[ids.indexOf(String(id))];
			return loaded === null || loaded === undefined ? undefined : ({ id, bestQuality: loaded } as unknown as MediaItem);
		}) as never);
		return { ids, loads };
	};
	afterEach(() => vi.restoreAllMocks());

	test("picks the only track even when it has no tags or none Luna knows", async () => {
		const { ids } = lookup({ tags: [], loaded: Quality.High });
		await expect(MediaItem.fromIsrc(nextIsrc())).resolves.toMatchObject({ id: ids[0] });

		const unknown = lookup({ tags: ["SOMETHING_NEW"], loaded: Quality.Lowest });
		await expect(MediaItem.fromIsrc(nextIsrc())).resolves.toMatchObject({ id: unknown.ids[0] });
	});

	test("takes a later track only when its tags say it is better", async () => {
		const better = lookup({ tags: ["LOSSLESS"], loaded: Quality.High }, { tags: ["MQA"], loaded: Quality.MQA });
		await expect(MediaItem.fromIsrc(nextIsrc())).resolves.toMatchObject({ id: better.ids[1] });

		const worse = lookup(
			{ tags: ["MQA"], loaded: Quality.MQA },
			{ tags: ["LOSSLESS"], loaded: Quality.High },
			{ tags: [], loaded: Quality.Lowest },
		);
		await expect(MediaItem.fromIsrc(nextIsrc())).resolves.toMatchObject({ id: worse.ids[0] });
		// The worse tracks are not even loaded
		expect(worse.loads).toEqual([worse.ids[0]]);
	});

	test("stops loading once a track has the highest quality", async () => {
		const { ids, loads } = lookup({ tags: ["HIRES_LOSSLESS"], loaded: Quality.Max }, { tags: ["HIRES_LOSSLESS"], loaded: Quality.Max });
		await expect(MediaItem.fromIsrc(nextIsrc())).resolves.toMatchObject({ id: ids[0] });
		expect(loads).toEqual([ids[0]]);
	});

	test("goes on to the next track when one can't be loaded, and is undefined when none can", async () => {
		const some = lookup({ tags: ["MQA"], loaded: null }, { tags: [], loaded: Quality.High });
		await expect(MediaItem.fromIsrc(nextIsrc())).resolves.toMatchObject({ id: some.ids[1] });

		lookup({ tags: ["MQA"], loaded: null });
		await expect(MediaItem.fromIsrc(nextIsrc())).resolves.toBeUndefined();
	});

	test("asks TIDAL again when a lookup timed out, instead of remembering no track", async () => {
		const isrc = nextIsrc();
		const id = nextId();
		// A real timeout marks the id, through the same path a slow TIDAL takes
		vi.useFakeTimers();
		try {
			const timedOut = MediaItem.fromId(id);
			await vi.advanceTimersByTimeAsync(5000);
			await timedOut;
		} finally {
			vi.useRealTimers();
		}

		const isrcLookup = vi.spyOn(TidalApi, "isrc").mockImplementation(async function* () {
			yield { id, attributes: { mediaTags: [] } } as never;
		});
		// fromId answers as the timeout did, with the id still marked
		vi.spyOn(MediaItem, "fromId").mockImplementation((async () => undefined) as never);

		await expect(MediaItem.fromIsrc(isrc)).resolves.toBeUndefined();
		await expect(MediaItem.fromIsrc(isrc)).resolves.toBeUndefined();
		// Twice, because a timeout says nothing about whether the track exists
		expect(isrcLookup).toHaveBeenCalledTimes(2);

		// The same answer from a track that did not time out is an answer, and is remembered: that is the difference the
		// timeout case rests on. The spy is the same object, so its count is cleared rather than replaced
		const remembered = nextIsrc();
		isrcLookup.mockClear();
		isrcLookup.mockImplementation(async function* () {
			yield { id: nextId(), attributes: { mediaTags: [] } } as never;
		});
		await expect(MediaItem.fromIsrc(remembered)).resolves.toBeUndefined();
		await expect(MediaItem.fromIsrc(remembered)).resolves.toBeUndefined();
		expect(isrcLookup).toHaveBeenCalledTimes(1);
	});
});
