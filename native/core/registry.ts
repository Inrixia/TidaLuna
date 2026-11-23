// Luna's plugin registry: which plugins are installed and enabled, and which version of their code the user accepted.
// It runs in the main process (registryMain.ts), so the checks that use it hold whoever sends the IPC: native files
// register only for the accepted code of an enabled plugin (NativeModule/index.ts), and their channels work only while it
// is enabled, and a plugin world (worlds.ts) loads only the accepted `.world.json` of an enabled plugin. Installing,
// enabling native code and accepting an update happen here, after the user confirms in Luna's confirmation window
// (confirmWindow.ts).
//
// Kept apart from Electron (its IO comes in as RegistryDeps) so it can be tested.
import { createHash } from "crypto";

import type { ConfirmRequest } from "./confirmPage";
import { parseBundle, worldFilePrefix } from "../worldBundle";
import { declaredHosts, hostsDiff, sameHosts } from "./hosts";
import { isCoreUrl, isDevUrl, nativesDiff } from "./policy";

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
	/** Network hosts the plugin connects to (core/hosts.ts). Without it the plugin runs in compatibility mode */
	hosts?: unknown;
	[key: string]: unknown;
};
/** A version of a plugin's code: the one the user accepted, or an update waiting for them */
export type Version = {
	package: PluginPackage;
	code: string;
	/** sha256 (hex) of `code` as UTF-8: the served `<url>.mjs` followed by `\n//# sourceURL=<url>.mjs`, exactly what the page runs */
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
/**
 * A plugin installed before Luna core whose natives the page registers (the old format, without isolation). Only
 * migrate writes entries; the first version accepted after it pins `codeSha256`, and any other accepted code, an
 * uninstall or a move to other code removes the entry for good.
 */
export type LegacyEntry = {
	/** package.hash the page had stored: a first version with another hash isn't the one installed before */
	hash?: string;
	codeSha256?: string;
};
export type CoreState = { version: 1; plugins: Record<string, CoreRecord>; legacy?: Record<string, LegacyEntry> };
export type PendingUpdate = {
	version?: string;
	hash: string;
	codeSha256: string;
	natives: string[];
	added: string[];
	removed: string[];
	/** The update's declared hosts, undefined if it declares none */
	hosts?: string[];
	hostsAdded: string[];
	hostsRemoved: string[];
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
	/** Network hosts of the accepted version, undefined if it declares none (compatibility mode) */
	hosts?: string[];
	/** The accepted code has natives in the old format: "allowed" if they run (installed before Luna core, not updated since) */
	legacyNatives?: "allowed" | "refused";
	pending?: PendingUpdate;
};
/** Asks the user who made the request: true only if they confirmed. Throws if they could not be asked */
export type Ask = (request: ConfirmRequest) => Promise<boolean>;

export type RegistryDeps = {
	/** The stored state, or null if none was stored yet */
	read(): CoreState | null;
	write(state: CoreState): void | Promise<void>;
	fetchPackage(url: string): Promise<PluginPackage>;
	fetchCode(url: string): Promise<string>;
	/** The text of `${url}.world.json` */
	fetchWorld(url: string): Promise<string>;
	/** fileName -> code of the native files a bundle registers */
	nativeSources(code: string): Record<string, string>;
	/** Forgets the native permission answers given for a plugin (a reinstall asks again) */
	forgetAnswers(url: string): void;
	log?: (message: string) => void;
};
// #endregion

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** First 12 hex digits, enough to tell versions apart and compare with a published hash */
const shortHash = (hash: string) => hash.slice(0, 12);

const isWorldNative = (fileName: string) => fileName.startsWith(worldFilePrefix);
/** The served code, without the sourceURL line fetchCode adds (it names the url) */
const withoutSource = (code: string, url: string) => {
	const suffix = `\n//# sourceURL=${url}.mjs`;
	return code.endsWith(suffix) ? code.slice(0, -suffix.length) : code;
};
const isNative = (version: Version) => version.natives.length !== 0;
/**
 * A new hash of either the page code or the world is a new version, and so are new `hosts`: the build's hash covers only
 * the code, and the user accepts the hosts with the version
 */
const sameVersion = (version: Version | undefined, pkg: PluginPackage) =>
	version !== undefined &&
	version.package.hash === pkg.hash &&
	version.package.worldHash === pkg.worldHash &&
	sameHosts(version.package.hosts, pkg.hosts);
const hostsOfVersion = (version: Version | undefined) => (version === undefined ? undefined : declaredHosts(version.package.hosts)?.hosts);

/** What the confirmation says about a version's network hosts */
const describeHosts = (version: Version): string[] => {
	const declared = declaredHosts(version.package.hosts);
	if (declared === undefined)
		return ["Network: doesn't list the hosts it connects to. Compatibility mode: luna.fetch lets it reach any public host, and marks its requests in the log."];
	const lines =
		declared.hosts.length === 0
			? ["Network: none. luna.fetch refuses every host for it."]
			: [`Network: ${declared.hosts.join(", ")}. luna.fetch refuses any other host for it.`];
	if (declared.invalid.length !== 0) lines.push(`Ignored, not valid hosts: ${declared.invalid.join(", ")}`);
	return lines;
};

const legacyNativesOf = (version: Version) => version.natives.filter((fileName) => !isWorldNative(fileName));
export const legacyFormatMessage = (name: string) =>
	`${name} uses the old native format, without isolation: its native code doesn't run. The author must move it to the new format (lunaWorld).`;

/** What the confirmation says about a version. `legacyRuns`: its old-format natives would run (see LegacyEntry) */
export const describe = (url: string, version: Version, legacyRuns = false): string[] => {
	const lines = [`${version.package.name} ${version.package.version ?? ""} from ${url}${isDevUrl(url) ? " (this computer)" : ""}`];
	const legacy = legacyNativesOf(version);
	const world = version.natives.filter(isWorldNative).map((fileName) => fileName.slice(worldFilePrefix.length));
	if (world.length !== 0)
		lines.push(
			`Native code (runs in TIDAL's main process): ${world.join(", ")}. Only the plugin's own isolated world can call it, other plugins can't reach it. TIDAL asks for each native file.`,
		);
	if (legacy.length !== 0 && legacyRuns)
		lines.push(
			`Native code (runs in TIDAL's main process): ${legacy.join(", ")}. TIDAL asks for each native file.`,
			"Legacy native plugin: while it is enabled, any plugin or script in the page can call its native functions.",
			isDevUrl(url)
				? "Old native format: it runs because the plugin comes from this computer."
				: "Old native format: it keeps running because it was installed before this Luna version, until the plugin updates.",
		);
	else if (legacy.length !== 0)
		lines.push(
			`Old native format, without isolation: ${legacy.join(", ")} won't run. The author must move the plugin to the new format (lunaWorld).`,
		);
	if (!isNative(version)) lines.push("No native code: it runs in the page like other plugins.");
	lines.push(...describeHosts(version));
	lines.push("Plugin code can read and change everything in TIDAL: only allow plugins you trust.");
	return lines;
};

export const pluginUrl = (url: unknown): string => {
	if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error(`[Luna.core] Not a plugin url: ${String(url)}`);
	return url;
};

export const createRegistry = (deps: RegistryDeps) => {
	const stored = deps.read();
	const state: CoreState =
		stored?.version === 1 && typeof stored.plugins === "object" && stored.plugins !== null ? stored : { version: 1, plugins: {} };
	/** No state was stored yet: the page may hand over what it had stored, once (see migrate) */
	let fresh = state !== stored;
	const legacy = (state.legacy ??= {});
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

	const fetchVersion = async (url: string, pkg?: PluginPackage): Promise<Version> => {
		pkg ??= await deps.fetchPackage(url);
		const code = await deps.fetchCode(url);
		const natives = Object.keys(deps.nativeSources(code));
		if (typeof pkg.lunaWorld !== "string") return { package: pkg, code, codeSha256: sha256(code), natives };
		// The world is pinned with the code: worlds.ts runs exactly this text, whatever the url serves later
		const world = await deps.fetchWorld(url);
		if (pkg.worldHash !== sha256(world)) throw new Error(`[Luna.core] ${url}.world.json doesn't match the worldHash of ${url}.json`);
		const worldNatives = Object.keys(parseBundle(world).natives).map((fileName) => worldFilePrefix + fileName);
		return { package: pkg, code, codeSha256: sha256(code), natives: [...natives, ...worldNatives], world };
	};

	// #region Old native format (see LegacyEntry): the list only shrinks
	/** Old-format natives of this accepted version run: a dev url, or the version pinned for a plugin installed before Luna core */
	const legacyRuns = (url: string, version: Version | undefined) =>
		isDevUrl(url) || (version !== undefined && legacy[url]?.codeSha256 !== undefined && legacy[url].codeSha256 === version.codeSha256);
	const dropLegacy = (url: string, why: string) => {
		if (legacy[url] === undefined) return;
		delete legacy[url];
		deps.log?.(`[Luna.core] ${url} is off the old native format list: ${why}`);
	};
	/** The only way a version becomes accepted: pins the first one of a listed plugin, drops the entry for any other */
	const accept = (record: CoreRecord, version: Version) => {
		record.accepted = version;
		const entry = legacy[record.url];
		if (entry === undefined) return;
		if (entry.codeSha256 === undefined && (entry.hash === undefined || entry.hash === version.package.hash)) entry.codeSha256 = version.codeSha256;
		else if (entry.codeSha256 !== version.codeSha256) dropLegacy(record.url, "its code changed");
	};
	/** For a first review (enable): would accepting this version keep the old format running? */
	const legacyWouldRun = (record: CoreRecord, version: Version) => {
		const entry = legacy[record.url];
		return (
			isDevUrl(record.url) ||
			(entry !== undefined && entry.codeSha256 === undefined && (entry.hash === undefined || entry.hash === version.package.hash))
		);
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
			hosts: hostsOfVersion(accepted),
			legacyNatives:
				accepted === undefined || legacyNativesOf(accepted).length === 0 ? undefined : legacyRuns(url, accepted) ? "allowed" : "refused",
			// A version waiting for its first review (a migrated native plugin) is enabled, not updated: see enable
			pending:
				pending === undefined || accepted === undefined
					? undefined
					: {
							version: pending.package.version,
							hash: pending.package.hash,
							codeSha256: pending.codeSha256,
							natives: pending.natives,
							...nativesDiff(accepted?.natives ?? [], pending.natives),
							hosts: hostsOfVersion(pending),
							...(({ added, removed }) => ({ hostsAdded: added, hostsRemoved: removed }))(
								hostsDiff(hostsOfVersion(accepted) ?? [], hostsOfVersion(pending) ?? []),
							),
						},
		};
	};

	/** The code the page may run for `url`: the accepted version of an enabled plugin. New versions wait for acceptUpdate */
	const load = async (url: string) => {
		const record = state.plugins[url];
		if (record === undefined || !record.enabled) throw new Error(`[Luna.core] ${url} is not enabled`);
		try {
			const pkg = await deps.fetchPackage(url);
			if (!sameVersion(record.accepted, pkg)) {
				const version = sameVersion(record.pending, pkg) ? record.pending! : await fetchVersion(url, pkg);
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
		const record = state.plugins[url];
		if (record === undefined) return false;
		if (record.enabled) return true;
		if (record.accepted === undefined && record.pending === undefined) record.pending = await fetchVersion(url);
		const version = (record.accepted ?? record.pending)!;
		// Enabling plain page code gives the page nothing it doesn't have: only native plugins (and first reviews) ask
		if (isNative(version) || record.accepted === undefined) {
			const lines = describe(url, version, record.accepted === undefined ? legacyWouldRun(record, version) : legacyRuns(url, version));
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
		const version = await fetchVersion(url);
		const lines = describe(url, version, isDevUrl(url));
		if (!(await ask({ title: `Install ${version.package.name}?`, lines, confirmText: "Install" }))) return false;
		// Installed meanwhile by another request? This one asked the user about this version: it wins. A new install is
		// never on the old native format list
		dropLegacy(url, "installed again");
		state.plugins[url] = { url, name: version.package.name, enabled: true, accepted: version };
		await save();
		return true;
	};

	const acceptUpdate = async (url: string, ask: Ask): Promise<boolean> => {
		const record = state.plugins[url];
		const { accepted, pending } = record ?? {};
		if (record === undefined || accepted === undefined || pending === undefined) return false;
		const changes = info(url)!.pending!;
		const lines = [
			`${accepted.package.version ?? "?"} -> ${pending.package.version ?? "?"}`,
			`Code sha256: ${shortHash(accepted.codeSha256)} -> ${shortHash(pending.codeSha256)}`,
			// The world drives the plugin's natives: a change to it alone is shown too
			...(accepted.package.worldHash !== pending.package.worldHash
				? [`World sha256: ${shortHash(accepted.package.worldHash ?? "none")} -> ${shortHash(pending.package.worldHash ?? "none")}`]
				: []),
			"Until you update, the version you have keeps running.",
			...describe(url, pending, isDevUrl(url)),
		];
		if (!isDevUrl(url) && legacyRuns(url, accepted) && legacyNativesOf(accepted).length !== 0)
			lines.push("This plugin uses the old native format. After this update it can't any more, even if you go back to this version.");
		if (changes.added.length !== 0) lines.push(`New native files: ${changes.added.join(", ")}`);
		if (changes.removed.length !== 0) lines.push(`Removed native files: ${changes.removed.join(", ")}`);
		const acceptedHosts = hostsOfVersion(accepted);
		if (acceptedHosts === undefined && changes.hosts !== undefined) lines.push("Now lists its network hosts: other hosts are refused from now on.");
		else if (acceptedHosts !== undefined && changes.hosts === undefined)
			lines.push("No longer lists its network hosts: compatibility mode, any public host.");
		else {
			if (changes.hostsAdded.length !== 0) lines.push(`New network hosts: ${changes.hostsAdded.join(", ")}`);
			if (changes.hostsRemoved.length !== 0) lines.push(`Removed network hosts: ${changes.hostsRemoved.join(", ")}`);
		}
		// Operations on this url wait for the answer (serial): a newer update a load finds meanwhile waits for its own window
		if (!(await ask({ title: `Update ${record.name}?`, lines, confirmText: "Update" }))) return false;
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
		delete state.plugins[url];
		// A reinstall of the same version doesn't bring it back
		dropLegacy(url, "uninstalled");
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
		const { accepted } = record;
		const moved: CoreRecord = { ...record, url: to, pending: undefined };
		// The same code, the same world (pinned with it) and the same hosts: nothing new to review
		if (
			found !== undefined &&
			accepted !== undefined &&
			withoutSource(found.code, to) === withoutSource(accepted.code, from) &&
			found.world === accepted.world &&
			sameHosts(found.package.hosts, accepted.package.hosts)
		)
			moved.accepted = found;
		else if (found !== undefined && accepted !== undefined) moved.pending = found;
		// The entry moves with the record, never grows: pinned to the same code at its new url (its sourceURL names the url)
		const entry = legacy[from];
		const runs = legacyRuns(from, accepted);
		delete legacy[from];
		if (entry !== undefined && moved.accepted !== undefined && runs) legacy[to] = { ...entry, codeSha256: moved.accepted.codeSha256 };
		// Not reviewed yet: the first version accepted at the new url is pinned (or drops it) as at the old one
		else if (entry !== undefined && accepted === undefined) legacy[to] = entry;
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
			const { url, name, enabled, hash } = entry ?? {};
			if (typeof url !== "string" || !/^https?:\/\//.test(url) || isCoreUrl(url) || typeof name !== "string") continue;
			state.plugins[url] = { url, name, enabled: enabled === true, unreviewed: true };
			// Installed before Luna core: its natives may keep the old format until its code changes (see LegacyEntry)
			legacy[url] = typeof hash === "string" ? { hash } : {};
		}
		await save();
	};

	const holdsNative = (record: CoreRecord | undefined, fileName: string, code: string): record is CoreRecord & { accepted: Version } =>
		record?.enabled === true &&
		record.accepted !== undefined &&
		record.accepted.natives.includes(fileName) &&
		sourcesOf(record.accepted)[fileName] === code;
	// The page registers only old-format natives (worlds load theirs in worlds.ts)
	const ownsNative = (record: CoreRecord | undefined, fileName: string, code: string) =>
		holdsNative(record, fileName, code) && legacyRuns(record.url, record.accepted);
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
		info: (url: unknown) => info(pluginUrl(url)),
		needsMigration: () => fresh,
		migrate,
		load: async (url: unknown) => {
			const checked = pluginUrl(url);
			return serial(checked, () => load(checked));
		},
		install: (url: unknown, ask: Ask) => forPlugin(true, (checked) => install(checked, ask))(url),
		enable: (url: unknown, ask: Ask) => forPlugin(true, (checked) => enable(checked, ask))(url),
		acceptUpdate: (url: unknown, ask: Ask) => forPlugin(false, (checked) => acceptUpdate(checked, ask))(url),
		moveUrl: (from: unknown, to: unknown): Promise<boolean> => {
			const target = pluginUrl(to);
			return forPlugin(false, (source) => moveUrl(source, target))(from);
		},
		disable: forPlugin(undefined, disable),
		uninstall: forPlugin(undefined, uninstall),

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
		/**
		 * For luna.fetch (net.ts): the enabled plugin's name and the hosts of its accepted version (undefined: it declares
		 * none). Undefined if it isn't an enabled plugin with accepted code
		 */
		hostsOf: (url: string): { name: string; hosts?: string[] } | undefined => {
			const record = state.plugins[url];
			if (record?.enabled !== true || record.accepted === undefined) return undefined;
			return { name: record.name, hosts: hostsOfVersion(record.accepted) };
		},
		/** Every host an enabled plugin's accepted version declares (the CSP report-only header lists them, cspReportOnly.ts) */
		declaredHosts: (): string[] => {
			const hosts = new Set<string>();
			for (const record of Object.values(state.plugins))
				if (record.enabled) for (const host of hostsOfVersion(record.accepted) ?? []) hosts.add(host);
			return [...hosts];
		},
		// #endregion
	};
};
export type Registry = ReturnType<typeof createRegistry>;
