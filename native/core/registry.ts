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
export type CoreState = { version: 1; plugins: Record<string, CoreRecord> };
export type PendingUpdate = {
	version?: string;
	hash: string;
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
/** A new hash of either the page code or the world is a new version */
const sameVersion = (version: Version | undefined, pkg: PluginPackage) =>
	version !== undefined && version.package.hash === pkg.hash && version.package.worldHash === pkg.worldHash;

/** What the confirmation says about a version */
export const describe = (url: string, version: Version): string[] => {
	const lines = [`${version.package.name} ${version.package.version ?? ""} from ${url}${isDevUrl(url) ? " (this computer)" : ""}`];
	const legacy = version.natives.filter((fileName) => !isWorldNative(fileName));
	const world = version.natives.filter(isWorldNative).map((fileName) => fileName.slice(worldFilePrefix.length));
	if (world.length !== 0)
		lines.push(
			`Native code (runs in TIDAL's main process): ${world.join(", ")}. Only the plugin's own isolated world can call it, other plugins can't reach it. TIDAL asks for each native file.`,
		);
	if (legacy.length !== 0)
		lines.push(
			`Native code (runs in TIDAL's main process): ${legacy.join(", ")}. TIDAL asks for each native file.`,
			"Legacy native plugin: while it is enabled, any plugin or script in the page can call its native functions.",
		);
	if (!isNative(version)) lines.push("No native code: it runs in the page like other plugins.");
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
					record.accepted = version;
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
			if (!(await ask({ title: `Enable ${record.name}?`, lines: describe(url, version), confirmText: "Enable" }))) return false;
		}
		if (record.accepted === undefined) {
			record.accepted = version;
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
		if (!(await ask({ title: `Install ${version.package.name}?`, lines: describe(url, version), confirmText: "Install" }))) return false;
		// Installed meanwhile by another request? This one asked the user about this version: it wins
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
			...describe(url, pending),
		];
		if (changes.added.length !== 0) lines.push(`New native files: ${changes.added.join(", ")}`);
		if (changes.removed.length !== 0) lines.push(`Removed native files: ${changes.removed.join(", ")}`);
		// Operations on this url wait for the answer (serial): a newer update a load finds meanwhile waits for its own window
		if (!(await ask({ title: `Update ${record.name}?`, lines, confirmText: "Update" }))) return false;
		record.accepted = pending;
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
		// The same code and the same world (pinned with it): nothing new to review
		if (
			found !== undefined &&
			accepted !== undefined &&
			withoutSource(found.code, to) === withoutSource(accepted.code, from) &&
			found.world === accepted.world
		)
			moved.accepted = found;
		else if (found !== undefined && accepted !== undefined) moved.pending = found;
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
			if (typeof url !== "string" || !/^https?:\/\//.test(url) || isCoreUrl(url) || typeof name !== "string") continue;
			state.plugins[url] = { url, name, enabled: enabled === true, unreviewed: true };
		}
		await save();
	};

	const ownsNative = (record: CoreRecord | undefined, fileName: string, code: string) =>
		record?.enabled === true &&
		record.accepted !== undefined &&
		record.accepted.natives.includes(fileName) &&
		sourcesOf(record.accepted)[fileName] === code;
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
		/** The `.world.json` text the user accepted for an enabled plugin with a world */
		acceptedWorld: (url: string): string | undefined => {
			const record = state.plugins[url];
			return record?.enabled === true ? record.accepted?.world : undefined;
		},
		// #endregion
	};
};
export type Registry = ReturnType<typeof createRegistry>;
