// Luna's plugin registry: which plugins are installed and enabled, and which version of their code the user accepted.
// It runs in the main process (registryMain.ts), so the checks that use it hold whoever sends the IPC: native files
// register only for the accepted code of an enabled plugin (NativeModule/index.ts), and their channels work only while it
// is enabled, and a plugin world (worlds.ts) loads only the accepted `.world.json` of an enabled plugin. Installing,
// enabling native code and accepting an update happen here, after the user confirms in Luna's confirmation window
// (confirmWindow.ts).
//
// Kept apart from Electron (its IO comes in as RegistryDeps) so it can be tested.
import { createHash } from "crypto";

import type { ConfirmLine, ConfirmLink, ConfirmRequest, ConfirmWarning } from "./confirmPage";
import { parseBundle, worldFilePrefix } from "../worldBundle";
import { isCoreUrl, isDevUrl, nativesDiff } from "./policy";
import { pluginIdOf, servedSha256 } from "./legacyList";
import { updateLinks } from "./updateLinks";

// #region Types
export type PluginPackage = {
	name: string;
	hash: string;
	version?: string;
	code?: string;
	/** Entry of the plugin's isolated world, built to `<plugin>.world.json` (see build/plugins/lunaWorldPlugin.ts) */
	lunaWorld?: string;
	/** sha256 (hex) of `<plugin>.world.json` */
	worldHash?: string;
	[key: string]: unknown;
};
/** A version of a plugin's code: the one the user accepted, or an update waiting for them */
export type Version = {
	package: PluginPackage;
	code: string;
	/**
	 * sha256 (hex) of `code` as UTF-8: the served `<url>.mjs` followed by `\n//# sourceURL=<url>.mjs`, exactly what the page
	 * runs. After a move with the same code (moveUrl) the line keeps naming the url it was accepted from
	 */
	codeSha256: string;
	/** Native files: the ones the page code registers, then the world's, named `world:<file>` */
	natives: string[];
	/** The plugin's `<plugin>.world.json` as served, if it has a world. Its sha256 is `package.worldHash` */
	world?: string;
};
export type CoreRecord = {
	url: string;
	name: string;
	enabled: boolean;
	accepted?: Version;
	pending?: Version;
	/** Migrated from the page's storage: its first version is accepted without asking only if it has no native code */
	unreviewed?: true;
};
export type CoreState = {
	version: 1;
	plugins: Record<string, CoreRecord>;
	/**
	 * Urls whose plugin had old-format natives here and then accepted other code (an update): it stays off the old
	 * format on this computer, also if it goes back to the listed version later.
	 */
	legacyOff?: string[];
	/**
	 * Url -> the sha256 of the first code accepted (or run) here, natives or not (and of its world, if it has one). Accepting other code at that url takes
	 * it off the old format for good, whatever the list says at that moment and also after an uninstall.
	 */
	legacyRan?: Record<string, string>;
	/** Url -> the urls a plugin moved between with it (both ways): leaving the old format at one leaves it at all */
	legacyLinks?: Record<string, string[]>;
	/**
	 * The same by plugin id (the last part of the url, what the list matches): ids that left the old format, and id ->
	 * its first accepted code. A plugin reinstalled from another url of its store (a release tag) doesn't come back.
	 */
	legacyOffIds?: string[];
	legacyFirst?: Record<string, string>;
};
export type PendingUpdate = {
	version?: string;
	hash: string;
	worldHash?: string;
	codeSha256: string;
	natives: string[];
	added: string[];
	removed: string[];
};
export type CorePluginInfo = {
	url: string;
	name: string;
	installed: boolean;
	enabled: boolean;
	version?: string;
	hash?: string;
	codeSha256?: string;
	natives: string[];
	/** The accepted code has natives in the old format: "allowed" if they run (installed before Luna core, not updated since) */
	legacyNatives?: "allowed" | "refused";
	pending?: PendingUpdate;
};
/** Asks the user who made the request: true only if they confirmed. Throws if they could not be asked */
export type Ask = (request: ConfirmRequest) => Promise<boolean>;

