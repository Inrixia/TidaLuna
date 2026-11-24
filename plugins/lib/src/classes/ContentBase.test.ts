import type { IArtistCredit } from "musicbrainz-api";
import { describe, expect, test } from "vitest";

import type * as redux from "../redux";
import type { Artist } from "./Artist";
import { ContentBase } from "./ContentBase";

/** `getAlbumCoverUrl` only reads the two cover uuids, the rest of TIDAL's album is irrelevant here */
const album = (fields: { cover?: string; videoCover?: string }) => fields as unknown as redux.Album;
/** `artistNames` only reads `name` */
const artist = (name?: string) => ({ name }) as unknown as Artist;
/** `formatTitle` only reads `joinphrase` */
const credit = (joinphrase?: string) => ({ joinphrase }) as unknown as IArtistCredit;

/** `formatTitle` is protected: these tests reach it through a cast so its rules are covered directly */
const formatTitle = (
	ContentBase as unknown as {
		formatTitle: (tidalTitle?: string, tidalVersion?: string, brainzTitle?: string, brainzCredit?: IArtistCredit[]) => string;
	}
).formatTitle;

describe("normalizeQuotes", () => {
	test("replaces typographic single quotes", () => {
		expect(ContentBase.normalizeQuotes("‘single’ and ‛single‛")).toBe("'single' and 'single'");
	});

	test("replaces typographic double quotes", () => {
		expect(ContentBase.normalizeQuotes("“double” and „double„")).toBe('"double" and "double"');
	});

	test("leaves plain quotes and other punctuation alone", () => {
		const plain = `'plain' "quotes" - and ~ dashes…`;
		expect(ContentBase.normalizeQuotes(plain)).toBe(plain);
		expect(ContentBase.normalizeQuotes("")).toBe("");
	});
});

describe("formatCoverUrl", () => {
	test("splits the uuid into the image path at 1280", () => {
		expect(ContentBase.formatCoverUrl("a-b-c")).toBe("https://resources.tidal.com/images/a/b/c/1280x1280.jpg");
	});

	test("uses the requested resolution", () => {
		expect(ContentBase.formatCoverUrl("a-b-c", { res: "80" })).toBe("https://resources.tidal.com/images/a/b/c/80x80.jpg");
	});

	test("formats video covers as mp4", () => {
		expect(ContentBase.formatCoverUrl("a-b-c", { type: "video" })).toBe("https://resources.tidal.com/videos/a/b/c/1280x1280.mp4");
		expect(ContentBase.formatCoverUrl("a-b-c", { type: "video", res: "320" })).toBe("https://resources.tidal.com/videos/a/b/c/320x320.mp4");
	});

	test("keeps every segment of the uuid", () => {
		expect(ContentBase.formatCoverUrl("a-b-c-d")).toBe("https://resources.tidal.com/images/a/b/c/d/1280x1280.jpg");
		expect(ContentBase.formatCoverUrl("abc")).toBe("https://resources.tidal.com/images/abc/1280x1280.jpg");
	});

	test("has no url without a uuid", () => {
		expect(ContentBase.formatCoverUrl()).toBeUndefined();
		expect(ContentBase.formatCoverUrl("")).toBeUndefined();
	});
});

describe("getAlbumCoverUrl", () => {
	const imageOnly = album({ cover: "img-a-b" });
	const withVideo = album({ cover: "img-a-b", videoCover: "vid-x-y" });

	test("defaults to the image cover at 1280", () => {
		expect(ContentBase.getAlbumCoverUrl(imageOnly)).toBe("https://resources.tidal.com/images/img/a/b/1280x1280.jpg");
	});

	test("uses the requested resolution", () => {
		expect(ContentBase.getAlbumCoverUrl(imageOnly, { res: "640" })).toBe("https://resources.tidal.com/images/img/a/b/640x640.jpg");
	});

	test("ignores the video cover for an image request", () => {
		expect(ContentBase.getAlbumCoverUrl(withVideo, { type: "image" })).toBe("https://resources.tidal.com/images/img/a/b/1280x1280.jpg");
	});

	test("uses the video cover for a video request", () => {
		expect(ContentBase.getAlbumCoverUrl(withVideo, { type: "video" })).toBe("https://resources.tidal.com/videos/vid/x/y/1280x1280.mp4");
		expect(ContentBase.getAlbumCoverUrl(withVideo, { type: "video", fallback: false })).toBe(
			"https://resources.tidal.com/videos/vid/x/y/1280x1280.mp4",
		);
	});

	test("is undefined for a video request without fallback or a video cover", () => {
		expect(ContentBase.getAlbumCoverUrl(imageOnly, { type: "video", fallback: false })).toBeUndefined();
	});

	test("has no url without a cover", () => {
		expect(ContentBase.getAlbumCoverUrl(album({}))).toBeUndefined();
		expect(ContentBase.getAlbumCoverUrl(album({ cover: "" }))).toBeUndefined();
	});

	test("has no url without an album", () => {
		expect(ContentBase.getAlbumCoverUrl()).toBeUndefined();
		expect(ContentBase.getAlbumCoverUrl(null)).toBeUndefined();
	});

	test("falls back to the image url, not an mp4, for a video request without a video cover", () => {
		expect(ContentBase.getAlbumCoverUrl(imageOnly, { type: "video" })).toBe("https://resources.tidal.com/images/img/a/b/1280x1280.jpg");
		expect(ContentBase.getAlbumCoverUrl(imageOnly, { type: "video", res: "640" })).toBe("https://resources.tidal.com/images/img/a/b/640x640.jpg");
	});
});

