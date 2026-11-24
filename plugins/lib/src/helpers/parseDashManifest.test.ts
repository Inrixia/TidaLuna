import { describe, expect, test } from "vitest";

import { parseDashManifest } from "./parseDashManifest";

// The dom project runs in happy-dom, so DOMParser (which the parser needs, as it runs in TIDAL's renderer) is global

const manifestUrl = "https://sp-ad-cf.audio.tidal.com";
const cdn = "https://sp-ad-fa.audio.tidal.com/mediatracks/FAKEID";
// TIDAL's real tokens have ~ and =, which must stay as they are
const token = "token=1795437863~ZmFrZQ==~abc";

// Real TIDAL manifests (track 1550546) with the token and media id replaced. TIDAL writes the xml declaration with single quotes,
// which happy-dom rejects, so it is double quoted here
const aac = `<?xml version="1.0" encoding="UTF-8"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:cenc="urn:mpeg:cenc:2013" xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd" profiles="urn:mpeg:dash:profile:isoff-main:2011" type="static" minBufferTime="PT3.993S" mediaPresentationDuration="PT5M20.403S"><Period id="0"><AdaptationSet id="0" contentType="audio" mimeType="audio/mp4" lang="und" group="main" segmentAlignment="true"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><Representation id="AACLC" codecs="mp4a.40.2" bandwidth="321702" audioSamplingRate="44100"><AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/><SegmentTemplate timescale="44100" initialization="${cdn}/0.mp4?${token}" media="${cdn}/$Number$.mp4?${token}" startNumber="1"><SegmentTimeline><S d="176128" r="79"/><S d="39552"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`;
const flac = `<?xml version="1.0" encoding="UTF-8"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:cenc="urn:mpeg:cenc:2013" xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd" profiles="urn:mpeg:dash:profile:isoff-main:2011" type="static" minBufferTime="PT3.993S" mediaPresentationDuration="PT5M20.357S"><Period id="0"><AdaptationSet id="0" contentType="audio" mimeType="audio/mp4" lang="und" group="main" segmentAlignment="true"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><Representation id="FLAC,44100,16" codecs="flac" bandwidth="1004121" audioSamplingRate="44100"><AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/><SegmentTemplate timescale="44100" initialization="${cdn}/0.mp4?${token}&amp;info=ZmFrZQ" media="${cdn}/$Number$.mp4?${token}&amp;info=ZmFrZQ" startNumber="1"><SegmentTimeline><S d="176128" r="79"/><S d="37504"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`;

const timeline = /<SegmentTimeline>.*<\/SegmentTimeline>/;
const urls = (text: string) => parseDashManifest(text, manifestUrl).tracks.audios[0].segments.map(({ url }) => url);