export type RegistryDeps = {
	/** The stored state, or null if none was stored yet */
	read(): CoreState | null;
	/**
	 * The old native format list (legacyList.ts, signed by luna-registry) has this plugin's code: its file name in its
	 * store and the sha256 of the served code. Without it no plugin runs the old format (dev urls aside)
	 */
	legacyAllows?(id: string, servedSha256: string): boolean;
	/** Resolves once the list is loaded, or no longer waited for (legacyList.ts ready): what the confirmations say needs it */
	legacyReady?(): Promise<void>;
	/** Whether a list that grants is loaded (not expired, not older than the build): without it the confirmations can't say what runs */
	legacyLoaded?(): boolean;
	/** The page handed over its plugins once already (kept apart from the state: a lost state file doesn't allow another) */
	wasMigrated?(): boolean;
	markMigrated?(): void | Promise<void>;
	write(state: CoreState): void | Promise<void>;
	fetchPackage(url: string): Promise<PluginPackage>;
	fetchCode(url: string): Promise<string>;
	/** The text of `${url}.world.json` */
	fetchWorld(url: string): Promise<string>;
	/** fileName -> code of the native files a bundle registers */
	nativeSources(code: string): Record<string, string>;
	/** Forgets the native permission answers given for a plugin (a reinstall asks again) */
	forgetAnswers(url: string): void;
	/** The plugin's native files allowed for all versions (an update's code for them runs without asking) */
	allVersionsAnswers(url: string): string[];
	/** Revokes those answers, so the files ask again */
	revokeAllVersions(url: string): void;
	log?: (message: string) => void;
};
// #endregion

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** First 12 hex digits, enough to tell versions apart and compare with a published hash */
const shortHash = (hash: string) => hash.slice(0, 12);

const isWorldNative = (fileName: string) => fileName.startsWith(worldFilePrefix);
const isNative = (version: Version) => version.natives.length !== 0;
/**
 * Any change is a new version: a new hash of the page code or the world in the package, or other served code under the
 * same hash (whatever the version number says). The code is compared without the sourceURL line fetchCode adds, which
 * names the url (an accepted version moved offline keeps its old url's line). The world needs no own check: a world
 * is only taken when it matches its worldHash
 */
const sameVersion = (version: Version | undefined, pkg: PluginPackage, served: string) =>
	version !== undefined &&
	version.package.hash === pkg.hash &&
	version.package.worldHash === pkg.worldHash &&
	servedSha256(version.code) === served;

const legacyNativesOf = (version: Version) => version.natives.filter((fileName) => !isWorldNative(fileName));
export const legacyFormatMessage = (name: string) =>
	`${name} uses the old native format, without isolation: its native code doesn't run. The author must move it to the new format (lunaWorld).`;

/** What a version's old-format native code means: whether it runs and who can call it (`legacyRuns`) */
export const legacyLines = (url: string, version: Version, legacyRuns: boolean | "unknown"): string[] => {
	const lines: string[] = [];
	const legacy = legacyNativesOf(version);
	if (legacy.length !== 0 && legacyRuns === "unknown")
		lines.push(
			`Native code (runs in TIDAL's main process): ${legacy.join(", ")}. TIDAL asks for each native file.`,
			"Old native format, without isolation: Luna's list of plugins from before isolated worlds isn't loaded yet. Once it is, this code runs only if this exact version is on it, and then any plugin or script in the page can call its native functions.",
		);
	else if (legacy.length !== 0 && legacyRuns)
		lines.push(
			`Native code (runs in TIDAL's main process): ${legacy.join(", ")}. TIDAL asks for each native file.`,
			"Legacy native plugin: while it is enabled, any plugin or script in the page can call its native functions.",
			isDevUrl(url)
				? "Old native format: it runs because the plugin comes from this computer."
				: "Old native format: it runs because this exact version is on Luna's list of plugins from before isolated worlds. An update takes it off.",
		);
	else if (legacy.length !== 0)
		lines.push(
			`Old native format, without isolation: ${legacy.join(", ")} won't run. The author must move the plugin to the new format (lunaWorld).`,
		);
	return lines;
};

/**
 * What the confirmation says about a version. `legacyRuns`: its old-format natives would run (see CoreRecord legacyOff);
 * "unknown": they would if this version is on the list, which isn't loaded yet
 */
