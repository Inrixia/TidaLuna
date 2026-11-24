import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { shownWarning, type ConfirmLine, type ConfirmRequest } from "./confirmPage";
import { createRegistry, type CoreState, type PluginPackage } from "./registry";

const URL = "https://example.com/plugin";
const DEV_URL = "http://127.0.0.1:3000/plugin";

/** A fake server: url -> package and code. `natives` lists the native files the code registers */
const fakeDeps = (state: CoreState | null = null) => {
	const served = new Map<string, { pkg: PluginPackage; code: string; natives: Record<string, string> }>();
	const serve = (url: string, hash: string, natives: Record<string, string> = {}, extra: Partial<PluginPackage> = {}) =>
		served.set(url, { pkg: { name: `plugin ${hash}`, hash, version: hash, ...extra }, code: `code ${hash}`, natives });
	const forgotten: string[] = [];
	/** url -> native files allowed for all versions */
	const allVersions = new Map<string, string[]>();
	const writes: CoreState[] = [];
	const nativesOf = new Map<string, Record<string, string>>();
	const reads = { count: 0 };
	const deps = {
		read: () => state,
		write: (next: CoreState) => void writes.push(JSON.parse(JSON.stringify(next))),
		fetchPackage: async (url: string) => {
			const entry = served.get(url);
			if (entry === undefined) throw new Error(`offline: ${url}`);
			return { ...entry.pkg };
		},
		fetchCode: async (url: string) => {
			const entry = served.get(url);
			if (entry === undefined) throw new Error(`offline: ${url}`);
			nativesOf.set(entry.code, entry.natives);
			return entry.code;
		},
		nativeSources: (code: string) => {
			reads.count++;
			return nativesOf.get(code) ?? {};
		},
		forgetAnswers: (url: string) => void forgotten.push(url),
		allVersionsAnswers: (url: string) => allVersions.get(url) ?? [],
		revokeAllVersions: (url: string) => void allVersions.delete(url),
	};
	return { deps, serve, served, forgotten, writes, reads, allVersions };
};

/** A confirmation line as the page shows it */
const lineText = (line: ConfirmLine) =>
	typeof line === "string" ? line : line.map((part) => (typeof part === "string" ? part : part.text)).join("");

/** An asker that answers `answer` and records what it was asked */
const asker = (answer: boolean) => {
	const asked: ConfirmRequest[] = [];
	const ask = async (request: ConfirmRequest) => {
		asked.push(request);
		return answer;
	};
	return Object.assign(ask, { asked });
};

