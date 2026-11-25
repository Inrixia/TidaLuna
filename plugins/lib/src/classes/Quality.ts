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
	 * Convert Tidal `mediaItem.mediaMetadata?.tags` to Quality. Tags Luna has no quality for (TIDAL can add new ones) are left out.
	 */
	public static fromMetaTags(qualityTags?: redux.MediaMetadataTag[]): Quality[] {
		if (!qualityTags) return [];
		return qualityTags.map((tag) => this.lookups.metadataTags[tag]).filter((quality) => quality instanceof Quality);
	}

	/**
	 * Convert Tidal `mediaItem.audioQuality` to Quality
	 */
	public static fromAudioQuality(audioQuality?: redux.AudioQuality): Quality | undefined {
		if (audioQuality === undefined) return undefined;
		return this.lookups.audioQuality[audioQuality];
	}

	/** The lowest of `qualities`. Undefined entries (unknown tags) are ignored, with none left this is Lowest */
	public static min(...qualities: (Quality | undefined)[]): Quality {
		return Quality.fromIdx(Math.min(...Quality.ranks(qualities)));
	}
	/** The highest of `qualities`. Undefined entries (unknown tags) are ignored, with none left this is Lowest */
	public static max(...qualities: (Quality | undefined)[]): Quality {
		return Quality.fromIdx(Math.max(...Quality.ranks(qualities)));
	}
	private static ranks(qualities: (Quality | undefined)[]): number[] {
		return qualities.filter((q) => q !== undefined).map((q) => q.valueOf());
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
