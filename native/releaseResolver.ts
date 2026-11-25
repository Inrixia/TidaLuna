import { COMPAT_ASSET, compatVerdict, parseCompat, type CompatFile, type CompatVerdict } from "./compat";
import { isReleaseVersion, releaseAssetUrl, releaseCandidate, releaseRejection, type ReleaseCandidate, type ReleaseInfo } from "./releaseGate";
import { compareVersions } from "./tidalInstall";

/**
 * Picks the release to install on a TIDAL that is not the one Luna was built for.
 *
 * The order of preference is the honest part. A release that was actually run against this TIDAL version wins; failing
 * that, one that is newer than the oldest TIDAL it claims to support; failing that, one that makes no claim at all, which
 * is installed with the caveat attached rather than presented as compatible. A release that says this TIDAL is outside
 * its support is never chosen, however new it is — that is the case where installing it makes things worse than leaving
 * the old Luna in place.
 *
 * Nothing here downloads: it decides, and hands back the digest the download must match.
 */

export type Resolution =
	| { ok: true; candidate: ReleaseCandidate; compat: CompatFile | undefined; verdict: CompatVerdict; notes: string[] }
	| { ok: false; reason: string; notes: string[] };

export type ResolveOptions = {
	/** The TIDAL that is installed, when it could be read */
	tidalVersion?: string;
	/** A version the user pinned. Resolution never moves off it, and a pin overrides the support checks */
	pinnedVersion?: string;
	allowPrerelease?: boolean;
	/** Reads a release's `compat.json` as json, or returns the reason it could not be read */
	fetchCompat: (release: ReleaseInfo) => Promise<unknown | string>;
};

type Judged = { release: ReleaseInfo; candidate: ReleaseCandidate; compat: CompatFile | undefined; verdict: CompatVerdict };

/**
 * Where a release's `compat.json` must be served from, or why it cannot be read.
 *
 * Only this repo's own asset url is accepted, built from the validated tag: a payload naming any other url is refused
 * rather than fetched.
 */
export const compatUrlOf = (release: ReleaseInfo): { url: string } | { reason: string } => {
	const version = release.tag_name;
	if (!isReleaseVersion(version)) return { reason: `not a release tag: ${JSON.stringify(version)}` };
	const asset = (release.assets ?? []).find(({ name }) => name === COMPAT_ASSET);
	if (asset === undefined) return { reason: `has no ${COMPAT_ASSET} asset` };
	const expected = releaseAssetUrl(version, COMPAT_ASSET);
	if (asset.browser_download_url !== expected) return { reason: `${COMPAT_ASSET} is served from ${asset.browser_download_url}, not this repo` };
	return { url: expected };
};

/**
 * Reads release `compat.json`s over the network, for `resolveRelease`'s `fetchCompat`.
 *
 * Redirects are followed: GitHub serves a release asset from another host, so pinning the final url would not work. What
 * binds the bytes is the digest inside the file, which the caller then checks the archive against — that is the check
 * that matters, not where the transport ended up.
 */
export const remoteCompat =
	(httpFetch: typeof fetch) =>
	async (release: ReleaseInfo): Promise<unknown | string> => {
		const found = compatUrlOf(release);
		if ("reason" in found) return found.reason;
		const response = await httpFetch(found.url).catch((err: Error) => err);
		if (response instanceof Error) return `could not be read: ${response.message}`;
		if (response.status !== 200) return `could not be read: ${response.status} ${response.statusText}`;
		return response.json().catch(() => `from ${found.url} is not json`);
	};

/** The digest a download will be checked against: the one the release published, or the one GitHub reports for the asset */
const digestOf = (candidate: ReleaseCandidate, compat: CompatFile | undefined): string | undefined => compat?.zip.sha256 ?? candidate.sha256;

/**
 * @param releases releases as the GitHub api returned them; ordered here rather than trusted to be
 */
