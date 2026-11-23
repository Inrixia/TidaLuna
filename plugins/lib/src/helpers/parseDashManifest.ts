export type DashSegment = { url: string; init?: true };
export type DashAudioTrack = {
	/** Normalised codec name, eg `FLAC` or `AAC` */
	codec: string;
	bitrate: { bps: number };
	/** Estimated in bits: bandwidth (bits/s) times duration, as dasha computed it */
	size: { b: number };
	/** The init segment first, then the media segments in order */
	segments: DashSegment[];
};
export type DashManifest = {
	/** Seconds */
	duration: number;
	tracks: { audios: DashAudioTrack[] };
};

// A Map, so a codecs value like "constructor" can't hit Object.prototype
const audioCodecs = new Map(Object.entries({ mp4a: "AAC", "ac-3": "DD", "ec-3": "DD+", opus: "OPUS", dtsc: "DTS", alac: "ALAC", flac: "FLAC" }));
// More segments than this across the manifest is not a track, so stop rather than build millions of urls
const maxSegments = 100_000;

// ISO 8601 duration as MPDs write it, eg PT4M7.679S
const parseDuration = (duration = "") => {
	const [, d = 0, h = 0, m = 0, s = 0] = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(duration) ?? [];
	return +d * 86400 + +h * 3600 + +m * 60 + +s;
};

// $Name$ or $Name%0<width>d$ from values, $$ is a literal $. Unknown names are left as they are
const fillTemplate = (template: string, values: Record<string, string | number>) =>
	template.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (match, name: string, width = "0") => {
		if (name === "") return "$";
		if (!Object.hasOwn(values, name)) return match;
		return name === "RepresentationID" ? String(values[name]) : String(values[name]).padStart(+width, "0");
	});

const childrenOf = (el: Element, name: string) => Array.from(el.children).filter((child) => child.localName === name);
const childOf = (el: Element, name: string) => childrenOf(el, name)[0];
// The first of els (most specific first) that has the attribute
const attrOf = (name: string, ...els: (Element | undefined)[]) => els.find((el) => el?.hasAttribute(name))?.getAttribute(name) ?? undefined;
// BaseURLs resolve against the one above them, down to the manifest url
const baseUrlOf = (els: Element[], manifestUrl: string) =>
	els.reduce((base, el) => new URL(childOf(el, "BaseURL")?.textContent?.trim() ?? "", base).href, manifestUrl);

/**
 * Parses the DASH manifest of a TIDAL track into its audio tracks.
 * Handles SegmentTemplate addressing, which is all TIDAL uses, and throws on anything else.
 * Segment urls are kept as the manifest writes them: TIDAL's CDN rejects tokens with `~` or `=` percent-encoded.
 */
export const parseDashManifest = (text: string, manifestUrl: string): DashManifest => {
	const doc = new DOMParser().parseFromString(text, "application/xml");
	const mpd = doc.documentElement;
	// Chromium keeps the root of broken xml and adds a parsererror element, so check for both
	if (mpd.localName !== "MPD" || doc.getElementsByTagName("parsererror").length !== 0) throw new Error("Invalid DASH manifest");
	const period = childOf(mpd, "Period");
	if (period === undefined) throw new Error("DASH manifest has no Period");
	const duration = parseDuration(attrOf("duration", period) ?? attrOf("mediaPresentationDuration", mpd));

	const audios: DashAudioTrack[] = [];
	let segmentCount = 0;
	for (const adaptationSet of childrenOf(period, "AdaptationSet")) {
		for (const rep of childrenOf(adaptationSet, "Representation")) {
			// Attributes left off a Representation are inherited from its AdaptationSet
			const attr = (name: string) => attrOf(name, rep, adaptationSet);
			const codecs = attr("codecs") ?? "";
			const codec = codecs
				.split(",")
				.map((c) => audioCodecs.get(c.trim().toLowerCase().split(".")[0]))
				.find((c) => c !== undefined);
			// Without a declared type, a known audio codec makes it audio
			const contentType = attr("contentType") ?? attr("mimeType")?.split("/")[0] ?? (codec && "audio");
			if (contentType !== "audio") continue;
			if (codec === undefined) throw new Error(`Unsupported DASH audio codecs "${codecs}"`);

			const template = childOf(rep, "SegmentTemplate") ?? childOf(adaptationSet, "SegmentTemplate");
			const media = template?.getAttribute("media");
			if (template === undefined || !media) throw new Error("DASH manifest has no SegmentTemplate");
			const base = baseUrlOf([mpd, period, adaptationSet, rep], manifestUrl);
			const bandwidth = Number(attr("bandwidth"));
			const values = { Bandwidth: bandwidth, RepresentationID: attr("id") ?? "" };

			const segments: DashSegment[] = [];
			const push = (pattern: string, extra: Record<string, number>, init?: true) => {
				if (++segmentCount > maxSegments) throw new Error("DASH manifest has too many segments");
				segments.push({ url: new URL(fillTemplate(pattern, { ...values, ...extra }), base).href, ...(init && { init }) });
			};
			const initialization = template.getAttribute("initialization");
			if (initialization !== null) push(initialization, {}, true);

			let number = Number(template.getAttribute("startNumber") ?? 1);
			const timeline = childOf(template, "SegmentTimeline");
			if (timeline !== undefined) {
				// Each S is a run of r + 1 segments of length d, starting at t or where the last one ended
				let time = 0;
				for (const s of childrenOf(timeline, "S")) {
					time = Number(s.getAttribute("t") ?? time);
					const d = Number(s.getAttribute("d"));
					const repeat = Number(s.getAttribute("r") ?? 0);
					// A negative r (repeat until the next S or the end) only shows up in live manifests
					if (!(d > 0) || !(repeat >= 0)) throw new Error("Unsupported DASH SegmentTimeline");
					if (segmentCount + repeat >= maxSegments) throw new Error("DASH manifest has too many segments");
					for (let i = 0; i <= repeat; i++, time += d) push(media, { Number: number++, Time: time });
				}
			} else {
				// Fixed length segments: as many as fit the duration. $Time$ falls back to the number, as dasha did
				const count = Math.ceil(duration / (Number(template.getAttribute("duration")) / Number(template.getAttribute("timescale") ?? 1)));
				if (!(count > 0)) throw new Error("DASH manifest has no valid segment count");
				if (segmentCount + count > maxSegments) throw new Error("DASH manifest has too many segments");
				for (const end = number + count; number < end; number++) push(media, { Number: number, Time: number });
			}
			audios.push({ codec, bitrate: { bps: bandwidth }, size: { b: bandwidth * duration }, segments });
		}
	}
	if (audios.length === 0) throw new Error("DASH manifest has no audio track");
	return { duration, tracks: { audios } };
};
