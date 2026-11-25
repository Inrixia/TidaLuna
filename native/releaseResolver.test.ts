import { describe, expect, test, vi } from "vitest";

import { COMPAT_ASSET } from "./compat";
import { LUNA_ASSET, releaseAssetUrl } from "./releaseGate";
import { compatUrlOf, remoteCompat, resolveRelease } from "./releaseResolver";

/**
 * Which release gets installed on a TIDAL that is not the one Luna was built for.
 *
 * The cases that matter are the ones where a wrong answer installs something that does not work, or hides that nothing
 * compatible exists. So: a tested release beats a newer untested one, a release that says it does not support this TIDAL
 * is never chosen, and two digests that disagree mean neither is believed.
 */
const SHA = (char: string) => char.repeat(64);

const rel = (version: string, options: { digest?: string; prerelease?: boolean } = {}) => ({
	tag_name: version,
	draft: false,
	prerelease: options.prerelease ?? false,
	assets: [
		{ name: LUNA_ASSET, browser_download_url: releaseAssetUrl(version), size: 1024, digest: `sha256:${options.digest ?? SHA("a")}` },
		{ name: COMPAT_ASSET, browser_download_url: releaseAssetUrl(version, COMPAT_ASSET), size: 200 },
	],
});

const compatFor = (version: string, tidal: { tested?: string[]; min?: string }, sha = SHA("a")) => ({
	luna: version,
	tidal,
	zip: { sha256: sha, bytes: 1024 },
});

/** Answers `fetchCompat` from a table of tag -> file (or a string, for a release whose compat cannot be read) */
const fetchFrom = (table: Record<string, unknown>) => async (release: { tag_name: string }) => {
	const found = table[release.tag_name];
	if (found === undefined) return "could not be read: 404 Not Found";
	return found;
};

