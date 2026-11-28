import JSZip from "jszip";
import { describe, expect, test } from "vitest";

import {
	isReleaseVersion,
	LUNA_ASSET,
	releaseAssetUrl,
	releaseCandidate,
	releaseRejection,
	sha256Hex,
	verifyLunaZip,
	type ReleaseInfo,
} from "./releaseGate";

/**
 * The checks that stand between "a release exists" and "Luna replaced itself with it".
 *
 * These are the tests that matter most in the automatic path: each rejection is a way an attacker, or a mistake, could
 * put code where TIDAL boots it. Every one asserts the reason, because the caller logs it and does nothing.
 */
const VERSION = "1.26.0";
const goodAsset = () => ({ name: LUNA_ASSET, browser_download_url: releaseAssetUrl(VERSION), size: 1024, digest: `sha256:${"a".repeat(64)}` });
const release = (overrides: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
	tag_name: VERSION,
	draft: false,
	prerelease: false,
	assets: [goodAsset()],
	...overrides,
});

/** A zip shaped like a Luna release: the files the injector boots, plus the package.json that names the build */
const lunaZip = async (files: Record<string, string> = {}) => {
	const zip = new JSZip();
	const contents = {
		"package.json": JSON.stringify({ name: "luna", version: VERSION }),
		"injector.mjs": "boot",
		"luna.mjs": "core",
		...files,
	};
	for (const [name, value] of Object.entries(contents)) zip.file(name, value);
	return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
};

describe("isReleaseVersion", () => {
	test("accepts a release tag", () => {
		for (const version of ["1.26.0", "1.26.0-beta", "v1.0.0"]) expect(isReleaseVersion(version)).toBe(true);
	});

	test("refuses a tag that could point somewhere else", () => {
		for (const version of ["../other/repo", "a/b", "1.0 then restart", "..", "", undefined, 42]) expect(isReleaseVersion(version)).toBe(false);
	});
});

describe("releaseRejection", () => {
	test("accepts a published release with the asset this repo serves", () => {
		expect(releaseRejection(release())).toBeUndefined();
	});

	test("refuses a draft", () => {
		expect(releaseRejection(release({ draft: true }))).toMatch(/draft/);
	});

	test("refuses a prerelease unless betas were opted into", () => {
		const beta = release({
			tag_name: "1.26.0-beta",
			prerelease: true,
			assets: [{ name: LUNA_ASSET, browser_download_url: releaseAssetUrl("1.26.0-beta"), size: 1 }],
		});
		expect(releaseRejection(beta)).toMatch(/prerelease/);
		expect(releaseRejection(beta, { allowPrerelease: true })).toBeUndefined();
	});

	test("refuses a tag that is not a release version", () => {
		expect(releaseRejection(release({ tag_name: "../evil" }))).toMatch(/not a release tag/);
	});

	test("refuses a release with no luna.zip", () => {
		expect(releaseRejection(release({ assets: [{ name: "other.zip", browser_download_url: releaseAssetUrl(VERSION) }] }))).toMatch(/no luna\.zip/);
	});

	test("refuses an asset served from anywhere but this repo, even if it is named right", () => {
		const elsewhere = release({
			assets: [{ name: LUNA_ASSET, browser_download_url: `https://github.com/attacker/TidaLuna/releases/download/${VERSION}/${LUNA_ASSET}` }],
		});
		expect(releaseRejection(elsewhere)).toMatch(/not this repo/);
	});

	test("refuses an empty asset", () => {
		expect(releaseRejection(release({ assets: [{ ...goodAsset(), size: 0 }] }))).toMatch(/empty/);
	});
});

describe("releaseCandidate", () => {
	test("hands back the url, size and digest to check the download against", () => {
		expect(releaseCandidate(release())).toEqual({ version: VERSION, url: releaseAssetUrl(VERSION), size: 1024, sha256: "a".repeat(64) });
	});

	test("hands back the reason when the release may not be installed", () => {
		expect(releaseCandidate(release({ draft: true }))).toMatch(/draft/);
	});

	test("ignores a digest that is not sha256, rather than trusting it", () => {
		const candidate = releaseCandidate(release({ assets: [{ ...goodAsset(), digest: "md5:abc" }] }));
		expect(candidate).toMatchObject({ sha256: undefined });
	});
});

describe("sha256Hex", () => {
	test("is the digest of the bytes it is given", () => {
		// The empty input is the one digest worth pinning: it proves the hash is of the bytes, not of something else
		expect(sha256Hex(Buffer.from(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(sha256Hex(Buffer.from("luna"))).toMatch(/^[0-9a-f]{64}$/);
		expect(sha256Hex(Buffer.from("luna"))).not.toBe(sha256Hex(Buffer.from("lunb")));
	});
});

describe("verifyLunaZip", () => {
	test("accepts the archive a release publishes", async () => {
		await expect(verifyLunaZip(await lunaZip(), { version: VERSION })).resolves.toBeUndefined();
	});

	test("accepts it when the download matches the published digest", async () => {
		const zip = await lunaZip();
		await expect(verifyLunaZip(zip, { version: VERSION, sha256: sha256Hex(zip) })).resolves.toBeUndefined();
	});

	test("refuses a download that does not match the published digest", async () => {
		const zip = await lunaZip();
		await expect(verifyLunaZip(zip, { version: VERSION, sha256: "b".repeat(64) })).rejects.toThrow(/does not match its published sha256/);
	});

	test("refuses an archive with no package.json", async () => {
		const zip = new JSZip();
		zip.file("injector.mjs", "boot");
		await expect(verifyLunaZip(await zip.generateAsync({ type: "nodebuffer" }), { version: VERSION })).rejects.toThrow(/no package\.json/);
	});

	test("refuses an archive that is another package", async () => {
		const zip = await lunaZip({ "package.json": JSON.stringify({ name: "not-luna", version: VERSION }) });
		await expect(verifyLunaZip(zip, { version: VERSION })).rejects.toThrow(/not luna/);
	});

	test("refuses an archive that is another version", async () => {
		const zip = await lunaZip({ "package.json": JSON.stringify({ name: "luna", version: "9.9.9" }) });
		await expect(verifyLunaZip(zip, { version: VERSION })).rejects.toThrow(/says it is 9\.9\.9/);
	});

	test("refuses an archive that would leave TIDAL unbootable", async () => {
		const zip = new JSZip();
		zip.file("package.json", JSON.stringify({ name: "luna", version: VERSION }));
		zip.file("injector.mjs", "boot");
		await expect(verifyLunaZip(await zip.generateAsync({ type: "nodebuffer" }), { version: VERSION })).rejects.toThrow(/no luna\.mjs/);
	});

	test("refuses an archive with an entry outside the install folder", async () => {
		// Only Windows can be escaped through a zip entry: JSZip strips a `../` from an entry name as it loads, and a
		// backslash is a path separator only there. On POSIX that name is a legal file name inside the folder
		const zip = await lunaZip({ "..\\escape.mjs": "escaped" });
		const verifying = verifyLunaZip(zip, { version: VERSION });

		if (process.platform === "win32") await expect(verifying).rejects.toThrow(/Zip Slip/);
		else await expect(verifying).resolves.toBeUndefined();
	});
});
