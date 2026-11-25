import { compareVersions } from "./tidalInstall";

/**
 * What a Luna release says about the TIDAL builds it works on.
 *
 * Published beside `luna.zip` as `compat.json`, not inside it: a file cannot carry the digest of the archive it is packed
 * in, and the digest is the part that lets an unattended download be checked. Read on the other side as untrusted input,
 * so `parseCompat` checks the shape before anything acts on it.
 */

export const COMPAT_ASSET = "compat.json";

export type TidalCompat = {
	/** TIDAL versions this release was actually run against */
	tested?: string[];
	/** Oldest TIDAL it is expected to work on, when that is known */
	min?: string;
};

export type CompatFile = {
	/** The release this describes: must match the tag it was published under */
	luna: string;
	tidal: TidalCompat;
	/** The archive it belongs to, so a download can be checked against it */
	zip: { sha256: string; bytes: number };
};

const VERSION = /^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/;
const isVersion = (value: unknown): value is string => typeof value === "string" && VERSION.test(value);

/** The file a release publishes, from what a build knows about itself */
export const buildCompat = ({
	lunaVersion,
	tidal,
	zip,
}: {
	lunaVersion: string;
	tidal: TidalCompat;
	zip: { sha256: string; bytes: number };
}): CompatFile => ({
	luna: lunaVersion,
	// An entry that is not a version is dropped rather than published: it would match nothing. An empty list is no claim
	// at all, not a claim that nothing is supported
	tidal: { tested: keepVersions(tidal.tested), min: isVersion(tidal.min) ? tidal.min : undefined },
	zip: { sha256: zip.sha256, bytes: zip.bytes },
});

/** A list of versions, or undefined when there is nothing usable in it */
function keepVersions(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const kept = value.filter(isVersion);
	return kept.length === 0 ? undefined : kept;
}

/**
 * Reads a `compat.json` that came off a release, or says why it cannot be used. Everything here is untrusted: the checks
 * are what stop a release claiming support it does not have, or naming a digest that does not describe its archive.
 *
 * @param expectedVersion the tag the file was published under
 */
export const parseCompat = (raw: unknown, expectedVersion: string): CompatFile | string => {
	if (typeof raw !== "object" || raw === null) return "is not an object";
	const { luna, tidal, zip } = raw as Record<string, unknown>;
	if (luna !== expectedVersion) return `is for "${String(luna)}", not "${expectedVersion}"`;
	if (typeof zip !== "object" || zip === null) return "has no zip digest";
	const { sha256, bytes } = zip as Record<string, unknown>;
	if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return "has no usable zip sha256";
	if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "has no zip size";
	if (typeof tidal !== "object" || tidal === null) return "says nothing about TIDAL";
	const { tested, min } = tidal as Record<string, unknown>;
	// `tested: []` is a release that makes no claim, which is "unknown" rather than "nothing is supported": an empty list
	// would otherwise make a release permanently uninstallable. A file that says nothing is still usable, just unhelpful
	const versions = keepVersions(tested);
	const oldest = isVersion(min) ? min : undefined;
	return { luna: expectedVersion, tidal: { tested: versions, min: oldest }, zip: { sha256, bytes } };
};

export type CompatVerdict =
	/** This exact TIDAL version was run against this release */
	| "tested"
	/** Not run against it, but newer than the oldest TIDAL it is expected to work on */
	| "at-least-min"
	/** The release makes claims, and this TIDAL is outside them */
	| "unsupported"
	/** The release makes no claims, so nothing is known either way */
	| "unknown";

/** How well a release's claims cover the TIDAL that is installed */
export const compatVerdict = (compat: CompatFile, tidalVersion: string | undefined): CompatVerdict => {
	const { tested, min } = compat.tidal;
	// Nothing in the path carried a version (a flatpak install, say): no claim can be judged
	if (tidalVersion === undefined) return "unknown";
	if (tested?.includes(tidalVersion) === true) return "tested";
	if (min !== undefined && compareVersions(tidalVersion, min) >= 0) return "at-least-min";
	if (tested !== undefined || min !== undefined) return "unsupported";
	return "unknown";
};
