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

const audioCodecs = new Map(Object.entries({ mp4a: "AAC", "ac-3": "DD", "ec-3": "DD+", opus: "OPUS", dtsc: "DTS", alac: "ALAC", flac: "FLAC" }));
const findCodec = (codecs: string | undefined) => {
	for (const mime of (codecs ?? "").split(",")) {
		const codec = audioCodecs.get(mime.toLowerCase().trim().split(".")[0]);
		if (codec !== undefined) return codec;
	}
};
// A manifest describing more segments than this is not a track
const maxSegments = 100_000;

// ISO 8601 duration as used by MPDs, eg PT4M7.679S
const parseDuration = (duration: string | undefined) => {
	const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(duration ?? "");
	if (match === null) return 0;
	const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match;
	return +days * 86400 + +hours * 3600 + +minutes * 60 + +seconds;
};

// $Number$, $Time$, $Bandwidth$ and $RepresentationID$, with an optional %0<width>d. $$ is a literal $
const fillTemplate = (template: string, values: Record<string, string | number>) =>
	template.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (match, name: string, width?: string) => {
		if (name === "") return "$";
		if (!Object.hasOwn(values, name)) return match;
		const value = String(values[name]);
		return width === undefined || name === "RepresentationID" ? value : value.padStart(+width, "0");
	});

const childOf = (el: Element, name: string) => Array.from(el.children).find((child) => child.localName === name);
const childrenOf = (el: Element, name: string) => Array.from(el.children).filter((child) => child.localName === name);
const attrOf = (name: string, ...els: (Element | undefined)[]) => {
	for (const el of els) if (el?.hasAttribute(name)) return el.getAttribute(name)!;
};
const resolveBaseUrl = (el: Element, base: string) => new URL(childOf(el, "BaseURL")?.textContent?.trim() ?? "", base).href;

/**
 * Parses the DASH manifest of a TIDAL track (SegmentTemplate addressing) into its audio tracks.
 * Uses the renderer's DOMParser, so the manifest is never handed to code outside Luna.
 */
export const parseDashManifest = (text: string, manifestUrl: string): DashManifest => {
	const doc = new DOMParser().parseFromString(text, "application/xml");
	const mpd = doc.documentElement;
	if (doc.getElementsByTagName("parsererror").length !== 0 || mpd.localName !== "MPD") throw new Error("Invalid DASH manifest");

	const period = childOf(mpd, "Period");
	if (period === undefined) throw new Error("DASH manifest has no Period");
	const duration = parseDuration(attrOf("duration", period) ?? attrOf("mediaPresentationDuration", mpd));
	const periodBase = resolveBaseUrl(period, resolveBaseUrl(mpd, manifestUrl));

	const audios: DashAudioTrack[] = [];
	// Segments of the tracks before this one, so the cap holds for the whole manifest
	let segmentCount = 0;
	for (const adaptationSet of childrenOf(period, "AdaptationSet")) {
		for (const representation of childrenOf(adaptationSet, "Representation")) {
			const codecs = attrOf("codecs", representation, adaptationSet);
			const codec = findCodec(codecs);
			// The declared type, else audio if the codecs name an audio codec
			const contentType =
				attrOf("contentType", representation, adaptationSet) ??
				attrOf("mimeType", representation, adaptationSet)?.split("/")[0] ??
				(codec !== undefined ? "audio" : undefined);
			if (contentType !== "audio") continue;
			if (codec === undefined) throw new Error(`Unsupported DASH audio codecs "${codecs}"`);

			const template = childOf(representation, "SegmentTemplate") ?? childOf(adaptationSet, "SegmentTemplate");
			const media = template?.getAttribute("media");
			if (template === undefined || media === null || media === undefined) throw new Error("DASH manifest has no SegmentTemplate");

			const base = resolveBaseUrl(representation, resolveBaseUrl(adaptationSet, periodBase));
			const bandwidth = Number(attrOf("bandwidth", representation, adaptationSet));
			const values = { Bandwidth: bandwidth, RepresentationID: attrOf("id", representation, adaptationSet) ?? "" };
			const segmentUrl = (template: string, number: number, time: number) =>
				new URL(fillTemplate(template, { ...values, Number: number, Time: time }), base).href;

			const segments: DashSegment[] = [];
			const initialization = template.getAttribute("initialization");
			if (initialization !== null) segments.push({ url: new URL(fillTemplate(initialization, values), base).href, init: true });

			let number = Number(template.getAttribute("startNumber") ?? 1);
			const timeline = childOf(template, "SegmentTimeline");
			if (timeline !== undefined) {
				let time = 0;
				for (const s of childrenOf(timeline, "S")) {
					if (s.hasAttribute("t")) time = Number(s.getAttribute("t"));
					const d = Number(s.getAttribute("d"));
					const repeat = Number(s.getAttribute("r") ?? 0);
					if (!(d > 0) || !(repeat >= 0) || segmentCount + segments.length + repeat >= maxSegments)
						throw new Error("Unsupported DASH SegmentTimeline");
					for (let i = 0; i <= repeat; i++, number++, time += d) segments.push({ url: segmentUrl(media, number, time) });
				}
			} else {
				const segmentSeconds = Number(template.getAttribute("duration")) / Number(template.getAttribute("timescale") ?? 1);
				const count = Math.ceil(duration / segmentSeconds);
				if (!(count > 0) || segmentCount + segments.length + count > maxSegments) throw new Error("DASH manifest has no valid segment count");
				for (const end = number + count; number < end; number++) segments.push({ url: segmentUrl(media, number, number) });
			}

			segmentCount += segments.length;
			audios.push({ codec, bitrate: { bps: bandwidth }, size: { b: bandwidth * duration }, segments });
		}
	}
	if (audios.length === 0) throw new Error("DASH manifest has no audio track");
	return { duration, tracks: { audios } };
};
