import assert from "node:assert";
import { describe, it } from "node:test";

import { createHash } from "node:crypto";

import type { ConfirmLine, ConfirmRequest } from "./confirmPage";
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

		await registry.install(URL, asker(true));
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
		await registry.install(URL, asker(true));

		serve(URL, "v2", { "a.native.ts": "native a2", "b.native.ts": "native b" });
		const loaded = await registry.load(URL);
		assert.strictEqual(loaded.package.hash, "v1");
		assert.deepStrictEqual(loaded.pending?.added, ["b.native.ts"]);
		// The new native code isn't registered before it is accepted
		assert.strictEqual(registry.nativeOwner("b.native.ts", "native b"), undefined);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), URL);

		const no = asker(false);
		assert.strictEqual(await registry.acceptUpdate(URL, no), false);
		assert.ok(no.asked[0].lines.map(lineText).includes(`Update only if you trust the author and ${URL}`));
		assert.strictEqual(no.asked[0].warning, undefined);
		assert.strictEqual(registry.info(URL)?.hash, "v1");

		assert.strictEqual(await registry.acceptUpdate(URL, asker(true)), true);
		assert.strictEqual(registry.info(URL)?.hash, "v2");
		assert.strictEqual(registry.info(URL)?.pending, undefined);
		assert.strictEqual(registry.nativeOwner("b.native.ts", "native b"), URL);
		assert.strictEqual(registry.nativeOwner("a.native.ts", "native a"), undefined);
		// What v1 registered can't be called any more
		assert.strictEqual(registry.ownsNative(URL, "a.native.ts", "native a"), false);
		assert.strictEqual(registry.ownsNative(URL, "a.native.ts", "native a2"), true);
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
		const { deps, serve } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
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

	it("reads an accepted bundle's native files once, however often they are checked", async () => {
		const { deps, serve, reads } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
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
		assert.ok(ask.asked[0].lines.map(lineText).includes(`Code sha256: ${v1.slice(0, 12)} -> ${v2.slice(0, 12)}`));
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
		assert.deepStrictEqual(versions, [
			{ text: "v1", href: `https://github.com/owner/repo/commit/${A}` },
			" -> ",
			{ text: "v2", href: `https://github.com/owner/repo/commit/${B}` },
			" (",
			{ text: "release latest", href: "https://github.com/owner/repo/releases/tag/latest" },
			")",
		]);
		assert.deepStrictEqual((hashes as Exclude<ConfirmLine, string>).slice(1), [
			" (",
			{ text: "changes", href: `https://github.com/owner/repo/compare/${A}...${B}` },
			")",
		]);
		assert.deepStrictEqual(trust, ["Update only if you trust the author and ", { text: RELEASE, href: RELEASE }]);
	});

	it("warns when the plugin's native files are allowed for all versions, and asks again only if the user updates", async () => {
		const { deps, serve, allVersions } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));
		serve(URL, "v2", { "a.native.ts": "native a2" });
		await registry.load(URL);
		allVersions.set(URL, ["a.native.ts"]);

		const no = asker(false);
		await registry.acceptUpdate(URL, no);
		const warning = no.asked[0].warning;
		assert.ok(warning?.text.includes("a.native.ts"));
		assert.strictEqual(warning?.action, "Ask again");
		// The window runs it only when the user chose it and then confirmed (confirmWindow.ts)
		assert.deepStrictEqual(allVersions.get(URL), ["a.native.ts"]);
		await warning!.run();
		assert.strictEqual(allVersions.get(URL), undefined);
	});

	it("does nothing for Luna's own plugins and refuses non-plugin urls", async () => {
		const registry = createRegistry(fakeDeps().deps);
		const ask = asker(true);
		assert.strictEqual(await registry.install("https://luna/core", ask), true);
		assert.strictEqual(ask.asked.length, 0);
		await assert.rejects(registry.install("file:///C:/x", ask), /Not a plugin url/);
		assert.throws(() => registry.info(42), /Not a plugin url/);
	});

	it("moves a plugin to a new store url, other code there waits as an update", async () => {
		const NEW_URL = "https://example.org/plugin";
		const { deps, serve, served, forgotten } = fakeDeps();
		serve(URL, "v1", { "a.native.ts": "native a" });
		const registry = createRegistry(deps);
		await registry.install(URL, asker(true));

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
