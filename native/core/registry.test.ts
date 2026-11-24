import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import { shownWarning, type ConfirmLine, type ConfirmRequest } from "./confirmPage";
import { pluginIdOf, servedSha256 } from "./legacyList";
import { createRegistry, showEntries, type CoreState, type PluginPackage } from "./registry";

const URL = "https://example.com/plugin";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const DEV_URL = "http://127.0.0.1:3000/plugin";

/** A fake server: url -> package and code. `natives` lists the native files the code registers */
const fakeDeps = (state: CoreState | null = null) => {
	const served = new Map<string, { pkg: PluginPackage; code: string; natives: Record<string, string> }>();
	const serve = (url: string, hash: string, natives: Record<string, string> = {}, extra: Partial<PluginPackage> = {}) =>
		served.set(url, { pkg: { name: `plugin ${hash}`, hash, version: hash, ...extra }, code: `code ${hash}`, natives });
	/** url -> the `.world.json` text it serves */
	const worlds = new Map<string, string>();
	/** Serves a plugin with a world: its world natives, and the worldHash its json names (the real one by default) */
	const serveWorld = (url: string, hash: string, worldNatives: Record<string, string>, worldHash?: string) => {
		const world = JSON.stringify({ code: `world ${hash}`, natives: worldNatives });
		worlds.set(url, world);
		serve(url, hash, {}, { lunaWorld: "./src/world.ts", worldHash: worldHash ?? sha256(world) });
		return world;
	};
	const forgotten: string[] = [];
	/** url -> native files allowed for all versions */
	const allVersions = new Map<string, string[]>();
	const writes: CoreState[] = [];
	const nativesOf = new Map<string, Record<string, string>>();
	const reads = { count: 0 };
	/** The registry's old native format list: `${id}\n${sha256 of the served code}` */
	const listed = new Set<string>();
	/** Puts `url`'s plugin at `hash` (its served code `code ${hash}`) on the old native format list */
	const list = (url: string, hash: string) => void listed.add(`${pluginIdOf(url)}\n${servedSha256(`code ${hash}`)}`);
	const deps = {
		legacyAllows: (id: string, sha: string) => listed.has(`${id}\n${sha}`),
		/** Not a registry dep: lets installLegacy list a version */
		list,
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
		fetchWorld: async (url: string) => {
			const world = worlds.get(url);
			if (world === undefined) throw new Error(`offline: ${url}.world.json`);
			return world;
		},
		nativeSources: (code: string) => {
			reads.count++;
			return nativesOf.get(code) ?? {};
		},
		forgetAnswers: (url: string) => void forgotten.push(url),
		allVersionsAnswers: (url: string) => allVersions.get(url) ?? [],
		revokeAllVersions: (url: string) => void allVersions.delete(url),
	};
	return { deps, serve, serveWorld, served, forgotten, writes, reads, list, allVersions };
};

/**
 * A plugin from before isolated worlds (old native format): its version is on the list, handed over by migrate, then
 * reviewed and enabled. Needs a fresh registry and `url` served at `hash`
 */