describe("resolveRelease", () => {
	test("picks the newest release that was tested against this TIDAL", async () => {
		const resolution = await resolveRelease([rel("1.27.0"), rel("1.26.0")], {
			tidalVersion: "2.48.0",
			fetchCompat: fetchFrom({ "1.27.0": compatFor("1.27.0", { tested: ["2.48.0"] }), "1.26.0": compatFor("1.26.0", { tested: ["2.47.0"] }) }),
		});

		expect(resolution).toMatchObject({ ok: true, candidate: { version: "1.27.0" }, verdict: "tested" });
	});

	test("a tested release beats a newer one that only claims a floor", async () => {
		const resolution = await resolveRelease([rel("1.28.0"), rel("1.27.0")], {
			tidalVersion: "2.48.0",
			fetchCompat: fetchFrom({ "1.28.0": compatFor("1.28.0", { min: "2.40.0" }), "1.27.0": compatFor("1.27.0", { tested: ["2.48.0"] }) }),
		});

		expect(resolution).toMatchObject({ ok: true, candidate: { version: "1.27.0" }, verdict: "tested" });
	});

	test("falls back to a release that claims a floor, and says so", async () => {
		const resolution = await resolveRelease([rel("1.27.0")], {
			tidalVersion: "2.49.0",
			fetchCompat: fetchFrom({ "1.27.0": compatFor("1.27.0", { min: "2.44.0" }) }),
		});

		expect(resolution).toMatchObject({ ok: true, verdict: "at-least-min" });
		expect(resolution.ok && resolution.notes.join(" ")).toMatch(/not tested against TIDAL 2\.49\.0/);
	});

	test("never picks a release that says this TIDAL is outside its support", async () => {
		const resolution = await resolveRelease([rel("1.29.0")], {
			tidalVersion: "2.40.0",
			fetchCompat: fetchFrom({ "1.29.0": compatFor("1.29.0", { tested: ["2.48.0"], min: "2.44.0" }) }),
		});

		expect(resolution.ok).toBe(false);
		expect(resolution.ok === false && resolution.reason).toMatch(/do not support TIDAL 2\.40\.0/);
	});

	test("installs a release that makes no claims, flagged rather than presented as compatible", async () => {
		const resolution = await resolveRelease([rel("1.27.0")], {
			tidalVersion: "2.48.0",
			fetchCompat: fetchFrom({ "1.27.0": compatFor("1.27.0", { tested: [] }) }),
		});

		expect(resolution).toMatchObject({ ok: true, verdict: "unknown" });
		expect(resolution.ok && resolution.notes.join(" ")).toMatch(/says nothing about which TIDAL/);
	});

	test("skips a release whose compat names a different digest than its asset", async () => {
		const resolution = await resolveRelease([rel("1.28.0", { digest: SHA("b") }), rel("1.27.0")], {
			tidalVersion: "2.48.0",
			fetchCompat: fetchFrom({
				"1.28.0": compatFor("1.28.0", { tested: ["2.48.0"] }, SHA("c")),
				"1.27.0": compatFor("1.27.0", { tested: ["2.48.0"] }),
			}),
		});

		expect(resolution).toMatchObject({ ok: true, candidate: { version: "1.27.0" } });
		expect(resolution.ok && resolution.notes.join(" ")).toMatch(/names a sha256 that is not the asset's/);
	});

	test("skips a release whose compat cannot be read", async () => {
		const resolution = await resolveRelease([rel("1.28.0"), rel("1.27.0")], {
			tidalVersion: "2.48.0",
			fetchCompat: fetchFrom({ "1.27.0": compatFor("1.27.0", { tested: ["2.48.0"] }) }),
		});

		expect(resolution).toMatchObject({ ok: true, candidate: { version: "1.27.0" } });
	});

	test("says nothing can be verified when no release publishes a compat", async () => {
		const resolution = await resolveRelease([rel("1.28.0"), rel("1.27.0")], { tidalVersion: "2.48.0", fetchCompat: fetchFrom({}) });

		expect(resolution.ok).toBe(false);
		expect(resolution.ok === false && resolution.reason).toMatch(/no release publishes a compat\.json/);
	});

	test("the digest it hands back is the one the download is checked against", async () => {
		const resolution = await resolveRelease([rel("1.27.0", { digest: SHA("b") })], {
			tidalVersion: "2.48.0",
			fetchCompat: fetchFrom({ "1.27.0": compatFor("1.27.0", { tested: ["2.48.0"] }, SHA("b")) }),
		});

		expect(resolution).toMatchObject({ ok: true, candidate: { sha256: SHA("b") } });
	});

	test("skips a prerelease unless betas were opted into", async () => {
		const releases = [rel("1.28.0-beta", { prerelease: true }), rel("1.27.0")];
		const table = {
			"1.28.0-beta": compatFor("1.28.0-beta", { tested: ["2.48.0"] }),
			"1.27.0": compatFor("1.27.0", { tested: ["2.48.0"] }),
		};

		expect(await resolveRelease(releases, { tidalVersion: "2.48.0", fetchCompat: fetchFrom(table) })).toMatchObject({
			candidate: { version: "1.27.0" },
		});
		expect(await resolveRelease(releases, { tidalVersion: "2.48.0", allowPrerelease: true, fetchCompat: fetchFrom(table) })).toMatchObject({
			candidate: { version: "1.28.0-beta" },
		});
	});

	test("refuses when no release could be used at all", async () => {
		const draft = { ...rel("1.27.0"), draft: true };

		expect(await resolveRelease([draft], { tidalVersion: "2.48.0", fetchCompat: fetchFrom({}) })).toMatchObject({
			ok: false,
			reason: /no published release/,
		});
	});
});

describe("resolveRelease with a pin", () => {
	const releases = [rel("1.28.0"), rel("1.27.0")];
	const table = {
		"1.28.0": compatFor("1.28.0", { tested: ["2.48.0"] }),
		"1.27.0": compatFor("1.27.0", { tested: ["2.44.0"] }),
	};

	test("installs the pinned version even where a newer one is a better fit", async () => {
		const resolution = await resolveRelease(releases, { tidalVersion: "2.48.0", pinnedVersion: "1.27.0", fetchCompat: fetchFrom(table) });

		expect(resolution).toMatchObject({ ok: true, candidate: { version: "1.27.0" } });
	});

	test("a pin overrides the support checks, but says so", async () => {
		const resolution = await resolveRelease(releases, { tidalVersion: "2.48.0", pinnedVersion: "1.27.0", fetchCompat: fetchFrom(table) });

		expect(resolution.ok && resolution.notes.join(" ")).toMatch(/does not claim to support TIDAL 2\.48\.0, and is pinned/);
	});

	test("refuses a pin that is not a release it may install", async () => {
		expect(await resolveRelease(releases, { tidalVersion: "2.48.0", pinnedVersion: "1.10.0", fetchCompat: fetchFrom(table) })).toMatchObject({
			ok: false,
			reason: /pinned 1\.10\.0/,
		});
	});

	test("refuses a pin it cannot verify, rather than installing it unchecked", async () => {
		const noDigest = { ...rel("1.27.0"), assets: [{ name: LUNA_ASSET, browser_download_url: releaseAssetUrl("1.27.0"), size: 1024 }] };

		const resolution = await resolveRelease([noDigest], { tidalVersion: "2.48.0", pinnedVersion: "1.27.0", fetchCompat: fetchFrom({}) });

		expect(resolution.ok).toBe(false);
		expect(resolution.ok === false && resolution.reason).toMatch(/cannot be verified/);
	});
});

describe("reading a release's compat.json over the network", () => {
	test("only this repo's own asset url is used", () => {
		expect(compatUrlOf(rel("1.27.0"))).toEqual({ url: releaseAssetUrl("1.27.0", COMPAT_ASSET) });
	});

	test("a release with no compat asset says so", () => {
		const without = { ...rel("1.27.0"), assets: [{ name: LUNA_ASSET, browser_download_url: releaseAssetUrl("1.27.0"), size: 1 }] };

		expect(compatUrlOf(without)).toMatchObject({ reason: expect.stringMatching(/has no compat\.json/) });
	});

	test("an asset served from anywhere else is refused rather than fetched", async () => {
		const elsewhere = {
			...rel("1.27.0"),
			assets: [{ name: COMPAT_ASSET, browser_download_url: `https://github.com/attacker/TidaLuna/releases/download/1.27.0/${COMPAT_ASSET}` }],
		};
		expect(compatUrlOf(elsewhere)).toMatchObject({ reason: expect.stringMatching(/not this repo/) });

		const fetchSpy = vi.fn();
		expect(await remoteCompat(fetchSpy as never)(elsewhere)).toMatch(/not this repo/);
		// Nothing was requested: the url was refused before the network was touched
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("reads the json a release serves", async () => {
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ luna: "1.27.0" }), { status: 200 }));

		expect(await remoteCompat(fetchSpy as never)(rel("1.27.0"))).toEqual({ luna: "1.27.0" });
		expect(fetchSpy).toHaveBeenCalledWith(releaseAssetUrl("1.27.0", COMPAT_ASSET));
	});

	test("reports what went wrong instead of throwing", async () => {
		expect(await remoteCompat((async () => new Response("", { status: 404, statusText: "Not Found" })) as never)(rel("1.27.0"))).toMatch(/404/);
		expect(await remoteCompat((async () => new Response("<html>", { status: 200 })) as never)(rel("1.27.0"))).toMatch(/is not json/);
		expect(await remoteCompat((async () => Promise.reject(new Error("offline"))) as never)(rel("1.27.0"))).toMatch(/could not be read: offline/);
	});
});