describe("core registry", () => {
	it("installs only after the user confirms", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);

		const no = asker(false);
		expect(await registry.install(URL, no)).toBe(false);
		expect(no.asked.length).toBe(1);
		expect(registry.info(URL)).toBe(undefined);
		expect(registry.isEnabled(URL)).toBe(false);

		const yes = asker(true);
		expect(await registry.install(URL, yes)).toBe(true);
		expect(yes.asked[0].title).toMatch(/^Install /);
		expect(registry.isEnabled(URL)).toBe(true);
		expect(registry.info(URL)?.hash).toBe("v1");
	});

	it("asks before enabling native code, not plain page code", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		serve(DEV_URL, "d1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		await registry.install(DEV_URL, asker(true));
		await registry.disable(URL);
		await registry.disable(DEV_URL);

		const plain = asker(false);
		expect(await registry.enable(DEV_URL, plain)).toBe(true);
		expect(plain.asked.length).toBe(0);

		const no = asker(false);
		expect(await registry.enable(URL, no)).toBe(false);
		expect(no.asked.length).toBe(1);
		expect(registry.isEnabled(URL)).toBe(false);
		expect(await registry.enable(URL, asker(true))).toBe(true);
		expect(registry.isEnabled(URL)).toBe(true);
	});

	it("registers native code only for the accepted code of an enabled plugin", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);

		await registry.install(URL, asker(true));
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);
		// Other code under the same name, or a file the plugin doesn't have
		expect(registry.nativeOwner("a.native.ts", "native a, changed")).toBe(undefined);
		expect(registry.nativeOwner("b.native.ts", "native a")).toBe(undefined);

		await registry.disable(URL);
		expect(registry.isEnabled(URL)).toBe(false);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
	});

	it("keeps running the accepted version until the user accepts an update", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));

		serve(URL, "v2", { "a.native.ts": "native a2", "b.native.ts": "native b" });
		const loaded = await registry.load(URL);
		expect(loaded.package.hash).toBe("v1");
		expect(loaded.pending?.added).toStrictEqual(["b.native.ts"]);
		// The new native code isn't registered before it is accepted
		expect(registry.nativeOwner("b.native.ts", "native b")).toBe(undefined);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);

		const no = asker(false);
		expect(await registry.acceptUpdate(URL, no)).toBe(false);
		expect(no.asked[0].lines.map(lineText).includes(`Update only if you trust the author and ${URL}`)).toBeTruthy();
		expect(shownWarning(no.asked[0])).toBe(undefined);
		expect(registry.info(URL)?.hash).toBe("v1");

		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		expect(registry.info(URL)?.hash).toBe("v2");
		expect(registry.info(URL)?.pending).toBe(undefined);
		expect(registry.nativeOwner("b.native.ts", "native b")).toBe(URL);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
		// What v1 registered can't be called any more
		expect(registry.ownsNative(URL, "a.native.ts", "native a")).toBe(false);
		expect(registry.ownsNative(URL, "a.native.ts", "native a2")).toBe(true);
	});

	it("accepts the update the user was asked about, a newer one found meanwhile waits", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serve(URL, "v2");
		await registry.load(URL);

		let laterLoad: Promise<unknown> | undefined;
		const ask = async () => {
			serve(URL, "v3");
			laterLoad = registry.load(URL);
			return true;
		};
		// load waits for acceptUpdate (one operation per url): the user accepted v2, and v3 waits for its own window
		expect(await registry.acceptUpdate(URL, ask)).toBe(true);
		await laterLoad;
		expect(registry.info(URL)?.hash).toBe("v2");
		expect(registry.info(URL)?.pending?.hash).toBe("v3");
	});

	it("accepts dev updates without asking", async () => {
		const { deps, serve } = fakeDeps();
		serve(DEV_URL, "d1");
		const registry = createRegistry(deps);
		await registry.install(DEV_URL, asker(true));
		serve(DEV_URL, "d2", { "a.native.ts": "native a" });
		expect((await registry.load(DEV_URL)).package.hash).toBe("d2");
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(DEV_URL);
	});

	it("runs the accepted version offline, and nothing for a disabled plugin", async () => {
		const { deps, serve, served } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		served.delete(URL);
		expect((await registry.load(URL)).package.hash).toBe("v1");
		await registry.disable(URL);
		await expect(registry.load(URL)).rejects.toThrow(/not enabled/);
	});

	it("disables migrated native plugins until the user reviews them", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		serve(DEV_URL, "d1");
		const registry = createRegistry(deps);
		expect(registry.needsMigration()).toBe(true);
		await registry.migrate([
			{ url: URL, name: "native", enabled: true },
			{ url: DEV_URL, name: "plain", enabled: true },
			{ url: "https://luna/core", name: "core", enabled: true },
		]);
		expect(registry.needsMigration()).toBe(false);
		expect(registry.info("https://luna/core")).toBe(undefined);

		await expect(registry.load(URL)).rejects.toThrow(/has native code/);
		expect(registry.isEnabled(URL)).toBe(false);
		// Waiting for its first review, not an update: the page shows it disabled, with no Update button
		expect(registry.info(URL)?.pending).toBe(undefined);
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(false);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
		expect((await registry.load(DEV_URL)).package.hash).toBe("d1");

		const yes = asker(true);
		expect(await registry.enable(URL, yes)).toBe(true);
		expect(yes.asked.length).toBe(1);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);
	});

	it("migrates only once, and never over a stored state", async () => {
		const stored: CoreState = { version: 1, plugins: {} };
		const registry = createRegistry(fakeDeps(stored).deps);
		expect(registry.needsMigration()).toBe(false);
		await registry.migrate([{ url: URL, name: "x", enabled: true }]);
		expect(registry.info(URL)).toBe(undefined);
	});

	it("reads an accepted bundle's native files once, however often they are checked", async () => {
		const { deps, serve, reads } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		const before = reads.count;
		for (let i = 0; i < 5; i++) expect(registry.ownsNative(URL, "a.native.ts", "native a")).toBe(true);
		expect(reads.count - before <= 1).toBeTruthy();
	});

	it("forgets native answers on uninstall", async () => {
		const { deps, serve, forgotten } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		await registry.uninstall(URL);
		expect(forgotten).toStrictEqual([URL]);
		expect(registry.info(URL)).toBe(undefined);
		expect(registry.isEnabled(URL)).toBe(false);
	});

	it("shows the sha256 of the code the page runs, before and after an update", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		const v1 = createHash("sha256").update("code v1", "utf8").digest("hex");
		expect(registry.info(URL)?.codeSha256).toBe(v1);
		expect((await registry.load(URL)).package.codeSha256).toBe(v1);

		serve(URL, "v2");
		const v2 = createHash("sha256").update("code v2", "utf8").digest("hex");
		expect((await registry.load(URL)).pending?.codeSha256).toBe(v2);
		const ask = asker(false);
		await registry.acceptUpdate(URL, ask);
		expect(ask.asked[0].lines.map(lineText).includes(`Code sha256: ${v1.slice(0, 12)} -> ${v2.slice(0, 12)}`)).toBeTruthy();
	});

	it("links the update's versions, release and changes, and the plugin url", async () => {
		const RELEASE = "https://github.com/owner/repo/releases/download/latest/plugin";
		const [A, B] = ["a".repeat(40), "b".repeat(40)];
		const { deps, serve } = fakeDeps();
		serve(RELEASE, "v1", {}, { commit: A });
		const registry = createRegistry(deps);
		await registry.install(RELEASE, asker(true));
		serve(RELEASE, "v2", {}, { commit: B });
		await registry.load(RELEASE);
		const ask = asker(false);
		await registry.acceptUpdate(RELEASE, ask);
		const [versions, hashes, trust] = ask.asked[0].lines;
		expect(versions).toStrictEqual([
			{ text: "v1", href: `https://github.com/owner/repo/commit/${A}` },
			" -> ",
			{ text: "v2", href: `https://github.com/owner/repo/commit/${B}` },
			" (",
			{ text: "release latest", href: "https://github.com/owner/repo/releases/tag/latest" },
			")",
		]);
		expect((hashes as Exclude<ConfirmLine, string>).slice(1)).toStrictEqual([
			" (",
			{ text: "changes", href: `https://github.com/owner/repo/compare/${A}...${B}` },
			")",
		]);
		expect(trust).toStrictEqual(["Update only if you trust the author and ", { text: RELEASE, href: `${RELEASE}.json` }]);
	});

	it("keeps the version the user has when the confirmation is rejected (as when its Ask again action fails)", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(URL);
		const failing = async () => {
			throw new Error('"Ask again" failed');
		};
		await expect(registry.acceptUpdate(URL, failing)).rejects.toThrow(/Ask again/);
		expect(registry.info(URL)?.hash).toBe("v1");
		expect(registry.info(URL)?.pending?.hash).toBe("v2");
		// The url's queue goes on
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		expect(registry.info(URL)?.hash).toBe("v2");
	});

	it("warns when the plugin's native files are allowed for all versions, and asks again only if the user updates", async () => {
		const { deps, serve, allVersions } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(URL);

		const no = asker(false);
		await registry.acceptUpdate(URL, no);
		// Taken when the window shows: an answer given while it waited counts
		allVersions.set(URL, ["a.native.ts", "gone.native.ts"]);
		const warning = shownWarning(no.asked[0]);
		// Only the update's own files
		expect(warning?.text).toBe("Native code allowed for all versions (a.native.ts): the update's runs without asking.");
		expect(warning?.action).toBe("Ask again");
		allVersions.set(URL, ["gone.native.ts"]);
		expect(shownWarning(no.asked[0])).toBe(undefined);
		allVersions.set(URL, ["a.native.ts", "gone.native.ts"]);
		// The window runs it only when the user chose it and then confirmed (confirmWindow.ts)
		expect(allVersions.get(URL)).toStrictEqual(["a.native.ts", "gone.native.ts"]);
		await warning!.run();
		expect(allVersions.get(URL)).toBe(undefined);
	});

	it("does nothing for Luna's own plugins and refuses non-plugin urls", async () => {
		const registry = createRegistry(fakeDeps().deps);
		const ask = asker(true);
		expect(await registry.install("https://luna/core", ask)).toBe(true);
		expect(ask.asked.length).toBe(0);
		await expect(registry.install("file:///C:/x", ask)).rejects.toThrow(/Not a plugin url/);
		expect(() => registry.info(42)).toThrow(/Not a plugin url/);
	});

	it("moves a plugin to a new store url, other code there waits as an update", async () => {
		const NEW_URL = "https://example.org/plugin";
		const { deps, serve, served, forgotten } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));

		// The same code (fetchCode adds the url's sourceURL in Luna; the fake serves it bare)
		served.set(NEW_URL, served.get(URL)!);
		expect(await registry.moveUrl(URL, NEW_URL)).toBe(true);
		expect(registry.info(URL)).toBe(undefined);
		expect(registry.info(NEW_URL)?.enabled).toBe(true);
		expect(registry.info(NEW_URL)?.pending).toBe(undefined);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(NEW_URL);
		expect(forgotten).toStrictEqual([URL]);

		const OTHER_URL = "https://example.net/plugin";
		serve(OTHER_URL, "v2");
		expect(await registry.moveUrl(NEW_URL, OTHER_URL)).toBe(true);
		expect(registry.info(OTHER_URL)?.hash).toBe("v1");
		expect(registry.info(OTHER_URL)?.pending?.hash).toBe("v2");
	});

	it("drops a waiting update the url no longer serves", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serve(URL, "v2");
		expect((await registry.load(URL)).pending?.hash).toBe("v2");
		serve(URL, "v1");
		expect((await registry.load(URL)).pending).toBe(undefined);
		expect(registry.info(URL)?.pending).toBe(undefined);
	});

	it("doesn't move to or from a dev url, nor over an installed plugin", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		serve(DEV_URL, "d1");
		serve("https://example.org/plugin", "v2");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		await registry.install("https://example.org/plugin", asker(true));
		await expect(registry.moveUrl(URL, DEV_URL)).rejects.toThrow(/Can't move/);
		await expect(registry.moveUrl(URL, "https://example.org/plugin")).rejects.toThrow(/already installed/);
		expect(await registry.moveUrl("https://example.com/none", "https://example.com/other")).toBe(false);
		expect(registry.info(URL)?.hash).toBe("v1");
	});
});
