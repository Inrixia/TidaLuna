import type { redux } from "..";

export class Quality {
	private static readonly idxLookup: Record<number, Quality> = {};
	private constructor(
		private readonly idx: number,
		public readonly name: string,
		public readonly color: string,
	) {
		Quality.idxLookup[idx] = this;
	}

	public static readonly HiRes = new Quality(6, "HiRes", "#ffd432");
	public static readonly MQA = new Quality(5, "MQA", "#F9BA7A");
	public static readonly Atmos = new Quality(4, "Atmos", "#6ab5ff");
	public static readonly Sony630 = new Quality(3, "Sony630", "#6ab5ff");
	public static readonly High = new Quality(2, "High", "#33FFEE");
	public static readonly Low = new Quality(1, "Low", "#b9b9b9");
	public static readonly Lowest = new Quality(0, "Lowest", "#b9b9b9");

	/** The highest possible quality available */
	public static readonly Max = Quality.HiRes;

	public static readonly lookups = {
		metadataTags: {
			HIRES_LOSSLESS: Quality.HiRes,
			[Quality.HiRes.idx]: "HIRES_LOSSLESS",

			MQA: Quality.MQA,
			[Quality.MQA.idx]: "MQA",

			DOLBY_ATMOS: Quality.Atmos,
			[Quality.Atmos.idx]: "DOLBY_ATMOS",

			SONY_360RA: Quality.Sony630,
			[Quality.Sony630.idx]: "SONY_360RA",

			LOSSLESS: Quality.High,
			[Quality.High.idx]: "LOSSLESS",
		},
		audioQuality: {
			HI_RES_LOSSLESS: Quality.HiRes,
			[Quality.HiRes.idx]: "HI_RES_LOSSLESS",

			HI_RES: Quality.MQA,
			[Quality.MQA.idx]: "HI_RES",

			LOSSLESS: Quality.High,
			[Quality.High.idx]: "LOSSLESS",

			HIGH: Quality.Low,
			[Quality.Low.idx]: "HIGH",

			LOW: Quality.Lowest,
			[Quality.Lowest.idx]: "LOW",
		},
	} as const;

	private static fromIdx(idx: number): Quality {
		return this.idxLookup[idx] ?? this.Lowest;
	}

	/**
	 * Convert Tidal `mediaItem.mediaMetadata?.tags` to Quality
	 */
	public static fromMetaTags(qualityTags?: redux.MediaMetadataTag[]): Quality[] {
		if (!qualityTags) return [];
		return qualityTags.map((tag) => this.lookups.metadataTags[tag]);
	}

	/**
	 * Convert Tidal `mediaItem.audioQuality` to Quality
	 */
	public static fromAudioQuality(audioQuality?: redux.AudioQuality): Quality | undefined {
		if (audioQuality === undefined) return undefined;
		return this.lookups.audioQuality[audioQuality];
	}

	public static min(...qualities: Quality[]): Quality {
		return Quality.fromIdx(Math.min(...(qualities as unknown as number[])));
	}
	public static max(...qualities: Quality[]): Quality {
		return Quality.fromIdx(Math.max(...(qualities as unknown as number[])));
	}

	/**
	 * Get in Tidal `mediaItem.audioQuality` format
	 */
	public get audioQuality(): redux.AudioQuality {
		return Quality.lookups.audioQuality[this.idx];
	}

	/**
	 * Get in Tidal `mediaItem.mediaMetadata?.tags` format
	 */
	public get metadataTag(): redux.MediaMetadataTag {
		return Quality.lookups.metadataTags[this.idx];
	}

	valueOf(): number {
		return this.idx;
	}
}