/**
 * Releases published before compat.json existed.
 *
 * Those declare nothing, which is what every release did until now. Refusing them would leave an install unable to act
 * until a newer release ships, so they are treated as unknown — flagged, and only used when nothing better exists — but
 * the download still has to be checkable against a digest GitHub reports.
 */
describe("resolveRelease with releases that publish no compat.json", () => {
	const withoutCompat = (version: string, options: { digest?: boolean } = {}) => {
		const assets = [{ name: LUNA_ASSET, browser_download_url: releaseAssetUrl(version), size: 1024 }];
		if (options.digest !== false) assets[0] = { ...assets[0], digest: `sha256:${SHA("a")}` } as never;
		return { tag_name: version, draft: false, prerelease: false, assets };
	};

	test("uses one when there is nothing better, and says it knows nothing", async () => {
		const resolution = await resolveRelease([withoutCompat("1.27.0")], { tidalVersion: "2.48.0", fetchCompat: fetchFrom({}) });

		expect(resolution).toMatchObject({ ok: true, candidate: { version: "1.27.0" }, verdict: "unknown", compat: undefined });
		expect(resolution.ok && resolution.notes.join(" ")).toMatch(/says nothing about which TIDAL/);
		// The digest it will check the download against is the asset's own
		expect(resolution).toMatchObject({ candidate: { sha256: SHA("a") } });
	});

	test("prefers one that does declare what it supports", async () => {
		const resolution = await resolveRelease([withoutCompat("1.28.0"), rel("1.27.0")], {
			tidalVersion: "2.48.0",
			fetchCompat: fetchFrom({ "1.27.0": compatFor("1.27.0", { tested: ["2.48.0"] }) }),
		});

		expect(resolution).toMatchObject({ ok: true, candidate: { version: "1.27.0" }, verdict: "tested" });
	});

	test("refuses one it could not check the download of", async () => {
		const resolution = await resolveRelease([withoutCompat("1.27.0", { digest: false })], { tidalVersion: "2.48.0", fetchCompat: fetchFrom({}) });

		expect(resolution.ok).toBe(false);
		expect(resolution.ok === false && resolution.reason).toMatch(/no release publishes a compat\.json|no digest/);
	});

	test("still skips one whose compat.json is there but unreadable", async () => {
		// A 404 on an asset that exists is a broken release, not an old one
		const resolution = await resolveRelease([rel("1.28.0"), withoutCompat("1.27.0")], { tidalVersion: "2.48.0", fetchCompat: fetchFrom({}) });

		expect(resolution).toMatchObject({ ok: true, candidate: { version: "1.27.0" }, verdict: "unknown" });
		expect(resolution.ok && resolution.notes.join(" ")).toMatch(/1\.28\.0's compat\.json could not be read/);
	});
});