export const resolveRelease = async (releases: ReleaseInfo[], options: ResolveOptions): Promise<Resolution> => {
	const { tidalVersion, pinnedVersion, allowPrerelease = false, fetchCompat } = options;
	const notes: string[] = [];

	const ordered = [...releases].sort((left, right) => compareVersions(right.tag_name, left.tag_name));
	const usable: ReleaseCandidate[] = [];
	for (const release of ordered) {
		const candidate = releaseCandidate(release, { allowPrerelease });
		if (typeof candidate === "string") {
			notes.push(`skipped ${release.tag_name}: ${candidate}`);
			continue;
		}
		usable.push(candidate);
	}
	if (usable.length === 0) return { ok: false, reason: "no published release could be used", notes };

	const judge = async (candidate: ReleaseCandidate): Promise<Judged | string> => {
		const release = ordered.find(({ tag_name }) => tag_name === candidate.version)!;
		const raw = await fetchCompat(release).catch((err: Error) => `could not be read: ${err.message}`);
		if (typeof raw === "string") return `${candidate.version}'s ${"compat.json"} ${raw}`;
		const compat = parseCompat(raw, candidate.version);
		if (typeof compat === "string") return `${candidate.version}'s compat.json ${compat}`;
		// Two digests that disagree describe two different archives: neither is trusted
		if (candidate.sha256 !== undefined && candidate.sha256 !== compat.zip.sha256) {
			return `${candidate.version}'s compat.json names a sha256 that is not the asset's`;
		}
		return { release, candidate, compat, verdict: compatVerdict(compat, tidalVersion) };
	};

	// A pin is the user's own answer to "which version": it is installed even where its claims do not cover this TIDAL
	if (pinnedVersion !== undefined) {
		const candidate = usable.find(({ version }) => version === pinnedVersion);
		if (candidate === undefined) return { ok: false, reason: `the pinned ${pinnedVersion} is not a release Luna may install`, notes };
		const judged = await judge(candidate);
		if (typeof judged === "string") {
			// A pin without a published digest cannot be verified, so it is not installed unattended
			if (candidate.sha256 === undefined) return { ok: false, reason: `the pinned ${pinnedVersion} cannot be verified: ${judged}`, notes };
			notes.push(`${judged}; installing it anyway because it is pinned, checked against the asset's own digest`);
			return { ok: true, candidate, compat: undefined, verdict: "unknown", notes };
		}
		if (judged.verdict === "unsupported") notes.push(`${pinnedVersion} does not claim to support TIDAL ${tidalVersion}, and is pinned`);
		return { ok: true, candidate: judged.candidate, compat: judged.compat, verdict: judged.verdict, notes };
	}

	const judged: Judged[] = [];
	for (const candidate of usable) {
		const result = await judge(candidate);
		if (typeof result === "string") {
			notes.push(`skipped ${result}`);
			continue;
		}
		judged.push(result);
	}
	if (judged.length === 0) return { ok: false, reason: "no release publishes a compat.json that could be used", notes };

	// Best claim first, newest within each: a tested release beats a merely-newer one
	const preference: CompatVerdict[] = ["tested", "at-least-min", "unknown"];
	for (const verdict of preference) {
		const match = judged.find((entry) => entry.verdict === verdict);
		if (match === undefined) continue;
		if (verdict === "unknown") notes.push(`${match.candidate.version} says nothing about which TIDAL it supports`);
		if (verdict === "at-least-min")
			notes.push(`${match.candidate.version} was not tested against TIDAL ${tidalVersion}, only against an older one`);
		return { ok: true, candidate: { ...match.candidate, sha256: digestOf(match.candidate, match.compat) }, compat: match.compat, verdict, notes };
	}

	const newest = judged[0];
	return {
		ok: false,
		reason: `the newest releases say they do not support TIDAL ${tidalVersion} (newest is ${newest.candidate.version})`,
		notes,
	};
};