describe("artistNames", () => {
	test("awaits every artist and keeps the names in order", async () => {
		const artists = [Promise.resolve(artist("First")), Promise.resolve(artist("Second")), Promise.resolve(artist("Third"))];
		expect(await ContentBase.artistNames(artists)).toEqual(["First", "Second", "Third"]);
	});

	test("accepts a promise of the artist list", async () => {
		expect(await ContentBase.artistNames(Promise.resolve([Promise.resolve(artist("Only"))]))).toEqual(["Only"]);
	});

	test("drops artists that are missing or have no name", async () => {
		const artists = [Promise.resolve(undefined), Promise.resolve(artist()), Promise.resolve(artist("")), Promise.resolve(artist("Named"))];
		expect(await ContentBase.artistNames(artists)).toEqual(["Named"]);
	});

	test("has no names without artists", async () => {
		expect(await ContentBase.artistNames()).toEqual([]);
		expect(await ContentBase.artistNames([])).toEqual([]);
		expect(await ContentBase.artistNames(Promise.resolve([]))).toEqual([]);
	});
});

describe("formatTitle", () => {
	test("prefers the MusicBrainz title", () => {
		expect(formatTitle("Tidal Title", undefined, "Brainz Title")).toBe("Brainz Title");
	});

	test("falls back to the TIDAL title", () => {
		expect(formatTitle("Tidal Title")).toBe("Tidal Title");
		expect(formatTitle("Tidal Title", undefined, undefined)).toBe("Tidal Title");
	});

	test("normalizes quotes in the MusicBrainz title", () => {
		expect(formatTitle("Tidal ‘Title’", undefined, "Brainz “Title”")).toBe('Brainz "Title"');
	});

	test("keeps the TIDAL feat. title when MusicBrainz credits one", () => {
		expect(formatTitle("Song feat. Guest", undefined, "Song", [credit(" feat. ")])).toBe("Song feat. Guest");
	});

	test("keeps the MusicBrainz title when it already has feat.", () => {
		expect(formatTitle("Song feat. Guest", undefined, "Song feat. Other Guest", [credit(" feat. ")])).toBe("Song feat. Other Guest");
	});

	test("keeps the MusicBrainz title when no credit joins with feat.", () => {
		expect(formatTitle("Song feat. Guest", undefined, "Song", [credit(" & ")])).toBe("Song");
		expect(formatTitle("Song feat. Guest", undefined, "Song", [])).toBe("Song");
	});

	test("keeps the MusicBrainz title when the TIDAL title has no feat.", () => {
		expect(formatTitle("Song", undefined, "Brainz Song", [credit(" feat. ")])).toBe("Brainz Song");
	});

	test("appends the TIDAL version", () => {
		expect(formatTitle("Song", "Remastered")).toBe("Song (Remastered)");
		expect(formatTitle("Song", "Live", "Brainz Song")).toBe("Brainz Song (Live)");
	});

	test("appends the version to a TIDAL feat. title", () => {
		expect(formatTitle("Song feat. Guest", "Live", "Song", [credit(" feat. ")])).toBe("Song feat. Guest (Live)");
	});

	test("does not append a version the title already has", () => {
		expect(formatTitle("Song (Deluxe Edition)", "Deluxe Edition")).toBe("Song (Deluxe Edition)");
		expect(formatTitle("Song (deluxe edition)", "Deluxe Edition")).toBe("Song (deluxe edition)");
	});

	test("compares the version with quotes normalized", () => {
		expect(formatTitle("Song (Deluxe “Edition”)", 'Deluxe "Edition"')).toBe("Song (Deluxe “Edition”)");
	});

	test("does not append an empty version", () => {
		expect(formatTitle("Song", "")).toBe("Song");
	});

	test("throws without a title", () => {
		expect(() => formatTitle()).toThrow("Title is undefined");
		expect(() => formatTitle(undefined, "Live")).toThrow("Title is undefined");
		expect(() => formatTitle(undefined, undefined, undefined, [credit(" feat. ")])).toThrow("Title is undefined");
	});
});
