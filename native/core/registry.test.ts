import assert from "node:assert";
import { describe, it } from "node:test";

import { createHash } from "node:crypto";

import type { ConfirmRequest } from "./confirmPage";
import { pluginIdOf, servedSha256 } from "./legacyList";
import { createRegistry, type CoreState, type PluginPackage } from "./registry";

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
	};
	return { deps, serve, serveWorld, served, forgotten, writes, reads, list };
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
	assert.strictEqual(await registry.enable(url, asker(true)), true);
};

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
		assert.strictEqual(await registry.install(URL, no), false);
		assert.strictEqual(no.asked.length, 1);
		assert.strictEqual(registry.info(URL), undefined);
		assert.strictEqual(registry.isEnabled(URL), false);

		const yes = asker(true);
		assert.strictEqual(await registry.install(URL, yes), true);
		assert.match(yes.asked[0].title, /^Install /);
		assert.strictEqual(registry.isEnabled(URL), true);
		assert.strictEqual(registry.info(URL)?.hash, "v1");
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
		assert.strictEqual(await registry.enable(DEV_URL, plain), true);
		assert.strictEqual(plain.asked.length, 0);

		const no = asker(false);
		assert.strictEqual(await registry.enable(URL, no), false);
		assert.strictEqual(no.asked.length, 1);
		assert.strictEqual(registry.isEnabled(URL), false);
		assert.strictEqual(await registry.enable(URL, asker(true)), true);
		assert.strictEqual(registry.isEnabled(URL), true);
	});

	it("registers native code only for the accepted code of an enabled plugin", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);

		await installLegacy(registry, deps, URL, "v1");
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);
		// Other code under the same name, or a file the plugin doesn't have
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a, changed"), undefined);
		assert.strictEqual(registry.nativeOwner("b.native.ts", "native a"), undefined);

		await registry.disable(URL);
		assert.strictEqual(registry.isEnabled(URL), false);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
	});

	it("keeps running the accepted version until the user accepts an update", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");

		serve(URL, "v2", { "a.native.ts": "native a2", "b.native.ts": "native b" });
		const loaded = await registry.load(URL);
		assert.strictEqual(loaded.package.hash, "v1");
		assert.deepStrictEqual(loaded.pending?.added, ["b.native.ts"]);
		// The new native code isn't registered before it is accepted
		assert.strictEqual(registry.nativeOwner("b.native.ts", "native b"), undefined);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);

		const no = asker(false);
		assert.strictEqual(await registry.acceptUpdate(URL, no), false);
		assert.ok(no.asked[0].lines.some((line) => line.includes("New native files: b.native.ts")));
		assert.ok(no.asked[0].lines.some((line) => line.includes("After this update it can't any more")));
		assert.strictEqual(registry.info(URL)?.hash, "v1");

		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		assert.strictEqual(registry.info(URL)?.hash, "v2");
		assert.strictEqual(registry.info(URL)?.pending, undefined);
		// What v1 registered can't be called any more, and v2 in the old format doesn't run at all
		assert.strictEqual(registry.ownsNative(URL, "a.native.ts", "native a"), false);
		assert.strictEqual(registry.ownsNative(URL, "a.native.ts", "native a2"), false);
		assert.strictEqual(registry.nativeOwner("b.native.ts", "native b"), undefined);
		assert.match(registry.legacyRefusal("b.native.ts", "native b") ?? "", /old native format.*must move it to the new format/);
		assert.strictEqual(registry.info(URL)?.legacyNatives, "refused");
	});

	it("takes any change of the served code as an update the user is asked about, whatever the package says", async () => {
		const { deps, serve, served } = fakeDeps();
		serve(URL, "v1", {}, { version: "1.2.0" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));

		// Other code under the same hash and version: the accepted code keeps running, the new code waits
		served.get(URL)!.code = "code changed";
		let loaded = await registry.load(URL);
		assert.strictEqual(loaded.code, "code v1");
		assert.strictEqual(loaded.pending?.codeSha256, sha256("code changed"));
		const no = asker(false);
		assert.strictEqual(await registry.acceptUpdate(URL, no), false);
		assert.ok(no.asked[0].lines.includes("1.2.0 -> 1.2.0"));
		assert.ok(no.asked[0].lines.includes(`Code sha256: ${sha256("code v1").slice(0, 12)} -> ${sha256("code changed").slice(0, 12)}`));
		assert.strictEqual((await registry.load(URL)).code, "code v1");

		// A new hash at a lower version number: an update too, asked about like any other
		serve(URL, "v0", {}, { version: "1.0.0" });
		loaded = await registry.load(URL);
		assert.strictEqual(loaded.code, "code v1");
		assert.strictEqual(loaded.pending?.version, "1.0.0");
		const yes = asker(true);
		assert.strictEqual(await registry.acceptUpdate(URL, yes), true);
		assert.strictEqual(yes.asked.length, 1);
		assert.strictEqual((await registry.load(URL)).code, "code v0");

		// The url serves the accepted code again: no update
		assert.strictEqual((await registry.load(URL)).pending, undefined);
	});

	it("takes other code of a world plugin under the same hashes as an update, and replaces a waiting one", async () => {
		const { deps, serveWorld, served } = fakeDeps();
		serveWorld(URL, "w1", {});
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		served.get(URL)!.code = "code a";
		assert.strictEqual((await registry.load(URL)).pending?.codeSha256, sha256("code a"));
		served.get(URL)!.code = "code b";
		const loaded = await registry.load(URL);
		assert.strictEqual(loaded.code, "code w1");
		assert.strictEqual(loaded.pending?.codeSha256, sha256("code b"));
		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		assert.strictEqual((await registry.load(URL)).code, "code b");
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
		assert.strictEqual(await registry.moveUrl(URL, NEW), true);
		serve(NEW, "v1");
		served.get(NEW)!.code = `code v1\n//# sourceURL=${NEW}.mjs`;
		assert.strictEqual((await registry.load(NEW)).pending, undefined);
		// Other code at the new url is still an update
		served.get(NEW)!.code = `code v2\n//# sourceURL=${NEW}.mjs`;
		assert.strictEqual((await registry.load(NEW)).pending?.codeSha256, sha256(`code v2\n//# sourceURL=${NEW}.mjs`));
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
		assert.strictEqual(await registry.acceptUpdate(URL, ask), true);
		await laterLoad;
		assert.strictEqual(registry.info(URL)?.hash, "v2");
		assert.strictEqual(registry.info(URL)?.pending?.hash, "v3");
	});

	it("accepts dev updates without asking", async () => {
		const { deps, serve } = fakeDeps();
		serve(DEV_URL, "d1");
		const registry = createRegistry(deps);
		await registry.install(DEV_URL, asker(true));
		serve(DEV_URL, "d2", { "a.native.ts": "native a" });
		assert.strictEqual((await registry.load(DEV_URL)).package.hash, "d2");
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), DEV_URL);
	});

	it("runs the accepted version offline, and nothing for a disabled plugin", async () => {
		const { deps, serve, served } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		served.delete(URL);
		assert.strictEqual((await registry.load(URL)).package.hash, "v1");
		await registry.disable(URL);
		await assert.rejects(registry.load(URL), /not enabled/);
	});

	it("disables migrated native plugins until the user reviews them", async () => {
		const { deps, serve, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		list(URL, "v1");
		serve(DEV_URL, "d1");
		const registry = createRegistry(deps);
		assert.strictEqual(registry.needsMigration(), true);
		await registry.migrate([
			{ url: URL, name: "native", enabled: true },
			{ url: DEV_URL, name: "plain", enabled: true },
			{ url: "https://luna/core", name: "core", enabled: true },
		]);
		assert.strictEqual(registry.needsMigration(), false);
		assert.strictEqual(registry.info("https://luna/core"), undefined);

		await assert.rejects(registry.load(URL), /has native code/);
		assert.strictEqual(registry.isEnabled(URL), false);
		// Waiting for its first review, not an update: the page shows it disabled, with no Update button
		assert.strictEqual(registry.info(URL)?.pending, undefined);
		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), false);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
		assert.strictEqual((await registry.load(DEV_URL)).package.hash, "d1");

		const yes = asker(true);
		assert.strictEqual(await registry.enable(URL, yes), true);
		assert.strictEqual(yes.asked.length, 1);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);
	});

	it("migrates only once, and never over a stored state", async () => {
		const stored: CoreState = { version: 1, plugins: {} };
		const registry = createRegistry(fakeDeps(stored).deps);
		assert.strictEqual(registry.needsMigration(), false);
		await registry.migrate([{ url: URL, name: "x", enabled: true }]);
		assert.strictEqual(registry.info(URL), undefined);
	});

	it("doesn't migrate again once the page handed its plugins over, though the state file is gone", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		let migrated = false;
		const marked = { ...deps, wasMigrated: () => migrated, markMigrated: () => void (migrated = true) };
		await createRegistry(marked).migrate([{ url: "https://example.org/old", name: "old", enabled: true }]);
		assert.strictEqual(migrated, true);
		// The state file lost (read gives null again): no second hand-over
		const registry = createRegistry(marked);
		assert.strictEqual(registry.needsMigration(), false);
		await registry.migrate([{ url: URL, name: "legacy", enabled: true }]);
		assert.strictEqual(registry.info(URL), undefined);
	});

	it("migrates no plugin the core installed already", async () => {
		const { deps, serve, writes } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		await registry.migrate([{ url: URL, name: "legacy", enabled: false }]);
		assert.strictEqual(writes.at(-1)?.plugins[URL]?.unreviewed, undefined);
		assert.strictEqual(registry.isEnabled(URL), true);
		assert.strictEqual(registry.info(URL)?.legacyNatives, "refused");
	});

	it("matches the list by the served code, whatever url its sourceURL line names", async () => {
		const { deps, serve, served, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const entry = served.get(URL)!;
		served.set(URL, { ...entry, code: `${entry.code}\n//# sourceURL=https://old.example/plugin.mjs` });
		list(URL, "v1");
		const registry = createRegistry(deps);
		assert.strictEqual(await registry.install(URL, asker(true)), true);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);
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
		assert.strictEqual(await registry.moveUrl(URL, NEW_URL), true);
		await registry.load(NEW_URL).catch(() => {});
		assert.strictEqual(await registry.enable(NEW_URL, asker(true)), true);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), NEW_URL);

		// It updates (leaves the old format), goes back to the listed version, then moves: still off
		serve(NEW_URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(NEW_URL);
		assert.strictEqual(await registry.acceptUpdate(NEW_URL, asker(true)), true);
		serve(NEW_URL, "v1", { "a.native.ts": "native a" });
		await registry.load(NEW_URL);
		assert.strictEqual(await registry.acceptUpdate(NEW_URL, asker(true)), true);
		served.set(OTHER_URL, served.get(NEW_URL)!);
		assert.strictEqual(await registry.moveUrl(NEW_URL, OTHER_URL), true);
		assert.strictEqual(registry.info(OTHER_URL)?.hash, "v1");
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
		// The url it moved from leaves with it
		assert.deepStrictEqual(writes.at(-1)?.legacyOff, [NEW_URL, URL, OTHER_URL]);
	});

	it("reads an accepted bundle's native files once, however often they are checked", async () => {
		const { deps, serve, reads } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		const before = reads.count;
		for (let i = 0; i < 5; i++) assert.strictEqual(registry.ownsNative(URL, "a.native.ts", "native a"), true);
		assert.ok(reads.count - before <= 1);
	});

	it("forgets native answers on uninstall", async () => {
		const { deps, serve, forgotten } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		await registry.uninstall(URL);
		assert.deepStrictEqual(forgotten, [URL]);
		assert.strictEqual(registry.info(URL), undefined);
		assert.strictEqual(registry.isEnabled(URL), false);
	});

	it("shows the sha256 of the code the page runs, before and after an update", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		const v1 = createHash("sha256").update("code v1", "utf8").digest("hex");
		assert.strictEqual(registry.info(URL)?.codeSha256, v1);
		assert.strictEqual((await registry.load(URL)).package.codeSha256, v1);

		serve(URL, "v2");
		const v2 = createHash("sha256").update("code v2", "utf8").digest("hex");
		assert.strictEqual((await registry.load(URL)).pending?.codeSha256, v2);
		const ask = asker(false);
		await registry.acceptUpdate(URL, ask);
		assert.ok(ask.asked[0].lines.includes(`Code sha256: ${v1.slice(0, 12)} -> ${v2.slice(0, 12)}`));
	});

	it("does nothing for Luna's own plugins and refuses non-plugin urls", async () => {
		const registry = createRegistry(fakeDeps().deps);
		const ask = asker(true);
		assert.strictEqual(await registry.install("https://luna/core", ask), true);
		assert.strictEqual(ask.asked.length, 0);
		await assert.rejects(registry.install("file:///C:/x", ask), /Not a plugin url/);
		assert.throws(() => registry.info(42), /Not a plugin url/);
	});

	it("pins a plugin world with its code, and lists its natives apart", async () => {
		const { deps, serve, serveWorld } = fakeDeps();
		const world1 = serveWorld(URL, "v1", { "w.native.ts": "world native" });
		const registry = createRegistry(deps);
		const install = asker(true);
		await registry.install(URL, install);
		assert.deepStrictEqual(registry.info(URL)?.natives, ["world:w.native.ts"]);
		assert.strictEqual(registry.acceptedWorld(URL), world1);
		const lines = install.asked[0].lines.join(" ");
		assert.match(lines, /w\.native\.ts\. Only the plugin's own isolated world can call it/);
		assert.doesNotMatch(lines, /Legacy native plugin/);
		// Page code can't register a world's natives as its own
		assert.strictEqual(registry.nativeOwner("world:w.native.ts", "world native"), undefined);
		assert.strictEqual(registry.nativeOwner("w.native.ts", "world native"), undefined);

		// A new world alone is an update: the accepted one keeps running until the user accepts it
		const world2 = serveWorld(URL, "v1", { "w.native.ts": "world native", "x.native.ts": "another" });
		assert.deepStrictEqual((await registry.load(URL)).pending?.added, ["world:x.native.ts"]);
		assert.strictEqual(registry.acceptedWorld(URL), world1);
		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		assert.strictEqual(registry.acceptedWorld(URL), world2);

		await registry.disable(URL);
		assert.strictEqual(registry.acceptedWorld(URL), undefined);
		serve(URL, "plain");
		assert.strictEqual(registry.acceptedWorld(URL), undefined);
	});

	it("refuses a world that doesn't match the worldHash its package names", async () => {
		const { deps, serveWorld } = fakeDeps();
		serveWorld(URL, "v1", {}, "0".repeat(64));
		const registry = createRegistry(deps);
		await assert.rejects(registry.install(URL, asker(true)), /doesn't match the worldHash/);
		assert.strictEqual(registry.info(URL), undefined);
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
		assert.match(
			ask.asked[0].lines.join(" "),
			/Legacy native plugin: while it is enabled, any plugin or script in the page can call its native functions/,
		);
		assert.match(ask.asked[0].lines.join(" "), /on Luna's list of plugins from before isolated worlds\. An update takes it off/);
		assert.strictEqual(registry.info(URL)?.legacyNatives, "allowed");

		// A new plugin in the old format installs after a warning, but its natives don't run
		const NEW_URL = "https://example.org/new";
		serve(NEW_URL, "n1", { "n.native.ts": "native n" });
		const install = asker(true);
		assert.strictEqual(await registry.install(NEW_URL, install), true);
		assert.match(install.asked[0].lines.join(" "), /Old native format, without isolation: n\.native\.ts won't run/);
		assert.strictEqual(registry.info(NEW_URL)?.legacyNatives, "refused");
		assert.strictEqual(registry.nativeOwner("n.native.ts", "native n"), undefined);
		assert.match(registry.legacyRefusal("n.native.ts", "native n") ?? "", /plugin n1 uses the old native format/);

		// From this computer the old format runs (the user is its author)
		serve(DEV_URL, "d1", { "d.native.ts": "native d" });
		await registry.install(DEV_URL, asker(true));
		assert.strictEqual(registry.nativeOwner("d.native.ts", "native d"), DEV_URL);
	});

	it("says what an install or update of old-format code will do: run without isolation, or not run", async () => {
		const { deps, serve, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		list(URL, "v1");
		const registry = createRegistry(deps);
		const ask = asker(true);
		await registry.install(URL, ask);
		assert.match(ask.asked[0].lines.join(" "), /any plugin or script in the page can call its native functions/);
		assert.doesNotMatch(ask.asked[0].lines.join(" "), /won't run/);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);
		// An update to unlisted code says it won't run
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(URL);
		const update = asker(true);
		await registry.acceptUpdate(URL, update);
		assert.match(update.asked[0].lines.join(" "), /won't run/);
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
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), B);
		await registry.uninstall(B);
		// Other listed code moves onto B, then B goes back to the code that ran there first
		await registry.install(URL, asker(true));
		served.set(B, served.get(URL)!);
		assert.strictEqual(await registry.moveUrl(URL, B), true);
		await registry.uninstall(B);
		serve(B, "v1", { "a.native.ts": "native a" });
		await registry.install(B, asker(true));
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
	});

	it("takes a plugin off the old format once other code replaces its listed version, also if that never ran", async () => {
		const { deps, serve, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		list(URL, "v1");
		let readable = false;
		const registry = createRegistry({ ...deps, legacyAllows: (id, sha) => readable && deps.legacyAllows(id, sha) });
		// Installed while the list is missing: its natives never ran
		await registry.install(URL, asker(true));
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
		await registry.uninstall(URL);
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.install(URL, asker(true));
		await registry.uninstall(URL);
		readable = true;
		serve(URL, "v1", { "a.native.ts": "native a" });
		await registry.install(URL, asker(true));
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
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
		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
		// The same after an uninstall: the first code accepted here was v2
		const fresh = fakeDeps();
		fresh.list(URL, "v1");
		fresh.serve(URL, "v2");
		const again = createRegistry(fresh.deps);
		await again.install(URL, asker(true));
		await again.uninstall(URL);
		fresh.serve(URL, "v1", { "a.native.ts": "native a" });
		await again.install(URL, asker(true));
		assert.strictEqual(again.nativeOwner("a.native.ts", "native a"), undefined);
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
		assert.strictEqual(await restarted.acceptUpdate(URL, asker(true)), true);
		assert.strictEqual(restarted.nativeOwner("a.native.ts", "native a"), undefined);
	});

	it("keeps a plugin off the old format when it is reinstalled from another url of its store", async () => {
		const TAGGED = "https://example.com/v1/plugin";
		const { deps, serve, writes } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(URL);
		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		await registry.uninstall(URL);
		// A release tag still serves the listed code under the same id
		serve(TAGGED, "v1", { "a.native.ts": "native a" });
		await registry.install(TAGGED, asker(true));
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
		assert.deepStrictEqual(writes.at(-1)?.legacyOffIds, ["plugin"]);

		// Other code first at one url, then the listed code at another: the same
		const other = fakeDeps();
		other.list(URL, "v1");
		other.serve(TAGGED, "v2", { "a.native.ts": "native a2" });
		const second = createRegistry(other.deps);
		await second.install(TAGGED, asker(true));
		await second.uninstall(TAGGED);
		other.serve(URL, "v1", { "a.native.ts": "native a" });
		await second.install(URL, asker(true));
		assert.strictEqual(second.nativeOwner("a.native.ts", "native a"), undefined);
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
		assert.strictEqual(await registry.install(URL, ask), true);
		assert.match(ask.asked[0].lines.join("\n"), /any plugin or script in the page can call its native functions/);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);
	});

	it("says old-format natives depend on the list while none is loaded", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry({ ...deps, legacyLoaded: () => false });
		const ask = asker(false);
		await registry.install(URL, ask);
		const text = ask.asked[0].lines.join("\n");
		assert.match(text, /isn't loaded yet/);
		assert.match(text, /any plugin or script in the page can call its native functions/);
		assert.doesNotMatch(text, /won't run/);
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
		assert.match(again.asked[0].lines.join("\n"), /won't run/);
	});

	it("takes a plugin off the old format when an update changes only its world", async () => {
		const { deps, serve, serveWorld, served } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);
		// The same bundle, now with a world
		serveWorld(URL, "v2", { "w.native.ts": "native w" });
		Object.assign(served.get(URL)!, { code: "code v1", natives: { "a.native.ts": "native a" } });
		await registry.load(URL);
		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
	});

	it("takes the url a plugin moved from off the old format once it leaves at the new one", async () => {
		const NEW_URL = "https://example.org/plugin";
		const { deps, serve, served, writes } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);
		// The new url serves an update: it waits, then is accepted
		serve(NEW_URL, "v2", { "a.native.ts": "native a2" });
		assert.strictEqual(await registry.moveUrl(URL, NEW_URL), true);
		assert.strictEqual(await registry.acceptUpdate(NEW_URL, asker(true)), true);
		await registry.uninstall(NEW_URL);
		// The old url still serves the listed code
		assert.strictEqual(served.get(URL)?.pkg.hash, "v1");
		await registry.install(URL, asker(true));
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
		assert.deepStrictEqual(writes.at(-1)?.legacyOff, [NEW_URL, URL]);
		// Also after a restart
		const restarted = createRegistry({ ...deps, read: () => writes.at(-1)! });
		assert.strictEqual(restarted.nativeOwner("a.native.ts", "native a"), undefined);
	});

	it("runs the old format for no code off the list: a new plugin, one of the same name elsewhere, a second migrate", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const OTHER = "https://example.org/other";
		serve(OTHER, "o1", { "o.native.ts": "native o" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);

		await registry.install(OTHER, asker(true));
		// migrate runs once: a later call (page code) changes nothing
		await registry.migrate([{ url: OTHER, name: "other", enabled: true }]);
		assert.strictEqual(registry.nativeOwner("o.native.ts", "native o"), undefined);

		// Listed code under another plugin's name
		const LOOKALIKE = "https://example.org/lookalike";
		serve(LOOKALIKE, "v1", { "l.native.ts": "native l" });
		await registry.install(LOOKALIKE, asker(true));
		assert.strictEqual(registry.nativeOwner("l.native.ts", "native l"), undefined);

		// The listed version reinstalled runs again: it is still on the list
		await registry.uninstall(URL);
		await registry.install(URL, asker(true));
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);
	});

	it("takes a plugin off the old native format list for good once its code changes", async () => {
		const { deps, serve, writes } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);

		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(URL);
		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		assert.deepStrictEqual(writes.at(-1)?.legacyOff, [URL]);

		// The url serves v1 again and the user goes back to it: still off the list
		serve(URL, "v1", { "a.native.ts": "native a" });
		await registry.load(URL);
		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		assert.strictEqual(registry.info(URL)?.hash, "v1");
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
		assert.strictEqual(registry.info(URL)?.legacyNatives, "refused");

		// Neither a reinstall nor a restart brings it back
		await registry.uninstall(URL);
		await registry.install(URL, asker(true));
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
		const restarted = createRegistry({ ...deps, read: () => writes.at(-1)! });
		await restarted.load(URL);
		assert.strictEqual(restarted.nativeOwner("a.native.ts", "native a"), undefined);
	});

	it("takes a plugin off the old format once other code is installed where its old-format version ran", async () => {
		const { deps, serve, writes } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);
		await registry.uninstall(URL);
		// The store serves an update meanwhile: installed fresh, not through an update
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.install(URL, asker(true));
		assert.deepStrictEqual(writes.at(-1)?.legacyOff, [URL]);
		serve(URL, "v1", { "a.native.ts": "native a" });
		await registry.load(URL);
		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
	});

	it("takes a plugin off the old format on an update also while the list can't be read", async () => {
		const { deps, serve, list } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		let readable = false;
		const registry = createRegistry({ ...deps, legacyAllows: (id, sha) => readable && deps.legacyAllows(id, sha) });
		list(URL, "v1");
		await registry.migrate([{ url: URL, name: "legacy", enabled: true }]);
		await registry.load(URL).catch(() => {});
		assert.strictEqual(await registry.enable(URL, asker(true)), true);
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(URL);
		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		// The list arrives, and the user goes back to the listed version
		readable = true;
		serve(URL, "v1", { "a.native.ts": "native a" });
		await registry.load(URL);
		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
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
		assert.strictEqual(await registry.enable(URL, ask), true);
		assert.match(ask.asked[0].lines.join(" "), /Old native format, without isolation/);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a2"), undefined);
		assert.strictEqual(registry.info(URL)?.legacyNatives, "refused");
	});

	it("moves a plugin to a new store url, other code there waits as an update", async () => {
		const NEW_URL = "https://example.org/plugin";
		const { deps, serve, served, forgotten } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await installLegacy(registry, deps, URL, "v1");

		// The same code (fetchCode adds the url's sourceURL in Luna; the fake serves it bare)
		served.set(NEW_URL, served.get(URL)!);
		assert.strictEqual(await registry.moveUrl(URL, NEW_URL), true);
		assert.strictEqual(registry.info(URL), undefined);
		assert.strictEqual(registry.info(NEW_URL)?.enabled, true);
		assert.strictEqual(registry.info(NEW_URL)?.pending, undefined);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), NEW_URL);
		assert.deepStrictEqual(forgotten, [URL]);

		const OTHER_URL = "https://example.net/plugin";
		serve(OTHER_URL, "v2");
		assert.strictEqual(await registry.moveUrl(NEW_URL, OTHER_URL), true);
		assert.strictEqual(registry.info(OTHER_URL)?.hash, "v1");
		assert.strictEqual(registry.info(OTHER_URL)?.pending?.hash, "v2");
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
		assert.match(ask.asked[0].lines.join("\n"), /World sha256: \w{12} -> \w{12}/);
	});

	it("moves a world plugin silently only when the new url serves the same world", async () => {
		const NEW_URL = "https://example.org/plugin";
		const { deps, serveWorld } = fakeDeps();
		const world1 = serveWorld(URL, "v1", { "w.native.ts": "world native" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		// Same page code, another world
		serveWorld(NEW_URL, "v1", { "w.native.ts": "other world native" });
		assert.strictEqual(await registry.moveUrl(URL, NEW_URL), true);
		assert.strictEqual(registry.acceptedWorld(NEW_URL), world1);
		assert.ok(registry.info(NEW_URL)?.pending !== undefined);
	});

	it("drops a waiting update the url no longer serves", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serve(URL, "v2");
		assert.strictEqual((await registry.load(URL)).pending?.hash, "v2");
		serve(URL, "v1");
		assert.strictEqual((await registry.load(URL)).pending, undefined);
		assert.strictEqual(registry.info(URL)?.pending, undefined);
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
		assert.deepStrictEqual(
			results.map((result) => result.status),
			["fulfilled", "rejected"],
		);
		assert.strictEqual(registry.info(TARGET)?.hash, "v1");
		assert.strictEqual(registry.info("https://example.com/b")?.hash, "b1");
	});

	it("doesn't install over a plugin a move put at the url while the user was asked", async () => {
		const TARGET = "https://example.org/target";
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		serve(TARGET, "t1");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		const ask = async () => {
			assert.strictEqual(await registry.moveUrl(URL, TARGET), true);
			return true;
		};
		await assert.rejects(registry.install(TARGET, ask), /installed meanwhile/);
		assert.strictEqual(registry.info(TARGET)?.hash, "v1");
	});

	it("doesn't move to or from a dev url, nor over an installed plugin", async () => {
		const { deps, serve } = fakeDeps();
		serve(URL, "v1");
		serve(DEV_URL, "d1");
		serve("https://example.org/plugin", "v2");
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		await registry.install("https://example.org/plugin", asker(true));
		await assert.rejects(registry.moveUrl(URL, DEV_URL), /Can't move/);
		await assert.rejects(registry.moveUrl(URL, "https://example.org/plugin"), /already installed/);
		assert.strictEqual(await registry.moveUrl("https://example.com/none", "https://example.com/other"), false);
		assert.strictEqual(registry.info(URL)?.hash, "v1");
	});
});