const installLegacy = async (
	registry: ReturnType<typeof createRegistry>,
	deps: { list(url: string, hash: string): void },
	url: string,
	hash: string,
) => {
	deps.list(url, hash);
	await registry.migrate([{ url, name: "legacy", enabled: true }]);
	await registry.load(url).catch(() => {});
	expect(await registry.enable(url, asker(true))).toBe(true);
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

		await installLegacy(registry, deps, URL, "v1");
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
		await installLegacy(registry, deps, URL, "v1");

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
		expect(no.asked[0].lines.map(lineText).some((line) => line.includes("After this update it can't any more"))).toBeTruthy();
		expect(registry.info(URL)?.hash).toBe("v1");

		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		expect(registry.info(URL)?.hash).toBe("v2");
		expect(registry.info(URL)?.pending).toBe(undefined);
		// What v1 registered can't be called any more, and v2 in the old format doesn't run at all
		expect(registry.ownsNative(URL, "a.native.ts", "native a")).toBe(false);
		expect(registry.ownsNative(URL, "a.native.ts", "native a2")).toBe(false);
		expect(registry.nativeOwner("b.native.ts", "native b")).toBe(undefined);
		expect(registry.legacyRefusal("b.native.ts", "native b") ?? "").toMatch(/old native format.*must move it to the new format/);
		expect(registry.info(URL)?.legacyNatives).toBe("refused");
	});

	it("takes any change of the served code as an update the user is asked about, whatever the package says", async () => {
		const { deps, serve, served } = fakeDeps();
		serve(URL, "v1", {}, { version: "1.2.0" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));

		// Other code under the same hash and version: the accepted code keeps running, the new code waits
		served.get(URL)!.code = "code changed";
		let loaded = await registry.load(URL);
		expect(loaded.code).toBe("code v1");
		expect(loaded.pending?.codeSha256).toBe(sha256("code changed"));
		const no = asker(false);
		expect(await registry.acceptUpdate(URL, no)).toBe(false);
		expect(no.asked[0].lines.map(lineText).includes("1.2.0 -> 1.2.0")).toBeTruthy();
		expect(
			no.asked[0].lines.map(lineText).includes(`Code sha256: ${sha256("code v1").slice(0, 12)} -> ${sha256("code changed").slice(0, 12)}`),
		).toBeTruthy();
		expect((await registry.load(URL)).code).toBe("code v1");

		// A new hash at a lower version number: an update too, asked about like any other
		serve(URL, "v0", {}, { version: "1.0.0" });
		loaded = await registry.load(URL);
		expect(loaded.code).toBe("code v1");
		expect(loaded.pending?.version).toBe("1.0.0");
		const yes = asker(true);
		expect(await registry.acceptUpdate(URL, yes)).toBe(true);
		expect(yes.asked.length).toBe(1);
		expect((await registry.load(URL)).code).toBe("code v0");

		// The url serves the accepted code again: no update
		expect((await registry.load(URL)).pending).toBe(undefined);
	});

	it("takes other code of a world plugin under the same hashes as an update, and replaces a waiting one", async () => {
		const { deps, serveWorld, served } = fakeDeps();
		serveWorld(URL, "w1", {});
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		served.get(URL)!.code = "code a";
		expect((await registry.load(URL)).pending?.codeSha256).toBe(sha256("code a"));
		served.get(URL)!.code = "code b";
		const loaded = await registry.load(URL);
		expect(loaded.code).toBe("code w1");
		expect(loaded.pending?.codeSha256).toBe(sha256("code b"));
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		expect((await registry.load(URL)).code).toBe("code b");
	});

	it("refuses plugin urls with control characters or line breaks, which would run as code in the sourceURL line", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		for (const bad of [
			"https://evil.example/p\u2028globalThis.x=1//",
			"https://evil.example/p\u2029x",
			"https://evil.example/p\nx",
			"https://evil.example/p\rx",
			"https://evil.example/p\u0000",
		]) {
			serve(bad, "v1");
			await expect(registry.moveUrl(URL, bad)).rejects.toThrow(/Not a plugin url/);
			await expect(registry.install(bad, asker(true))).rejects.toThrow(/Not a plugin url/);
			await expect(registry.load(bad)).rejects.toThrow(/Not a plugin url/);
		}
		await registry.migrate([{ url: "https://evil.example/p\u2028x", name: "evil", enabled: true }]);
		expect(registry.list().map((plugin) => plugin.url)).toStrictEqual([URL]);
		// A space is no line break: a store path with one still works
		serve("https://example.org/a b", "v1");
		expect(await registry.install("https://example.org/a b", asker(true))).toBe(true);
		// Code after a line break in the last line isn't taken for the sourceURL line
		expect(servedSha256("code\n//# sourceURL=https://a/p\u2028evil()//.mjs")).not.toBe(servedSha256("code"));
		expect(servedSha256("code\n//# sourceURL=https://a/p.mjs")).toBe(servedSha256("code"));
	});

	it("moves a plugin twice, offline then online, with no update for the same code", async () => {
		const { deps, serve, served } = fakeDeps();
		const B = "https://example.org/plugin";
		const C = "https://example.net/plugin";
		serve(URL, "v1");
		served.get(URL)!.code = `code v1\n//# sourceURL=${URL}.mjs`;
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		expect(await registry.moveUrl(URL, B)).toBe(true);
		serve(C, "v1");
		served.get(C)!.code = `code v1\n//# sourceURL=${C}.mjs`;
		expect(await registry.moveUrl(B, C)).toBe(true);
		expect(registry.info(C)?.pending).toBe(undefined);
		// The accepted text runs as it was accepted, with its first url's line
		expect((await registry.load(C)).code).toBe(`code v1\n//# sourceURL=${URL}.mjs`);
	});

	it("keeps the accepted text on a move, so the new url's sourceURL line can't change what runs", async () => {
		const { deps, serve, served } = fakeDeps();
		const EVIL = "https://evil.example/p*/;globalThis.pwn=1//";
		const open = "code v1 /*";
		serve(URL, "v1");
		served.get(URL)!.code = `${open}\n//# sourceURL=${URL}.mjs`;
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serve(EVIL, "v1");
		served.get(EVIL)!.code = `${open}\n//# sourceURL=${EVIL}.mjs`;
		expect(await registry.moveUrl(URL, EVIL)).toBe(true);
		expect(registry.info(EVIL)?.pending).toBe(undefined);
		const loaded = await registry.load(EVIL);
		expect(loaded.code).toBe(`${open}\n//# sourceURL=${URL}.mjs`);
		expect(!loaded.code.includes("pwn")).toBeTruthy();
	});

	it("can still disable and uninstall a plugin stored under a url that is refused now", async () => {
		const BAD = "https://example.org/p\u2028x";
		const { deps } = fakeDeps({
			version: 1,
			plugins: {
				[BAD]: {
					url: BAD,
					name: "old",
					enabled: true,
					accepted: { package: { name: "old", hash: "h" }, code: "code", codeSha256: sha256("code"), natives: [] },
				},
			},
		} as CoreState);
		const registry = createRegistry(deps);
		await expect(registry.load(BAD)).rejects.toThrow(/Not a plugin url/);
		await registry.disable(BAD);
		expect(registry.info(BAD)?.enabled).toBe(false);
		await registry.uninstall(BAD);
		expect(registry.list()).toStrictEqual([]);
		// Only urls stored as plugins, not names every object has
		for (const name of ["constructor", "toString", "__proto__"]) {
			expect(() => registry.info(name)).toThrow(/Not a plugin url/);
			await expect(registry.disable(name)).rejects.toThrow(/Not a plugin url/);
			await expect(registry.uninstall(name)).rejects.toThrow(/Not a plugin url/);
		}
	});

	it("sees no update for the same code under another sourceURL line (a store moved offline)", async () => {
		const { deps, serve, served } = fakeDeps();
		const NEW = "https://example.org/plugin";
		serve(URL, "v1");
		served.get(URL)!.code = `code v1\n//# sourceURL=${URL}.mjs`;
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		// Offline: the accepted code moves with its old line
		served.delete(URL);
		expect(await registry.moveUrl(URL, NEW)).toBe(true);
		serve(NEW, "v1");
		served.get(NEW)!.code = `code v1\n//# sourceURL=${NEW}.mjs`;
		expect((await registry.load(NEW)).pending).toBe(undefined);
		// Other code at the new url is still an update
		served.get(NEW)!.code = `code v2\n//# sourceURL=${NEW}.mjs`;
		expect((await registry.load(NEW)).pending?.codeSha256).toBe(sha256(`code v2\n//# sourceURL=${NEW}.mjs`));
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
		const { deps, serve, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		list(URL, "v1");
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

	it("doesn't migrate again once the page handed its plugins over, though the state file is gone", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		let migrated = false;
		const marked = { ...deps, wasMigrated: () => migrated, markMigrated: () => void (migrated = true) };
		await createRegistry(marked).migrate([{ url: "https://example.org/old", name: "old", enabled: true }]);
		expect(migrated).toBe(true);
		// The state file lost (read gives null again): no second hand-over
		const registry = createRegistry(marked);
		expect(registry.needsMigration()).toBe(false);
		await registry.migrate([{ url: URL, name: "legacy", enabled: true }]);
		expect(registry.info(URL)).toBe(undefined);
	});

	it("migrates no plugin the core installed already", async () => {
		const { deps, serve, writes } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		await registry.migrate([{ url: URL, name: "legacy", enabled: false }]);
		expect(writes.at(-1)?.plugins[URL]?.unreviewed).toBe(undefined);
		expect(registry.isEnabled(URL)).toBe(true);
		expect(registry.info(URL)?.legacyNatives).toBe("refused");
	});

	it("matches the list by the served code, whatever url its sourceURL line names", async () => {
		const { deps, serve, served, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const entry = served.get(URL)!;
		served.set(URL, { ...entry, code: `${entry.code}\n//# sourceURL=https://old.example/plugin.mjs` });
		list(URL, "v1");
		const registry = createRegistry(deps);
		expect(await registry.install(URL, asker(true))).toBe(true);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);
	});

	it("keeps a listed plugin on the old format at a new store url, and one that left it off it there", async () => {
		const NEW_URL = "https://example.org/plugin";
		const OTHER_URL = "https://example.net/plugin";
		const { deps, serve, served, writes, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		list(URL, "v1");
		const registry = createRegistry(deps);
		await registry.migrate([{ url: URL, name: "legacy", enabled: true }]);
		// Not reviewed yet: it moves as it is
		served.set(NEW_URL, served.get(URL)!);
		expect(await registry.moveUrl(URL, NEW_URL)).toBe(true);
		await registry.load(NEW_URL).catch(() => {});
		expect(await registry.enable(NEW_URL, asker(true))).toBe(true);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(NEW_URL);

		// It updates (leaves the old format), goes back to the listed version, then moves: still off
		serve(NEW_URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(NEW_URL);
		expect(await registry.acceptUpdate(NEW_URL, asker(true))).toBe(true);
		serve(NEW_URL, "v1", { "a.native.ts": "native a" });
		await registry.load(NEW_URL);
		expect(await registry.acceptUpdate(NEW_URL, asker(true))).toBe(true);
		served.set(OTHER_URL, served.get(NEW_URL)!);
		expect(await registry.moveUrl(NEW_URL, OTHER_URL)).toBe(true);
		expect(registry.info(OTHER_URL)?.hash).toBe("v1");
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
		// The url it moved from leaves with it
		expect(writes.at(-1)?.legacyOff).toStrictEqual([NEW_URL, URL, OTHER_URL]);
	});

	it("reads an accepted bundle's native files once, however often they are checked", async () => {
		const { deps, serve, reads } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
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
		const { lines } = ask.asked[0];
		// Notes (the plugin's network policy, say) come between the hashes and the trust line
		const [versions, hashes] = lines;
		const trust = lines.at(-1);
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
		const { deps, serveWorld, allVersions } = fakeDeps();
		serveWorld(URL, "v1", { "w.native.ts": "world native" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serveWorld(URL, "v2", { "w.native.ts": "world native 2" });
		await registry.load(URL);

		const no = asker(false);
		await registry.acceptUpdate(URL, no);
		// Taken when the window shows: an answer given while it waited counts. As the trust store names them (native/worlds.ts)
		allVersions.set(URL, ["world:w.native.ts", "world:gone.native.ts"]);
		const warning = shownWarning(no.asked[0]);
		// Only the update's own files
		expect(warning?.text).toBe("Native code allowed for all versions (w.native.ts): the update's runs without asking.");
		expect(warning?.action).toBe("Ask again");
		allVersions.set(URL, ["world:gone.native.ts"]);
		expect(shownWarning(no.asked[0])).toBe(undefined);
		allVersions.set(URL, ["world:w.native.ts", "world:gone.native.ts"]);
		// The window runs it only when the user chose it and then confirmed (confirmWindow.ts)
		expect(allVersions.get(URL)).toStrictEqual(["world:w.native.ts", "world:gone.native.ts"]);
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

	it("pins a plugin world with its code, and lists its natives apart", async () => {
		const { deps, serve, serveWorld } = fakeDeps();
		const world1 = serveWorld(URL, "v1", { "w.native.ts": "world native" });
		const registry = createRegistry(deps);
		const install = asker(true);
		await registry.install(URL, install);
		expect(registry.info(URL)?.natives).toStrictEqual(["world:w.native.ts"]);
		expect(registry.acceptedWorld(URL)).toBe(world1);
		const lines = install.asked[0].lines.map(lineText).join(" ");
		expect(lines).toMatch(/w\.native\.ts\. Only the plugin's own isolated world can call it/);
		expect(lines).not.toMatch(/Legacy native plugin/);
		// Page code can't register a world's natives as its own
		expect(registry.nativeOwner("world:w.native.ts", "world native")).toBe(undefined);
		expect(registry.nativeOwner("w.native.ts", "world native")).toBe(undefined);

		// A new world alone is an update: the accepted one keeps running until the user accepts it
		const world2 = serveWorld(URL, "v1", { "w.native.ts": "world native", "x.native.ts": "another" });
		expect((await registry.load(URL)).pending?.added).toStrictEqual(["world:x.native.ts"]);
		expect(registry.acceptedWorld(URL)).toBe(world1);
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		expect(registry.acceptedWorld(URL)).toBe(world2);

		await registry.disable(URL);
		expect(registry.acceptedWorld(URL)).toBe(undefined);
		serve(URL, "plain");
		expect(registry.acceptedWorld(URL)).toBe(undefined);
	});

	it("refuses a world that doesn't match the worldHash its package names", async () => {
		const { deps, serveWorld } = fakeDeps();
		serveWorld(URL, "v1", {}, "0".repeat(64));
		const registry = createRegistry(deps);
		await expect(registry.install(URL, asker(true))).rejects.toThrow(/doesn't match the worldHash/);
		expect(registry.info(URL)).toBe(undefined);
	});

	it("calls page-registered natives legacy, and they run only for plugin versions on the list", async () => {
		const { deps, serve, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		list(URL, "v1");
		const registry = createRegistry(deps);
		await registry.migrate([{ url: URL, name: "legacy", enabled: true }]);
		await registry.load(URL).catch(() => {});
		const ask = asker(true);
		await registry.enable(URL, ask);
		expect(ask.asked[0].lines.map(lineText).join(" ")).toMatch(
			/Legacy native plugin: while it is enabled, any plugin or script in the page can call its native functions/,
		);
		expect(ask.asked[0].lines.map(lineText).join(" ")).toMatch(/on Luna's list of plugins from before isolated worlds\. An update takes it off/);
		expect(registry.info(URL)?.legacyNatives).toBe("allowed");

		// A new plugin in the old format installs after a warning, but its natives don't run
		const NEW_URL = "https://example.org/new";
		serve(NEW_URL, "n1", { "n.native.ts": "native n" });
		const install = asker(true);
		expect(await registry.install(NEW_URL, install)).toBe(true);
		expect(install.asked[0].lines.map(lineText).join(" ")).toMatch(/Old native format, without isolation: n\.native\.ts won't run/);
		expect(registry.info(NEW_URL)?.legacyNatives).toBe("refused");
		expect(registry.nativeOwner("n.native.ts", "native n")).toBe(undefined);
		expect(registry.legacyRefusal("n.native.ts", "native n") ?? "").toMatch(/plugin n1 uses the old native format/);

		// From this computer the old format runs (the user is its author)
		serve(DEV_URL, "d1", { "d.native.ts": "native d" });
		await registry.install(DEV_URL, asker(true));
		expect(registry.nativeOwner("d.native.ts", "native d")).toBe(DEV_URL);
	});

	it("says what an install or update of old-format code will do: run without isolation, or not run", async () => {
		const { deps, serve, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		list(URL, "v1");
		const registry = createRegistry(deps);
		const ask = asker(true);
		await registry.install(URL, ask);
		expect(ask.asked[0].lines.map(lineText).join(" ")).toMatch(/any plugin or script in the page can call its native functions/);
		expect(ask.asked[0].lines.map(lineText).join(" ")).not.toMatch(/won't run/);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);
		// An update to unlisted code says it won't run
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(URL);
		const update = asker(true);
		await registry.acceptUpdate(URL, update);
		expect(update.asked[0].lines.map(lineText).join(" ")).toMatch(/won't run/);
	});

	it("takes a url off the old format once other code moves onto it where old-format code ran", async () => {
		const B = "https://example.org/plugin";
		const { deps, serve, served, list } = fakeDeps();
		serve(B, "v1", { "a.native.ts": "native a" });
		serve(URL, "v2", { "a.native.ts": "native a2" });
		list(B, "v1");
		list(URL, "v2");
		const registry = createRegistry(deps);
		await registry.install(B, asker(true));
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(B);
		await registry.uninstall(B);
		// Other listed code moves onto B, then B goes back to the code that ran there first
		await registry.install(URL, asker(true));
		served.set(B, served.get(URL)!);
		expect(await registry.moveUrl(URL, B)).toBe(true);
		await registry.uninstall(B);
		serve(B, "v1", { "a.native.ts": "native a" });
		await registry.install(B, asker(true));
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
	});

	it("takes a plugin off the old format once other code replaces its listed version, also if that never ran", async () => {
		const { deps, serve, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		list(URL, "v1");
		let readable = false;
		const registry = createRegistry({ ...deps, legacyAllows: (id, sha) => readable && deps.legacyAllows(id, sha) });
		// Installed while the list is missing: its natives never ran
		await registry.install(URL, asker(true));
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
		await registry.uninstall(URL);
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.install(URL, asker(true));
		await registry.uninstall(URL);
		readable = true;
		serve(URL, "v1", { "a.native.ts": "native a" });
		await registry.install(URL, asker(true));
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
	});

	it("takes a plugin off the old format when it goes back to listed code from code without natives", async () => {
		const { deps, serve, list } = fakeDeps();
		list(URL, "v1");
		// Installed at the version without natives, then the store goes back to the listed code
		serve(URL, "v2");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serve(URL, "v1", { "a.native.ts": "native a" });
		await registry.load(URL);
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
		// The same after an uninstall: the first code accepted here was v2
		const fresh = fakeDeps();
		fresh.list(URL, "v1");
		fresh.serve(URL, "v2");
		const again = createRegistry(fresh.deps);
		await again.install(URL, asker(true));
		await again.uninstall(URL);
		fresh.serve(URL, "v1", { "a.native.ts": "native a" });
		await again.install(URL, asker(true));
		expect(again.nativeOwner("a.native.ts", "native a")).toBe(undefined);
		// Records accepted before first versions were noted for all code count from their accepted version
		const old = fakeDeps({ version: 1, plugins: {} });
		old.serve(URL, "v2");
		const first = createRegistry(old.deps);
		await first.install(URL, asker(true));
		const saved = old.writes.at(-1)!;
		delete saved.legacyRan;
		old.list(URL, "v1");
		const restarted = createRegistry({ ...old.deps, read: () => saved });
		old.serve(URL, "v1", { "a.native.ts": "native a" });
		await restarted.load(URL);
		expect(await restarted.acceptUpdate(URL, asker(true))).toBe(true);
		expect(restarted.nativeOwner("a.native.ts", "native a")).toBe(undefined);
	});

	it("keeps a plugin off the old format when it is reinstalled from another url of its store", async () => {
		const TAGGED = "https://example.com/v1/plugin";
		const { deps, serve, writes } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(URL);
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		await registry.uninstall(URL);
		// A release tag still serves the listed code under the same id
		serve(TAGGED, "v1", { "a.native.ts": "native a" });
		await registry.install(TAGGED, asker(true));
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
		expect(writes.at(-1)?.legacyOffIds).toStrictEqual(["plugin"]);

		// Other code first at one url, then the listed code at another: the same
		const other = fakeDeps();
		other.list(URL, "v1");
		other.serve(TAGGED, "v2", { "a.native.ts": "native a2" });
		const second = createRegistry(other.deps);
		await second.install(TAGGED, asker(true));
		await second.uninstall(TAGGED);
		other.serve(URL, "v1", { "a.native.ts": "native a" });
		await second.install(URL, asker(true));
		expect(second.nativeOwner("a.native.ts", "native a")).toBe(undefined);
	});

	it("waits for the list before saying whether old-format natives will run", async () => {
		const { deps, serve, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry({
			...deps,
			// The list arrives while the registry waits for it
			legacyReady: async () => list(URL, "v1"),
		});
		const ask = asker(true);
		expect(await registry.install(URL, ask)).toBe(true);
		expect(ask.asked[0].lines.map(lineText).join("\n")).toMatch(/any plugin or script in the page can call its native functions/);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);
	});

	it("says old-format natives depend on the list while none is loaded", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry({ ...deps, legacyLoaded: () => false });
		const ask = asker(false);
		await registry.install(URL, ask);
		const text = ask.asked[0].lines.map(lineText).join("\n");
		expect(text).toMatch(/isn't loaded yet/);
		expect(text).toMatch(/any plugin or script in the page can call its native functions/);
		expect(text).not.toMatch(/won't run/);
		// A plugin that left the old format is told it won't run, list or not
		const left = fakeDeps();
		left.serve(URL, "v1", { "a.native.ts": "native a" });
		const before = createRegistry(left.deps);
		await installLegacy(before, left.deps, URL, "v1");
		left.serve(URL, "v2", { "a.native.ts": "native a2" });
		await before.load(URL);
		await before.acceptUpdate(URL, asker(true));
		await before.uninstall(URL);
		const restarted = createRegistry({ ...left.deps, read: () => left.writes.at(-1)!, legacyLoaded: () => false });
		left.serve(URL, "v1", { "a.native.ts": "native a" });
		const again = asker(false);
		await restarted.install(URL, again);
		expect(again.asked[0].lines.map(lineText).join("\n")).toMatch(/won't run/);
	});

	it("takes a plugin off the old format when an update changes only its world", async () => {
		const { deps, serve, serveWorld, served } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);
		// The same bundle, now with a world
		serveWorld(URL, "v2", { "w.native.ts": "native w" });
		Object.assign(served.get(URL)!, { code: "code v1", natives: { "a.native.ts": "native a" } });
		await registry.load(URL);
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
	});

	it("takes the url a plugin moved from off the old format once it leaves at the new one", async () => {
		const NEW_URL = "https://example.org/plugin";
		const { deps, serve, served, writes } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);
		// The new url serves an update: it waits, then is accepted
		serve(NEW_URL, "v2", { "a.native.ts": "native a2" });
		expect(await registry.moveUrl(URL, NEW_URL)).toBe(true);
		expect(await registry.acceptUpdate(NEW_URL, asker(true))).toBe(true);
		await registry.uninstall(NEW_URL);
		// The old url still serves the listed code
		expect(served.get(URL)?.pkg.hash).toBe("v1");
		await registry.install(URL, asker(true));
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
		expect(writes.at(-1)?.legacyOff).toStrictEqual([NEW_URL, URL]);
		// Also after a restart
		const restarted = createRegistry({ ...deps, read: () => writes.at(-1)! });
		expect(restarted.nativeOwner("a.native.ts", "native a")).toBe(undefined);
	});

	it("runs the old format for no code off the list: a new plugin, one of the same name elsewhere, a second migrate", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const OTHER = "https://example.org/other";
		serve(OTHER, "o1", { "o.native.ts": "native o" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);

		await registry.install(OTHER, asker(true));
		// migrate runs once: a later call (page code) changes nothing
		await registry.migrate([{ url: OTHER, name: "other", enabled: true }]);
		expect(registry.nativeOwner("o.native.ts", "native o")).toBe(undefined);

		// Listed code under another plugin's name
		const LOOKALIKE = "https://example.org/lookalike";
		serve(LOOKALIKE, "v1", { "l.native.ts": "native l" });
		await registry.install(LOOKALIKE, asker(true));
		expect(registry.nativeOwner("l.native.ts", "native l")).toBe(undefined);

		// The listed version reinstalled runs again: it is still on the list
		await registry.uninstall(URL);
		await registry.install(URL, asker(true));
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);
	});

	it("takes a plugin off the old native format list for good once its code changes", async () => {
		const { deps, serve, writes } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);

		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(URL);
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		expect(writes.at(-1)?.legacyOff).toStrictEqual([URL]);

		// The url serves v1 again and the user goes back to it: still off the list
		serve(URL, "v1", { "a.native.ts": "native a" });
		await registry.load(URL);
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		expect(registry.info(URL)?.hash).toBe("v1");
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
		expect(registry.info(URL)?.legacyNatives).toBe("refused");

		// Neither a reinstall nor a restart brings it back
		await registry.uninstall(URL);
		await registry.install(URL, asker(true));
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
		const restarted = createRegistry({ ...deps, read: () => writes.at(-1)! });
		await restarted.load(URL);
		expect(restarted.nativeOwner("a.native.ts", "native a")).toBe(undefined);
	});

	it("takes a plugin off the old format once other code is installed where its old-format version ran", async () => {
		const { deps, serve, writes } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(URL);
		await registry.uninstall(URL);
		// The store serves an update meanwhile: installed fresh, not through an update
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.install(URL, asker(true));
		expect(writes.at(-1)?.legacyOff).toStrictEqual([URL]);
		serve(URL, "v1", { "a.native.ts": "native a" });
		await registry.load(URL);
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
	});

	it("takes a plugin off the old format on an update also while the list can't be read", async () => {
		const { deps, serve, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		let readable = false;
		const registry = createRegistry({ ...deps, legacyAllows: (id, sha) => readable && deps.legacyAllows(id, sha) });
		list(URL, "v1");
		await registry.migrate([{ url: URL, name: "legacy", enabled: true }]);
		await registry.load(URL).catch(() => {});
		expect(await registry.enable(URL, asker(true))).toBe(true);
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(URL);
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		// The list arrives, and the user goes back to the listed version
		readable = true;
		serve(URL, "v1", { "a.native.ts": "native a" });
		await registry.load(URL);
		expect(await registry.acceptUpdate(URL, asker(true))).toBe(true);
		expect(registry.nativeOwner("a.native.ts", "native a")).toBe(undefined);
	});

	it("keeps the old native format only for the version on the list", async () => {
		const { deps, serve, list } = fakeDeps();
		// The url already serves a newer version than the listed one
		serve(URL, "v2", { "a.native.ts": "native a2" });
		list(URL, "v1");
		const registry = createRegistry(deps);
		await registry.migrate([{ url: URL, name: "legacy", enabled: true }]);
		await registry.load(URL).catch(() => {});
		const ask = asker(true);
		expect(await registry.enable(URL, ask)).toBe(true);
		expect(ask.asked[0].lines.map(lineText).join(" ")).toMatch(/Old native format, without isolation/);
		expect(registry.nativeOwner("a.native.ts", "native a2")).toBe(undefined);
		expect(registry.info(URL)?.legacyNatives).toBe("refused");
	});

	it("moves a plugin to a new store url, other code there waits as an update", async () => {
		const NEW_URL = "https://example.org/plugin";
		const { deps, serve, served, forgotten } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");

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

	it("shows a change to the world alone in the update window", async () => {
		const { deps, serveWorld } = fakeDeps();
		serveWorld(URL, "v1", { "w.native.ts": "world native" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serveWorld(URL, "v1", { "w.native.ts": "changed world native" });
		await registry.load(URL);
		const ask = asker(false);
		await registry.acceptUpdate(URL, ask);
		expect(ask.asked[0].lines.map(lineText).join("\n")).toMatch(/World sha256: \w{12} -> \w{12}/);
	});

	it("names a world's native files allowed for all versions as the install window does", async () => {
		const { deps, serveWorld, allVersions } = fakeDeps();
		serveWorld(URL, "v1", { "w.native.ts": "world native" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serveWorld(URL, "v1", { "w.native.ts": "changed world native" });
		await registry.load(URL);
		// As the trust store names it (native/worlds.ts)
		allVersions.set(URL, ["world:w.native.ts"]);
		const ask = asker(false);
		await registry.acceptUpdate(URL, ask);
		expect(shownWarning(ask.asked[0])?.text).toBe("Native code allowed for all versions (w.native.ts): the update's runs without asking.");
	});

	it("leaves old-format native files that won't run out of the all-versions warning", async () => {
		const { deps, serve, list, allVersions } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		list(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		allVersions.set(URL, ["a.native.ts"]);
		serve(URL, "v2", { "a.native.ts": "native a2" });
		list(URL, "v2");
		await registry.load(URL);
		// Other code leaves the old format, listed or not: the window says it won't run, nothing to ask again for
		const ask = asker(false);
		await registry.acceptUpdate(URL, ask);
		expect(ask.asked[0].lines.map(lineText).join(" ")).toMatch(/won't run/);
		expect(shownWarning(ask.asked[0])).toBe(undefined);
	});

	it("moves a world plugin silently only when the new url serves the same world", async () => {
		const NEW_URL = "https://example.org/plugin";
		const { deps, serveWorld } = fakeDeps();
		const world1 = serveWorld(URL, "v1", { "w.native.ts": "world native" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		// Same page code, another world
		serveWorld(NEW_URL, "v1", { "w.native.ts": "other world native" });
		expect(await registry.moveUrl(URL, NEW_URL)).toBe(true);
		expect(registry.acceptedWorld(NEW_URL)).toBe(world1);
		expect(registry.info(NEW_URL)?.pending !== undefined).toBeTruthy();
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

	it("moves only one plugin to a url, whichever move finishes first", async () => {
		const TARGET = "https://example.org/target";
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		serve("https://example.com/b", "b1");
		serve(TARGET, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		await registry.install("https://example.com/b", asker(true));
		const results = await Promise.allSettled([registry.moveUrl(URL, TARGET), registry.moveUrl("https://example.com/b", TARGET)]);
		expect(results.map((result) => result.status)).toStrictEqual(["fulfilled", "rejected"]);
		expect(registry.info(TARGET)?.hash).toBe("v1");
		expect(registry.info("https://example.com/b")?.hash).toBe("b1");
	});

	it("doesn't install over a plugin a move put at the url while the user was asked", async () => {
		const TARGET = "https://example.org/target";
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		serve(TARGET, "t1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		const ask = async () => {
			expect(await registry.moveUrl(URL, TARGET)).toBe(true);
			return true;
		};
		await expect(registry.install(TARGET, ask)).rejects.toThrow(/installed meanwhile/);
		expect(registry.info(TARGET)?.hash).toBe("v1");
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

	it("shows a plugin's hosts when installing, and gives them to luna.fetch only once enabled", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", {}, { hosts: ["api.last.fm", "*", "*.example.com"] });
		const registry = createRegistry(deps);
		const yes = asker(true);
		await registry.install(URL, yes);
		const lines = yes.asked[0].lines;
		expect(lines.some((line) => line === "Network: the plugin says it connects to api.last.fm, *.example.com.")).toBeTruthy();
		expect(lines.some((line) => line === "Ignored, not valid hosts: *")).toBeTruthy();
		expect(registry.info(URL)?.hosts).toStrictEqual(["api.last.fm", "*.example.com"]);
		expect(registry.hostsOf(URL)).toStrictEqual({
			name: "plugin v1",
			mode: "declared",
			hosts: ["api.last.fm", "*.example.com"],
			allow: [],
			deny: [],
		});
		expect(registry.pageHosts()).toStrictEqual(["api.last.fm", "*.example.com"]);
		await registry.disable(URL);
		expect(registry.hostsOf(URL)).toBe(undefined);
		expect(registry.pageHosts()).toStrictEqual([]);
	});

	it("marks a plugin without hosts and without registry hosts as unlisted: its hosts are asked", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		const yes = asker(true);
		await registry.install(URL, yes);
		expect(yes.asked[0].lines.some((line) => line.includes("luna-registry has none for this version"))).toBeTruthy();
		expect(registry.hostsOf(URL)).toStrictEqual({ name: "plugin v1", mode: "unlisted", hosts: undefined, allow: [], deny: [] });
		expect(registry.info(URL)?.hosts).toBe(undefined);
	});

	it("treats new hosts as an update the user accepts, even with the same code", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", {}, { hosts: ["a.com"] });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));

		serve(URL, "v1", {}, { hosts: ["a.com", "b.com"] });
		const loaded = await registry.load(URL);
		expect(loaded.pending?.hostsAdded).toStrictEqual(["b.com"]);
		// The accepted hosts hold until the user accepts the new ones
		expect(registry.hostsOf(URL)?.hosts).toStrictEqual(["a.com"]);
		const yes = asker(true);
		expect(await registry.acceptUpdate(URL, yes)).toBe(true);
		expect(yes.asked[0].lines.includes("New network hosts: b.com")).toBeTruthy();
		expect(registry.hostsOf(URL)?.hosts).toStrictEqual(["a.com", "b.com"]);

		// Dropping the list (compatibility mode) is an update too, and says so
		serve(URL, "v1");
		await registry.load(URL);
		const drop = asker(false);
		expect(await registry.acceptUpdate(URL, drop)).toBe(false);
		expect(drop.asked[0].lines.some((line) => typeof line === "string" && line.startsWith("No longer lists its network hosts"))).toBeTruthy();
		expect(registry.hostsOf(URL)?.hosts).toStrictEqual(["a.com", "b.com"]);
	});

	it("doesn't move a plugin silently to a url that serves other hosts", async () => {
		const NEW_URL = "https://example.org/plugin";
		const { deps, serve, served } = fakeDeps();
		serve(URL, "v1", {}, { hosts: ["a.com"] });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		served.set(NEW_URL, { ...served.get(URL)!, pkg: { ...served.get(URL)!.pkg, hosts: ["a.com", "evil.com"] } });
		expect(await registry.moveUrl(URL, NEW_URL)).toBe(true);
		expect(registry.hostsOf(NEW_URL)?.hosts).toStrictEqual(["a.com"]);
		expect(registry.info(NEW_URL)?.pending?.hostsAdded).toStrictEqual(["evil.com"]);
	});

	it("disables migrated plugins that list local hosts until the user reviews them", async () => {
		const OTHER = "https://example.com/other";
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", {}, { hosts: ["http://192.168.1.10:8123"] });
		serve(OTHER, "w1", {}, { hosts: ["api.example.com"] });
		const registry = createRegistry(deps);
		await registry.migrate([
			{ url: URL, name: "lan", enabled: true },
			{ url: OTHER, name: "public", enabled: true },
		]);
		await expect(registry.load(URL)).rejects.toThrow(/lists local network hosts/);
		expect(registry.isEnabled(URL)).toBe(false);
		expect(registry.hostsOf(URL)).toBe(undefined);
		// Public hosts give nothing compatibility mode doesn't: accepted as before
		expect((await registry.load(OTHER)).package.hash).toBe("w1");

		const yes = asker(true);
		expect(await registry.enable(URL, yes)).toBe(true);
		expect(yes.asked[0].lines.some((line) => line.includes("http://192.168.1.10:8123"))).toBeTruthy();
		expect(registry.hostsOf(URL)?.hosts).toStrictEqual(["http://192.168.1.10:8123"]);
	});

	it("lists the local hosts an update adds to a plugin in compatibility mode", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serve(URL, "v1", {}, { hosts: ["http://192.168.1.10:8123"] });
		await registry.load(URL);
		expect(registry.hostsOf(URL)?.hosts).toBe(undefined);
		const yes = asker(true);
		expect(await registry.acceptUpdate(URL, yes)).toBe(true);
		expect(yes.asked[0].lines.some((line) => line.includes("http://192.168.1.10:8123"))).toBeTruthy();
		expect(registry.hostsOf(URL)?.hosts).toStrictEqual(["http://192.168.1.10:8123"]);
	});
});

describe("core registry network modes", () => {
	it("shows as many hosts as fit a window line, then how many more", () => {
		expect(showEntries(["a.com", "b.com"])).toBe("a.com, b.com");
		const many = Array.from({ length: 40 }, (_, i) => `host${i}.example.com`);
		const shown = showEntries(many);
		expect(shown.length < 600, String(shown.length)).toBeTruthy();
		expect(shown).toMatch(/and \d+ more \(Luna Settings > Network lists them all/);
		const count = Number(shown.match(/and (\d+) more/)![1]);
		expect(shown.split(" and ")[0].split(", ").length + count).toBe(40);
	});

	const servedSha = (hash: string) => servedSha256(`code ${hash}`);

	it("shows the registry's derived hosts for a plugin that lists none, and uses them once confirmed", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		const looked: [string, string][] = [];
		const registry = createRegistry({
			...deps,
			derivedHosts: (sha: string, name: string) => {
				looked.push([sha, name]);
				return sha === servedSha("v1") && name === "plugin v1" ? ["api.example.com", "*.cdn.example.net/covers/*"] : undefined;
			},
		});
		const yes = asker(true);
		await registry.install(URL, yes);
		expect(yes.asked[0].lines.includes("Network, read from its code by luna-registry: api.example.com, *.cdn.example.net/covers/*.")).toBeTruthy();
		expect(looked[0]).toStrictEqual([servedSha("v1"), "plugin v1"]);
		expect(registry.hostsOf(URL)).toStrictEqual({
			name: "plugin v1",
			mode: "derived",
			hosts: ["api.example.com", "*.cdn.example.net/covers/*"],
			allow: [],
			deny: [],
		});
		expect(registry.info(URL)?.netMode).toBe("derived");
		expect(registry.pageHosts()).toStrictEqual(["api.example.com", "*.cdn.example.net/covers/*"]);
	});

	it("keeps declared hosts over derived ones", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", {}, { hosts: ["a.com"] });
		const registry = createRegistry({ ...deps, derivedHosts: () => ["b.com"] });
		await registry.install(URL, asker(true));
		expect(registry.hostsOf(URL)?.hosts).toStrictEqual(["a.com"]);
		expect(registry.hostsOf(URL)?.mode).toBe("declared");
	});

	it("waits for the registry lists before it confirms", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		let loaded = false;
		const registry = createRegistry({
			...deps,
			derivedReady: async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				loaded = true;
			},
			derivedHosts: () => (loaded ? ["late.example.com"] : undefined),
		});
		const yes = asker(true);
		await registry.install(URL, yes);
		expect(yes.asked[0].lines.some((line) => line.includes("late.example.com"))).toBeTruthy();
	});

	it("runs a listed old-format version in compatibility mode with the list's hosts in the page, until it updates", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry({
			...deps,
			legacyHosts: (id: string, sha: string) =>
				id === pluginIdOf(URL) && sha === servedSha("v1") ? ["api.old.example", "{setting:server}"] : undefined,
		});
		await installLegacy(registry, deps, URL, "v1");
		expect(registry.hostsOf(URL)).toStrictEqual({
			name: "legacy",
			mode: "legacy",
			hosts: ["api.old.example", "{setting:server}"],
			allow: [],
			deny: [],
		});
		// Setting entries never reach the page's CSP
		expect(registry.pageHosts()).toStrictEqual(["api.old.example"]);

		serve(URL, "v2");
		await registry.load(URL);
		const yes = asker(true);
		expect(await registry.acceptUpdate(URL, yes)).toBe(true);
		expect(registry.hostsOf(URL)?.mode).toBe("unlisted");
		expect(registry.pageHosts()).toStrictEqual([]);
	});

	it("keeps the user's answers per plugin, puts 'always' in the page, forgets them and drops them on uninstall", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", {}, { hosts: ["a.com"] });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		expect(await registry.grantHost(URL, "https://b.com", "always")).toBe(true);
		expect(await registry.grantHost(URL, "https://c.com", "deny")).toBe(true);
		// Not a host entry, or not an installed plugin: refused
		expect(await registry.grantHost(URL, "*", "always")).toBe(false);
		expect(await registry.grantHost("https://other.example/x", "https://b.com", "always")).toBe(false);
		expect(registry.hostsOf(URL)).toStrictEqual({
			name: "plugin v1",
			mode: "declared",
			hosts: ["a.com"],
			allow: ["https://b.com"],
			deny: ["https://c.com"],
		});
		expect(registry.pageHosts()).toStrictEqual(["a.com", "https://b.com"]);
		expect(registry.info(URL)?.grants).toStrictEqual({ "https://b.com": "always", "https://c.com": "deny" });

		expect(await registry.forgetGrant(URL, "https://b.com", asker(false)), "an always goes without asking").toBe(true);
		expect(await registry.forgetGrant(URL, "https://b.com", asker(true))).toBe(false);
		expect(registry.hostsOf(URL)?.allow).toStrictEqual([]);
		// Forgetting a deny lets the plugin ask again: the user confirms it
		expect(await registry.forgetGrant(URL, "https://c.com", asker(false))).toBe(false);
		expect(registry.hostsOf(URL)?.deny).toStrictEqual(["https://c.com"]);
		expect(await registry.forgetGrant(URL, "https://c.com", asker(true))).toBe(true);
		expect(registry.hostsOf(URL)?.deny).toStrictEqual([]);

		await registry.uninstall(URL);
		serve(URL, "v1", {}, { hosts: ["a.com"] });
		await registry.install(URL, asker(true));
		expect(registry.hostsOf(URL)?.deny).toStrictEqual([]);
	});

	it("keeps no answer in memory that couldn't be saved", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", {}, { hosts: ["a.com"] });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		const write = deps.write;
		deps.write = () => {
			throw new Error("disk full");
		};
		expect(await registry.grantHost(URL, "https://b.com", "always")).toBe(false);
		expect(registry.hostsOf(URL)?.allow).toStrictEqual([]);
		expect(registry.info(URL)?.grants === undefined || Object.keys(registry.info(URL)!.grants!).length === 0).toBe(true);
		deps.write = write;
		await registry.grantHost(URL, "https://b.com", "always");
		deps.write = () => {
			throw new Error("disk full");
		};
		await expect(registry.forgetGrant(URL, "https://b.com", asker(false))).rejects.toThrow(/Couldn't save/);
		expect(registry.hostsOf(URL)?.allow).toStrictEqual(["https://b.com"]);
	});

	it("never writes an answer whose save failed, even when another save is queued behind it", async () => {
		const { deps, serve, writes } = fakeDeps();
		serve(URL, "v1", {}, { hosts: ["a.com"] });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		const write = deps.write;
		let calls = 0;
		deps.write = (async (next: CoreState) => {
			// The first write (the grant's) fails after a pause; the next one goes through
			if (calls++ === 0) {
				await new Promise((resolve) => setTimeout(resolve, 5));
				throw new Error("disk full");
			}
			return write(next);
		}) as unknown as typeof deps.write;
		const failed = registry.grantHost(URL, "https://b.com", "always");
		const other = registry.grantHost(URL, "https://c.com", "always");
		expect([await failed, await other]).toStrictEqual([false, true]);
		const last = writes[writes.length - 1];
		expect(Object.keys(last.netGrants?.[URL] ?? {})).toStrictEqual(["https://c.com"]);
		expect(registry.hostsOf(URL)?.allow).toStrictEqual(["https://c.com"]);
	});

	it("asks the hosts of a plugin from before the core one by one: it never saw them", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", {}, { hosts: ["a.com"] });
		const registry = createRegistry(deps);
		await registry.migrate([{ url: URL, name: "old", enabled: true }]);
		await registry.load(URL);
		expect(registry.hostsOf(URL)?.mode).toBe("unlisted");
		expect(registry.pageHosts()).toStrictEqual([]);
	});

	it("leaves out hosts of disabled plugins", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", {}, { hosts: ["a.com"] });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		await registry.grantHost(URL, "https://b.com", "always");
		await registry.disable(URL);
		expect(registry.pageHosts()).toStrictEqual([]);
	});
});

describe("core registry store origins", () => {
	const BASELINE = ["github.com", "*.githubusercontent.com"];
	it("installs and moves only from a store origin, and asks before it allows a new one", async () => {
		const { deps, serve } = fakeDeps();
		const registry = createRegistry({ ...deps, storeBaseline: BASELINE });
		const EVIL = "https://evil.example/secret/plugin";
		serve(EVIL, "v1");
		const yes = asker(true);
		await expect(registry.install(EVIL, yes)).rejects.toThrow(/isn't a plugin store you allowed/);
		expect(yes.asked.length, "refused before anything is fetched or asked").toBe(0);
		// GitHub and dev plugins need nothing
		const GH = "https://github.com/a/b/releases/download/latest/plugin";
		serve(GH, "v1");
		serve(DEV_URL, "v1");
		expect(await registry.install(GH, asker(true))).toBe(true);
		expect(await registry.install(DEV_URL, asker(true))).toBe(true);
		await expect(registry.moveUrl(GH, EVIL)).rejects.toThrow(/isn't a plugin store you allowed/);
		// The user says no, then yes
		const no = asker(false);
		expect(await registry.allowStore(`${EVIL}/store.json`, no)).toBe(false);
		expect(no.asked[0].title).toMatch(/Allow Luna to read from https:\/\/evil\.example\?/);
		expect(registry.storeOrigins().includes("https://evil.example")).toBe(false);
		expect(await registry.allowStore(EVIL, yes)).toBe(true);
		expect(registry.storeOrigins().includes("https://evil.example")).toBeTruthy();
		expect(await registry.install(EVIL, asker(true))).toBe(true);
		// Allowed once: not asked again
		const again = asker(false);
		expect(await registry.allowStore(EVIL, again)).toBe(true);
		expect(again.asked.length).toBe(0);
	});
	it("lists Luna's default stores and installed plugins' origins, and keeps allowed ones", async () => {
		const { deps, serve, writes } = fakeDeps();
		const registry = createRegistry({ ...deps, storeBaseline: BASELINE });
		expect(registry.storeOrigins().includes("https://release.radiant-lyrics.org")).toBeTruthy();
		expect(registry.storeOrigins().includes("http://127.0.0.1:3000")).toBeTruthy();
		serve(DEV_URL.replace("3000", "3005"), "v1");
		await registry.install(DEV_URL.replace("3000", "3005"), asker(true));
		expect(registry.storeOrigins().includes("http://127.0.0.1:3005")).toBeTruthy();
		// GitHub needs no answer; a dev port on this computer does (the page's connect-src doesn't list it)
		const gh = asker(false);
		expect(await registry.allowStore("https://github.com/a/b/releases/download/latest/store.json", gh)).toBe(true);
		expect(gh.asked.length).toBe(0);
		const dev = asker(true);
		expect(await registry.allowStore("http://127.0.0.1:4000/store.json", dev)).toBe(true);
		expect(dev.asked.length).toBe(1);
		await expect(registry.allowStore("file:///C:/x", dev)).rejects.toThrow(/Not a store url/);
		const reread = createRegistry({ ...fakeDeps(writes.at(-1)!).deps, storeBaseline: BASELINE });
		expect(reread.storeOrigins().includes("http://127.0.0.1:4000")).toBeTruthy();
		// A stored list that isn't one is dropped
		const bad = createRegistry({
			...fakeDeps({ version: 1, plugins: {}, storeOrigins: ["https://ok.example", "javascript:x", 1 as never] }).deps,
		});
		expect(bad.storeOrigins().includes("https://ok.example")).toBeTruthy();
		expect(bad.storeOrigins().includes("javascript:x")).toBe(false);
	});
});