export const describe = (url: string, version: Version, legacyRuns: boolean | "unknown" = false): string[] => {
	const lines = [`${version.package.name} ${version.package.version ?? ""} from ${url}${isDevUrl(url) ? " (this computer)" : ""}`];
	const world = version.natives.filter(isWorldNative).map((fileName) => fileName.slice(worldFilePrefix.length));
	if (world.length !== 0)
		lines.push(
			`Native code (runs in TIDAL's main process): ${world.join(", ")}. Only the plugin's own isolated world can call it, other plugins can't reach it. TIDAL asks for each native file.`,
		);
	lines.push(...legacyLines(url, version, legacyRuns));
	if (!isNative(version)) lines.push("No native code: it runs in the page like other plugins.");
	lines.push("Plugin code can read and change everything in TIDAL: only allow plugins you trust.");
	return lines;
};

/**
 * An http(s) url with no control characters or line breaks: the url goes into the code's `//# sourceURL=` line, where a
 * line break (also U+2028/U+2029, which end a line in JavaScript) would turn the rest of the url into code that runs
 */
const isPluginUrl = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//.test(url) && !/[\p{Cc}\u2028\u2029]/u.test(url);

const link = (text: string, href: string | undefined): string | ConfirmLink => (href === undefined ? text : { text, href });

/**
 * What the update confirmation says: the versions and code hashes, linked to their source and what changed where the
 * packages say (updateLinks), `notes` (the world's hash, the old native format), whom to trust, and a warning with "Ask
 * again" if the plugin's native files that would run (`runs`: old-format ones that won't are left out) were allowed for
 * all versions
 */
export const updateQuestion = (
	url: string,
	name: string,
	accepted: Version,
	pending: Version,
	deps: Pick<RegistryDeps, "allVersionsAnswers" | "revokeAllVersions">,
	notes: string[] = [],
	runs: string[] = pending.natives,
): ConfirmRequest => {
	const links = updateLinks(url, accepted.package, pending.package);
	const versions: ConfirmLine = [link(accepted.package.version ?? "?", links.from), " -> ", link(pending.package.version ?? "?", links.to)];
	if (links.release !== undefined) versions.push(" (", { text: `release ${links.release.tag}`, href: links.release.page }, ")");
	const hashes: ConfirmLine = [`Code sha256: ${shortHash(accepted.codeSha256)} -> ${shortHash(pending.codeSha256)}`];
	if (links.compare !== undefined) hashes.push(" (", { text: "changes", href: links.compare }, ")");
	// The url names the plugin's files (`.json`, `.mjs`), nothing at the url itself: the link opens its package
	const lines: ConfirmLine[] = [versions, hashes, ...notes, ["Update only if you trust the author and ", link(url, `${url}.json`)]];
	// When the window shows (it may wait behind other prompts), of the update's native files
	const warning = (): ConfirmWarning | undefined => {
		const files = deps
			.allVersionsAnswers(url)
			.filter((fileName) => runs.includes(fileName))
			// As describe() names them
			.map((fileName) => (isWorldNative(fileName) ? fileName.slice(worldFilePrefix.length) : fileName));
		if (files.length === 0) return undefined;
		return {
			text: `Native code allowed for all versions (${files.join(", ")}): the update's runs without asking.`,
			action: "Ask again",
			done: `If you update, ${files.join(", ")} will ask for permission again.`,
			run: () => deps.revokeAllVersions(url),
		};
	};
	return { title: `Update ${name}?`, lines, confirmText: "Update", warning };
};

export const pluginUrl = (url: unknown): string => {
	if (!isPluginUrl(url)) throw new Error(`[Luna.core] Not a plugin url: ${String(url).slice(0, 200)}`);
	return url;
};

