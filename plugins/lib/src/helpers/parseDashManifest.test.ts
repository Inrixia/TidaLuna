// Run: pnpm exec tsx --test plugins/lib/src/helpers/parseDashManifest.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { Window } from "happy-dom";

import { parseDashManifest } from "./parseDashManifest";

// The parser runs in the renderer, which has DOMParser; node doesn't
globalThis.DOMParser = new Window().DOMParser as unknown as typeof DOMParser;

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

test("real AAC manifest", () => {
	const { duration, tracks } = parseDashManifest(aac, manifestUrl);
	assert.equal(duration, 320.403);
	assert.equal(tracks.audios.length, 1);
	const [track] = tracks.audios;
	assert.equal(track.codec, "AAC");
	assert.equal(track.bitrate.bps, 321702);
	assert.equal(track.size.b, 321702 * 320.403);
	// init + 80 from r="79" + 1
	assert.equal(track.segments.length, 82);
	assert.deepEqual(track.segments[0], { url: `${cdn}/0.mp4?${token}`, init: true });
	assert.deepEqual(track.segments[1], { url: `${cdn}/1.mp4?${token}` });
	assert.deepEqual(track.segments[81], { url: `${cdn}/81.mp4?${token}` });
});

test("real FLAC manifest keeps the token and &amp; as written", () => {
	const [track] = parseDashManifest(flac, manifestUrl).tracks.audios;
	assert.equal(track.codec, "FLAC");
	assert.equal(track.bitrate.bps, 1004121);
	assert.equal(track.segments.length, 82);
	assert.equal(track.segments[0].url, `${cdn}/0.mp4?${token}&info=ZmFrZQ`);
	assert.equal(track.segments[81].url, `${cdn}/81.mp4?${token}&info=ZmFrZQ`);
});

test("template variables, padding and $$", () => {
	const text = aac
		.replace(timeline, "")
		.replace('timescale="44100"', 'timescale="1" duration="100"')
		.replace(`${cdn}/$Number$.mp4?${token}`, "$RepresentationID$/$Bandwidth$/$Number%05d$-$Time$-$$-$Unknown$.mp4");
	const segments = urls(text);
	// ceil(320.403 / 100) = 4 segments after init
	assert.equal(segments.length, 5);
	assert.equal(segments[1], "https://sp-ad-cf.audio.tidal.com/AACLC/321702/00001-1-$-$Unknown$.mp4");
	assert.equal(segments[4], "https://sp-ad-cf.audio.tidal.com/AACLC/321702/00004-4-$-$Unknown$.mp4");
});

test("timeline t and r give $Time$", () => {
	const text = aac
		.replace(timeline, '<SegmentTimeline><S t="100" d="10" r="1"/><S d="5"/><S t="1000" d="1"/></SegmentTimeline>')
		.replace("$Number$", "$Number$-$Time$");
	assert.deepEqual(
		urls(text)
			.slice(1)
			.map((url) => url.split("/").pop()!.split(".")[0]),
		["1-100", "2-110", "3-120", "4-1000"],
	);
});

test("BaseURLs resolve down the tree", () => {
	const text = aac
		.replace('<Period id="0">', '<BaseURL>https://example.com/a/</BaseURL><Period id="0"><BaseURL>b/</BaseURL>')
		.replace("<Role", "<BaseURL>c/</BaseURL><Role")
		.replace(`${cdn}/$Number$.mp4?${token}`, "$Number$.mp4")
		.replace(`${cdn}/0.mp4?${token}`, "init.mp4");
	assert.deepEqual(urls(text).slice(0, 2), ["https://example.com/a/b/c/init.mp4", "https://example.com/a/b/c/1.mp4"]);
});

test("audio is found by codec when no type is declared, and video is skipped", () => {
	const untyped = aac.replace(' contentType="audio" mimeType="audio/mp4"', "");
	assert.equal(parseDashManifest(untyped, manifestUrl).tracks.audios[0].codec, "AAC");
	const withVideo = aac.replace(
		"<AdaptationSet",
		'<AdaptationSet contentType="video"><Representation id="v" codecs="avc1.64001f,mp4a.40.2" bandwidth="1"><SegmentTemplate media="v$Number$.mp4" duration="1"/></Representation></AdaptationSet><AdaptationSet',
	);
	assert.equal(parseDashManifest(withVideo, manifestUrl).tracks.audios.length, 1);
});

test("hostile or unsupported input throws", () => {
	const throws = (text: string, message: RegExp) => assert.throws(() => parseDashManifest(text, manifestUrl), message);
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
	assert.equal(Object.hasOwn(Object.prototype, "startDate"), false);
});
