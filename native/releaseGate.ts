import { createHash } from "crypto";
import path from "path";
import JSZip from "jszip";

import { validateZipEntries } from "./zipEntries";

/**
 * What Luna may install unattended.
 *
 * An automatic upgrade downloads code and puts it where TIDAL boots it, so the checks here are the trust boundary: the
 * release has to be a real, published release of this repo, the asset has to be the one GitHub reports for it, and the
 * bytes have to match before anything is written. Every check returns a reason instead of throwing, so a caller can log
 * why it did nothing rather than guess.
 */

/** The one asset an install uses, built by .github/workflows/build.yml */
export const LUNA_ASSET = "luna.zip";
export const RELEASE_REPO = "Inrixia/TidaLuna";

/** The url a release's asset must point at. Built from the validated tag, never taken from the payload */
export const releaseAssetUrl = (version: string) => `https://github.com/${RELEASE_REPO}/releases/download/${version}/${LUNA_ASSET}`;

/** As much of GitHub's release object as Luna reads */
export type ReleaseAsset = { name: string; browser_download_url: string; size?: number; digest?: string | null };
export type ReleaseInfo = { tag_name: string; draft?: boolean; prerelease?: boolean; assets?: ReleaseAsset[] };

/** A release that passed the checks, ready to download */
export type ReleaseCandidate = { version: string; url: string; size?: number; sha256?: string };

/** A release tag `update` can download: a single path segment, no `/` or `..` to point it elsewhere */
export const isReleaseVersion = (version: unknown): version is string =>
	typeof version === "string" && /^[\w.-]+$/.test(version) && !version.includes("..");

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** `sha256:abc…` as GitHub reports an asset's digest, or undefined when it reports none or another algorithm */
const digestOf = (asset: ReleaseAsset): string | undefined => {
	const digest = asset.digest;
	if (typeof digest !== "string") return undefined;
	const [algorithm, hex] = digest.split(":");
	return algorithm === "sha256" && hex !== undefined && /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
};

/**
 * Why this release must not be installed without asking, or undefined if it may.
 *
 * @param allowPrerelease the user opted into betas: `dev` releases are prereleases
 */
export const releaseRejection = (release: ReleaseInfo, { allowPrerelease = false } = {}): string | undefined => {
	const version = release.tag_name;
	if (!isReleaseVersion(version)) return `not a release tag: ${JSON.stringify(version)}`;
	// Drafts are invisible to anyone but the author, so a draft in the payload is not something to trust at all
	if (release.draft === true) return `${version} is a draft`;
	if (release.prerelease === true && !allowPrerelease) return `${version} is a prerelease`;

	const assets = release.assets ?? [];
	const asset = assets.find(({ name }) => name === LUNA_ASSET);
	if (asset === undefined) return `${version} has no ${LUNA_ASSET} asset`;
	if (typeof asset.size === "number" && asset.size <= 0) return `${version}'s ${LUNA_ASSET} is empty`;
	// The payload's url is only accepted when it is the url this repo's asset must have
	if (asset.browser_download_url !== releaseAssetUrl(version))
		return `${version}'s ${LUNA_ASSET} is served from ${asset.browser_download_url}, not this repo`;
	return undefined;
};

/** The release as something to download, or the reason it may not be */
export const releaseCandidate = (release: ReleaseInfo, options?: { allowPrerelease?: boolean }): ReleaseCandidate | string => {
	const rejection = releaseRejection(release, options);
	if (rejection !== undefined) return rejection;
	const asset = release.assets!.find(({ name }) => name === LUNA_ASSET)!;
	return { version: release.tag_name, url: asset.browser_download_url, size: asset.size, sha256: digestOf(asset) };
};

/** A folder used only to resolve entries against, so a `..` in an entry is caught */
const ZIP_BASE = path.resolve(path.sep, "luna-install");

/**
 * Checks the downloaded bytes are the Luna build they claim to be, and throws with the reason if not. Runs before an
 * install touches anything, so a bad download costs a failed attempt rather than a broken client.
 *
 * @param sha256 the digest published for this release, when one was
 */
export const verifyLunaZip = async (zipBuffer: Buffer, { version, sha256 }: { version: string; sha256?: string }): Promise<void> => {
	if (sha256 !== undefined && sha256Hex(zipBuffer) !== sha256)
		throw new Error(`[UPDATER] ${version}: the download does not match its published sha256`);
	// Zip Slip first: an entry that escapes the install folder is not unpacked at all
	const zip = await validateZipEntries(zipBuffer, ZIP_BASE);

	const packageJson = await zip.file("package.json")?.async("string");
	if (packageJson === undefined) throw new Error(`[UPDATER] ${version}: the archive has no package.json`);
	let pkg: { name?: unknown; version?: unknown };
	try {
		pkg = JSON.parse(packageJson);
	} catch {
		throw new Error(`[UPDATER] ${version}: the archive's package.json is not json`);
	}
	if (pkg.name !== "luna") throw new Error(`[UPDATER] ${version}: the archive is for "${String(pkg.name)}", not luna`);
	if (pkg.version !== version) throw new Error(`[UPDATER] ${version}: the archive says it is ${String(pkg.version)}`);

	// The two files the injector boots: without them the install would leave TIDAL unbootable
	// (JSZip returns null for an entry that is not there, so this tests for a value rather than against undefined)
	for (const required of ["injector.mjs", "luna.mjs"]) {
		if (zip.file(required) == null) throw new Error(`[UPDATER] ${version}: the archive has no ${required}`);
	}
};