export const createRegistry = (deps: RegistryDeps) => {
	const stored = deps.read();
	const state: CoreState =
		stored?.version === 1 && typeof stored.plugins === "object" && stored.plugins !== null ? stored : { version: 1, plugins: {} };
	/** No state was stored yet and the page never handed over its plugins: it may, once (see migrate) */
	let fresh = state !== stored && deps.wasMigrated?.() !== true;
	const legacyOff = new Set(Array.isArray(state.legacyOff) ? state.legacyOff : []);
	const legacyRan: Record<string, string> =
		state.legacyRan !== null && typeof state.legacyRan === "object" ? state.legacyRan : (state.legacyRan = {});
	const legacyLinks: Record<string, string[]> =
		state.legacyLinks !== null && typeof state.legacyLinks === "object" ? state.legacyLinks : (state.legacyLinks = {});
	const legacyOffIds = new Set(Array.isArray(state.legacyOffIds) ? state.legacyOffIds : []);
	const legacyFirst: Record<string, string> =
		state.legacyFirst !== null && typeof state.legacyFirst === "object" ? state.legacyFirst : (state.legacyFirst = {});
	// Plugins from before this format kept their list in `legacy`: the registry's signed list replaces it
	delete (state as { legacy?: unknown }).legacy;
	let saving: Promise<unknown> = Promise.resolve();
	const save = () => (saving = saving.then(() => deps.write(state)).catch((err) => deps.log?.(`[Luna.core] Failed to save: ${err}`)));

	// One operation per plugin url at a time
	const queues = new Map<string, Promise<unknown>>();
	const serial = <T>(url: string, task: () => Promise<T>): Promise<T> => {
		const run = (queues.get(url) ?? Promise.resolve()).then(task);
		const settled = run.then(
			() => {},
			() => {},
		);
		queues.set(url, settled);
		// The last operation on a url removes its queue: plugins installed and removed over a session don't stay in it
		void settled.then(() => queues.get(url) === settled && queues.delete(url));
		return run;
	};

	const fetchVersion = async (url: string, pkg?: PluginPackage, code?: string): Promise<Version> => {
		pkg ??= await deps.fetchPackage(url);
		code ??= await deps.fetchCode(url);
		const natives = Object.keys(deps.nativeSources(code));
		if (typeof pkg.lunaWorld !== "string") return { package: pkg, code, codeSha256: sha256(code), natives };
		// The world is pinned with the code: worlds.ts runs exactly this text, whatever the url serves later
		const world = await deps.fetchWorld(url);
		if (pkg.worldHash !== sha256(world)) throw new Error(`[Luna.core] ${url}.world.json doesn't match the worldHash of ${url}.json`);
		const worldNatives = Object.keys(parseBundle(world).natives).map((fileName) => worldFilePrefix + fileName);
		return { package: pkg, code, codeSha256: sha256(code), natives: [...natives, ...worldNatives], world };
	};

	// #region Old native format: only code on the registry's signed list (legacyList.ts), which only shrinks
	// Checked on every native call: hash each accepted bundle once
	const served = new WeakMap<Version, string>();
	const servedOf = (version: Version) => {
		let found = served.get(version);
		if (found === undefined) served.set(version, (found = servedSha256(version.code)));
		return found;
	};
	/** All the code a version brings: the bundle and its world (an update may change only the world) */
	const codeOf = (version: Version) => (version.world === undefined ? servedOf(version) : `${servedOf(version)} ${sha256(version.world)}`);
	/** Old-format natives of this version run: a dev url, or its exact code is on the list (and the plugin didn't leave it here) */
	const legacyRuns = (url: string, version: Version | undefined) =>
		isDevUrl(url) || (version !== undefined && stillLegacy(url, version) && deps.legacyAllows?.(pluginIdOf(url), servedOf(version)) === true);
	/** Not off the old format here: what the list decides, if this version is on it */
	const stillLegacy = (url: string, version: Version) =>
		!legacyOff.has(url) &&
		!legacyOffIds.has(pluginIdOf(url)) &&
		(legacyRan[url] === undefined || legacyRan[url] === codeOf(version)) &&
		(legacyFirst[pluginIdOf(url)] === undefined || legacyFirst[pluginIdOf(url)] === codeOf(version));
	/** Old-format natives of this url's accepted version ran: remembered, so other code accepted later leaves the format */
	const ranLegacy = (url: string, version: Version) => {
		if (isDevUrl(url) || (legacyRan[url] !== undefined && legacyFirst[pluginIdOf(url)] !== undefined)) return;
		noteLegacy(url, version);
		void save();
	};
	/** Off the old format for good: this url and every url the plugin moved between with it */
	const leaveLegacy = (url: string, quiet = false) => {
		const todo = [url];
		for (let next; (next = todo.pop()) !== undefined;) {
			if (isDevUrl(next) || legacyOff.has(next)) continue;
			legacyOff.add(next);
			legacyOffIds.add(pluginIdOf(next));
			if (!quiet) deps.log?.(`[Luna.core] ${next} left the old native format: it accepted other code than its first version`);
			todo.push(...(legacyLinks[next] ?? []));
		}
		state.legacyOff = [...legacyOff];
		state.legacyOffIds = [...legacyOffIds];
	};
	/** Code a url accepts (an update, an install, a move): code other than the first accepted here leaves the old format */
	const leaves = (url: string, before: Version | undefined, version: Version) => {
		if (isDevUrl(url)) return false;
		const ran = legacyRan[url];
		const first = legacyFirst[pluginIdOf(url)];
		const sha = codeOf(version);
		// Not asking the list: it may be missing or older at this moment. Code without old-format natives counts too: going
		// back from it to listed code is still other code
		return (ran !== undefined && ran !== sha) || (first !== undefined && first !== sha) || (before !== undefined && codeOf(before) !== sha);
	};
	const leavesLegacy = (url: string, before: Version | undefined, version: Version) => {
		if (!leaves(url, before, version)) return;
		// Only worth a log line when old-format natives are involved
		const quiet = legacyNativesOf(version).length === 0 && (before === undefined || legacyNativesOf(before).length === 0);
		leaveLegacy(url, quiet);
	};
	/** Whether this version's old-format natives would run once accepted (what the confirmation says) */
	const legacyWouldRun = (url: string, before: Version | undefined, version: Version): boolean | "unknown" => {
		if (legacyRuns(url, version)) return !leaves(url, before, version);
		return deps.legacyLoaded?.() === false && stillLegacy(url, version) && !leaves(url, before, version) ? "unknown" : false;
	};
	/**
	 * A url's first accepted code is remembered, natives or not, whether or not they ran (the list may have been missing
	 * then): other code accepted there later leaves the format, also after an uninstall
	 */
	const noteLegacy = (url: string, version: Version) => {
		if (isDevUrl(url)) return;
		legacyRan[url] ??= codeOf(version);
		legacyFirst[pluginIdOf(url)] ??= codeOf(version);
	};
	// Records accepted before first versions were remembered for all code
	for (const record of Object.values(state.plugins)) if (record?.accepted !== undefined) noteLegacy(record.url, record.accepted);
	/** `from` and `to` are one plugin's urls: leaving at either leaves at both, now or later */
	const linkLegacy = (from: string, to: string) => {
		if (isDevUrl(from) || isDevUrl(to)) return;
		for (const [a, b] of [
			[from, to],
			[to, from],
		])
			if (!(legacyLinks[a] ??= []).includes(b)) legacyLinks[a].push(b);
		if (legacyOff.has(from)) leaveLegacy(to);
		if (legacyOff.has(to)) leaveLegacy(from);
	};
	/** The only way a version becomes accepted: leaving listed old-format code for unlisted code is for good */
	const accept = (record: CoreRecord, version: Version) => {
		leavesLegacy(record.url, record.accepted, version);
		noteLegacy(record.url, version);
		record.accepted = version;
	};
	// #endregion

	const info = (url: string): CorePluginInfo | undefined => {
		const record = state.plugins[url];
		if (record === undefined) return undefined;
		const { accepted, pending } = record;
		return {
			url,
			name: record.name,
			installed: true,
			enabled: record.enabled,
			version: accepted?.package.version,
			hash: accepted?.package.hash,
			codeSha256: accepted?.codeSha256,
			natives: accepted?.natives ?? [],
			legacyNatives:
				accepted === undefined || legacyNativesOf(accepted).length === 0 ? undefined : legacyRuns(url, accepted) ? "allowed" : "refused",
			// A version waiting for its first review (a migrated native plugin) is enabled, not updated: see enable
			pending:
				pending === undefined || accepted === undefined
					? undefined
					: {
							version: pending.package.version,
							hash: pending.package.hash,
							worldHash: pending.package.worldHash,
							codeSha256: pending.codeSha256,
							natives: pending.natives,
							...nativesDiff(accepted?.natives ?? [], pending.natives),
						},
		};
	};

	/** The code the page may run for `url`: the accepted version of an enabled plugin. New versions wait for acceptUpdate */
	const load = async (url: string) => {
		const record = state.plugins[url];
		if (record === undefined || !record.enabled) throw new Error(`[Luna.core] ${url} is not enabled`);
		try {
			const pkg = await deps.fetchPackage(url);
			// The code too, not only the package: code changed under the same hash is an update the user sees
			const code = await deps.fetchCode(url);
			const served = servedSha256(code);
			if (!sameVersion(record.accepted, pkg, served)) {
				const version = sameVersion(record.pending, pkg, served) ? record.pending! : await fetchVersion(url, pkg, code);
				if (record.accepted === undefined && record.unreviewed && isNative(version)) {
					// Migrated native plugin: it runs only once the user enables it
					record.enabled = false;
					record.pending = version;
					await save();
					throw new Error(`[Luna.core] ${record.name} has native code: enable it again in Luna Settings to review it`);
				}
				if (record.accepted === undefined || isDevUrl(url)) {
					accept(record, version);
					record.pending = undefined;
				} else if (record.pending !== version) {
					record.pending = version;
					deps.log?.(`[Luna.core] Update for ${record.name} waits for the user: ${record.accepted.package.version} -> ${pkg.version}`);
				}
				delete record.unreviewed;
				await save();
			} else if (record.pending !== undefined) {
				// The url serves the accepted version again (a release pulled): the update it no longer serves isn't offered
				record.pending = undefined;
				await save();
			}
		} catch (err) {
			// Offline: the accepted version runs
			if (record.accepted === undefined || !record.enabled) throw err;
			deps.log?.(`[Luna.core] ${url}: ${(err as Error)?.message ?? err}`);
		}
		const { accepted } = record;
		if (accepted === undefined) throw new Error(`[Luna.core] No code for ${url}`);
		return { package: { ...accepted.package, codeSha256: accepted.codeSha256 }, code: accepted.code, pending: info(url)?.pending };
	};

	const enable = async (url: string, ask: Ask): Promise<boolean> => {
		await deps.legacyReady?.();
		const record = state.plugins[url];
		if (record === undefined) return false;
		if (record.enabled) return true;
		if (record.accepted === undefined && record.pending === undefined) record.pending = await fetchVersion(url);
		const version = (record.accepted ?? record.pending)!;
		// Enabling plain page code gives the page nothing it doesn't have: only native plugins (and first reviews) ask
		if (isNative(version) || record.accepted === undefined) {
			const lines = describe(url, version, legacyWouldRun(url, record.accepted, version));
			if (!(await ask({ title: `Enable ${record.name}?`, lines, confirmText: "Enable" }))) return false;
		}
		if (record.accepted === undefined) {
			accept(record, version);
			if (record.pending === version) record.pending = undefined;
		}
		record.enabled = true;
		delete record.unreviewed;
		await save();
		return true;
	};

	const install = async (url: string, ask: Ask): Promise<boolean> => {
		// Installing an installed plugin enables it
		if (state.plugins[url] !== undefined) return enable(url, ask);
		await deps.legacyReady?.();
		const version = await fetchVersion(url);
		const lines = describe(url, version, legacyWouldRun(url, undefined, version));
		if (!(await ask({ title: `Install ${version.package.name}?`, lines, confirmText: "Install" }))) return false;
		// Queued by url, but a moveUrl to this url (queued by its source) may have landed while the user was asked
		if (state.plugins[url] !== undefined) throw new Error(`[Luna.core] ${url} was installed meanwhile: try again`);
		leavesLegacy(url, undefined, version);
		noteLegacy(url, version);
		state.plugins[url] = { url, name: version.package.name, enabled: true, accepted: version };
		await save();
		return true;
	};

	const acceptUpdate = async (url: string, ask: Ask): Promise<boolean> => {
		await deps.legacyReady?.();
		const record = state.plugins[url];
		const { accepted, pending } = record ?? {};
		if (record === undefined || accepted === undefined || pending === undefined) return false;
		const notes: string[] = [];
		// The world drives the plugin's natives: a change to it alone is shown too
		if (accepted.package.worldHash !== pending.package.worldHash)
			notes.push(`World sha256: ${shortHash(accepted.package.worldHash ?? "none")} -> ${shortHash(pending.package.worldHash ?? "none")}`);
		const legacyRunsAfter = legacyWouldRun(url, accepted, pending);
		notes.push(...legacyLines(url, pending, legacyRunsAfter));
		if (!isDevUrl(url) && legacyRuns(url, accepted) && legacyNativesOf(accepted).length !== 0)
			notes.push("This plugin uses the old native format. After this update it can't any more, even if you go back to this version.");
		// Operations on this url wait for the answer (serial): a newer update a load finds meanwhile waits for its own window
		// Old-format files that won't run aren't named in the warning (legacyLines says they won't)
		const runs = legacyRunsAfter === false ? pending.natives.filter(isWorldNative) : pending.natives;
		if (!(await ask(updateQuestion(url, record.name, accepted, pending, deps, notes, runs)))) return false;
		accept(record, pending);
		record.pending = undefined;
		await save();
		return true;
	};

	const disable = async (url: string) => {
		const record = state.plugins[url];
		if (record === undefined || !record.enabled) return;
		record.enabled = false;
		await save();
	};

	const uninstall = async (url: string) => {
		if (state.plugins[url] === undefined) return;
		// legacyOff and legacyRan stay: a reinstall doesn't bring the old format back to a plugin that left it
		delete state.plugins[url];
		await save();
		// A reinstall asks for native permissions again
		deps.forgetAnswers(url);
	};

	/**
	 * A store moved (LunaPlugin.migrateBaseUrl): the plugin's record goes to its new url. Its accepted code keeps
	 * running; if the new url serves other code, that code waits as an update the user reviews like any other. Not to or
	 * from a dev url, whose new code is accepted without asking (see load).
	 */
	const moveUrl = async (from: string, to: string) => {
		const record = state.plugins[from];
		if (record === undefined || from === to) return false;
		if (isDevUrl(from) || isDevUrl(to) || isCoreUrl(to)) throw new Error(`[Luna.core] Can't move ${from} to ${to}`);
		if (state.plugins[to] !== undefined) throw new Error(`[Luna.core] ${to} is already installed`);
		let found: Version | undefined;
		try {
			found = await fetchVersion(to);
		} catch (err) {
			// Offline: the accepted code moves, the new url is checked on the next load
			deps.log?.(`[Luna.core] ${to}: ${(err as Error)?.message ?? err}`);
		}
		// Queued by `from` only: an install or another move to `to` may have finished while fetching
		if (state.plugins[to] !== undefined) throw new Error(`[Luna.core] ${to} is already installed`);
		if (state.plugins[from] !== record) return false;
		const { accepted } = record;
		const moved: CoreRecord = { ...record, url: to, pending: undefined };
		// The same code and the same world (pinned with it): nothing new to review. The accepted text keeps running as it
		// is, with its sourceURL line naming the old url: the new url's line could close something the code leaves open
		// (a trailing `/*`, a template literal) and run the rest of the url
		const same =
			found !== undefined && accepted !== undefined && servedSha256(found.code) === servedSha256(accepted.code) && found.world === accepted.world;
		if (!same && found !== undefined && accepted !== undefined) moved.pending = found;
		// One plugin at both urls: one that left the old format at either stays off it at both, and other code at `to`
		// (now or later) leaves it at both
		linkLegacy(from, to);
		// Code other than what ran the old format at `to` before replaces it there
		if (moved.accepted !== undefined) leavesLegacy(to, undefined, moved.accepted);
		if (legacyRan[from] !== undefined && legacyRan[to] !== undefined && legacyRan[from] !== legacyRan[to]) leaveLegacy(to);
		if (legacyRan[from] !== undefined && legacyRan[to] === undefined) legacyRan[to] = legacyRan[from];
		delete state.plugins[from];
		state.plugins[to] = moved;
		await save();
		// Native permissions were given to the old url
		deps.forgetAnswers(from);
		return true;
	};

	/** Once, on the first start with a registry: what the page had stored. Native plugins wait for the user (see load) */
	const migrate = async (entries: unknown) => {
		if (!fresh || !Array.isArray(entries)) return;
		fresh = false;
		for (const entry of entries) {
			const { url, name, enabled } = entry ?? {};
			if (!isPluginUrl(url) || isCoreUrl(url) || typeof name !== "string") continue;
			// Installed through the core already: not a plugin from before it
			if (state.plugins[url] !== undefined) continue;
			state.plugins[url] = { url, name, enabled: enabled === true, unreviewed: true };
		}
		await save();
		await deps.markMigrated?.();
	};

	const holdsNative = (record: CoreRecord | undefined, fileName: string, code: string): record is CoreRecord & { accepted: Version } =>
		record?.enabled === true &&
		record.accepted !== undefined &&
		record.accepted.natives.includes(fileName) &&
		sourcesOf(record.accepted)[fileName] === code;
	// The page registers only old-format natives (worlds load theirs in worlds.ts)
	const ownsNative = (record: CoreRecord | undefined, fileName: string, code: string) => {
		if (!holdsNative(record, fileName, code) || !legacyRuns(record.url, record.accepted)) return false;
		ranLegacy(record.url, record.accepted);
		return true;
	};
	// Checked on every native call: read each accepted bundle once
	const sources = new WeakMap<Version, Record<string, string>>();
	const sourcesOf = (version: Version) => {
		let found = sources.get(version);
		if (found === undefined) sources.set(version, (found = deps.nativeSources(version.code)));
		return found;
	};

	/** Core urls are Luna's own plugins, served from its bundle: nothing to install or accept */
	const forPlugin =
		<T>(core: T, task: (url: string) => Promise<T>) =>
		async (url: unknown): Promise<T> => {
			const checked = pluginUrl(url);
			return isCoreUrl(checked) ? Promise.resolve(core) : serial(checked, () => task(checked));
		};

	return {
		list: (): CorePluginInfo[] => Object.keys(state.plugins).map((url) => info(url)!),
		info: (url: unknown) => (typeof url === "string" && Object.hasOwn(state.plugins, url) ? info(url) : info(pluginUrl(url))),
		needsMigration: () => fresh,
		migrate,
		load: async (url: unknown) => {
			const checked = pluginUrl(url);
			return serial(checked, () => load(checked));
		},
		install: (url: unknown, ask: Ask) => forPlugin(true, (checked) => install(checked, ask))(url),
		enable: (url: unknown, ask: Ask) => forPlugin(true, (checked) => enable(checked, ask))(url),
		acceptUpdate: (url: unknown, ask: Ask) => forPlugin(false, (checked) => acceptUpdate(checked, ask))(url),
		moveUrl: async (from: unknown, to: unknown): Promise<boolean> => {
			const target = pluginUrl(to);
			return forPlugin(false, (source) => moveUrl(source, target))(from);
		},
		// Also a plugin stored under a url refused now (installed before urls were checked): it can still be taken off
		disable: (url: unknown) =>
			typeof url === "string" && Object.hasOwn(state.plugins, url) ? serial(url, () => disable(url)) : forPlugin(undefined, disable)(url),
		uninstall: (url: unknown) =>
			typeof url === "string" && Object.hasOwn(state.plugins, url) ? serial(url, () => uninstall(url)) : forPlugin(undefined, uninstall)(url),

		// #region Checks (see the top of this file)
		isEnabled: (url: string) => state.plugins[url]?.enabled === true,
		/** The plugin is enabled and its accepted code registers this native file with this code (an update may drop or change it) */
		ownsNative: (url: string, fileName: string, code: string) => ownsNative(state.plugins[url], fileName, code),
		/** The enabled plugin whose accepted code registers this native file with this code */
		nativeOwner: (fileName: string, code: string): string | undefined =>
			Object.values(state.plugins).find((record) => ownsNative(record, fileName, code))?.url,
		/** The enabled plugin holding this native file whose old format doesn't run any more: why it is refused */
		legacyRefusal: (fileName: string, code: string): string | undefined => {
			const record = Object.values(state.plugins).find((record) => holdsNative(record, fileName, code));
			return record === undefined ? undefined : legacyFormatMessage(record.name);
		},
		/** The `.world.json` text the user accepted for an enabled plugin with a world */
		acceptedWorld: (url: string): string | undefined => {
			const record = state.plugins[url];
			return record?.enabled === true ? record.accepted?.world : undefined;
		},
		// #endregion
	};
};
export type Registry = ReturnType<typeof createRegistry>;