describe("parseDashManifest", () => {
	test("real AAC manifest", () => {
		const { duration, tracks } = parseDashManifest(aac, manifestUrl);
		expect(duration).toBe(320.403);
		expect(tracks.audios.length).toBe(1);
		const [track] = tracks.audios;
		expect(track.codec).toBe("AAC");
		expect(track.bitrate.bps).toBe(321702);
		expect(track.size.b).toBe(321702 * 320.403);
		// init + 80 from r="79" + 1
		expect(track.segments.length).toBe(82);
		expect(track.segments[0]).toEqual({ url: `${cdn}/0.mp4?${token}`, init: true });
		expect(track.segments[1]).toEqual({ url: `${cdn}/1.mp4?${token}` });
		expect(track.segments[81]).toEqual({ url: `${cdn}/81.mp4?${token}` });
	});

	test("real FLAC manifest keeps the token and &amp; as written", () => {
		const [track] = parseDashManifest(flac, manifestUrl).tracks.audios;
		expect(track.codec).toBe("FLAC");
		expect(track.bitrate.bps).toBe(1004121);
		expect(track.segments.length).toBe(82);
		expect(track.segments[0].url).toBe(`${cdn}/0.mp4?${token}&info=ZmFrZQ`);
		expect(track.segments[81].url).toBe(`${cdn}/81.mp4?${token}&info=ZmFrZQ`);
	});

	test("template variables, padding and $$", () => {
		const text = aac
			.replace(timeline, "")
			.replace('timescale="44100"', 'timescale="1" duration="100"')
			.replace(`${cdn}/$Number$.mp4?${token}`, "$RepresentationID$/$Bandwidth$/$Number%05d$-$Time$-$$-$Unknown$.mp4");
		const segments = urls(text);
		// ceil(320.403 / 100) = 4 segments after init
		expect(segments.length).toBe(5);
		expect(segments[1]).toBe("https://sp-ad-cf.audio.tidal.com/AACLC/321702/00001-1-$-$Unknown$.mp4");
		expect(segments[4]).toBe("https://sp-ad-cf.audio.tidal.com/AACLC/321702/00004-4-$-$Unknown$.mp4");
	});

	test("timeline t and r give $Time$", () => {
		const text = aac
			.replace(timeline, '<SegmentTimeline><S t="100" d="10" r="1"/><S d="5"/><S t="1000" d="1"/></SegmentTimeline>')
			.replace("$Number$", "$Number$-$Time$");
		expect(
			urls(text)
				.slice(1)
				.map((url) => url.split("/").pop()!.split(".")[0]),
		).toEqual(["1-100", "2-110", "3-120", "4-1000"]);
	});

	test("BaseURLs resolve down the tree", () => {
		const text = aac
			.replace('<Period id="0">', '<BaseURL>https://example.com/a/</BaseURL><Period id="0"><BaseURL>b/</BaseURL>')
			.replace("<Role", "<BaseURL>c/</BaseURL><Role")
			.replace(`${cdn}/$Number$.mp4?${token}`, "$Number$.mp4")
			.replace(`${cdn}/0.mp4?${token}`, "init.mp4");
		expect(urls(text).slice(0, 2)).toEqual(["https://example.com/a/b/c/init.mp4", "https://example.com/a/b/c/1.mp4"]);
	});

	test("audio is found by codec when no type is declared, and video is skipped", () => {
		const untyped = aac.replace(' contentType="audio" mimeType="audio/mp4"', "");
		expect(parseDashManifest(untyped, manifestUrl).tracks.audios[0].codec).toBe("AAC");
		const withVideo = aac.replace(
			"<AdaptationSet",
			'<AdaptationSet contentType="video"><Representation id="v" codecs="avc1.64001f,mp4a.40.2" bandwidth="1"><SegmentTemplate media="v$Number$.mp4" duration="1"/></Representation></AdaptationSet><AdaptationSet',
		);
		expect(parseDashManifest(withVideo, manifestUrl).tracks.audios.length).toBe(1);
	});

	test("hostile or unsupported input throws", () => {
		const throws = (text: string, message: RegExp) => expect(() => parseDashManifest(text, manifestUrl)).toThrow(message);
		throws('#EXTM3U\n#EXT-X-DATERANGE:ID="__proto__",START-DATE="2020-01-01T00:00:00Z"', /Invalid DASH manifest/);
		throws(aac.replace("</MPD>", ""), /Invalid DASH manifest/);
		throws(aac.replace(/<Period[^>]*>.*<\/Period>/, ""), /no Period/);
		throws(aac.replace('codecs="mp4a.40.2"', 'codecs="constructor"'), /Unsupported DASH audio codecs/);
		throws(aac.replace('contentType="audio"', 'contentType="video"'), /no audio track/);
		throws(aac.replace(/<SegmentTemplate.*<\/SegmentTemplate>/, ""), /no SegmentTemplate/);
		throws(aac.replace(timeline, '<SegmentTimeline><S d="10" r="-1"/></SegmentTimeline>'), /Unsupported DASH SegmentTimeline/);
		throws(aac.replace(timeline, '<SegmentTimeline><S d="0"/></SegmentTimeline>'), /Unsupported DASH SegmentTimeline/);
		// Millions of segments, from a huge r or a tiny segment duration, stop at the cap
		throws(aac.replace(timeline, '<SegmentTimeline><S d="1" r="1000000000"/></SegmentTimeline>'), /too many segments/);
		throws(aac.replace(timeline, "").replace('timescale="44100"', 'timescale="1000000000" duration="1"'), /too many segments/);
		expect(Object.hasOwn(Object.prototype, "startDate")).toBe(false);
	});
});
