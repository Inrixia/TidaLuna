// Pure decisions of Luna's core (native/core/registry.ts, coreWorld.ts) and about its own native code, kept apart so
// they can be tested without Electron.

/** Luna's own plugins, served from its bundle (native/injector.ts). By url, not by name: any plugin can name itself like a core plugin */
export const isCoreUrl = (url: string) => url.startsWith("https://luna/");

/**
 * A dev plugin is served from this machine (`slot.mjs serve`, `pnpm watch`): http on host 127.0.0.1, any port. Its
 * updates run without asking, as live reload expects. Checked by host, not by prefix, so `http://127.0.0.1.example.com`
 * or `http://127.0.0.1@example.com` don't count.
 */
export const isDevUrl = (url: string) => {
	try {
		const { protocol, hostname } = new URL(url);
		return protocol === "http:" && hostname === "127.0.0.1";
	} catch {
		return false;
	}
};

/** Native files an update adds and removes */
export const nativesDiff = (accepted: string[], pending: string[]) => ({
	added: pending.filter((name) => !accepted.includes(name)),
	removed: accepted.filter((name) => !pending.includes(name)),
});

/** A small cache that forgets its least recently used entries */
export const boundedCache = <V>(limit: number) => {
	const entries = new Map<string, V>();
	return {
		get: (key: string) => {
			const value = entries.get(key);
			// Used again: now the newest
			if (value !== undefined) {
				entries.delete(key);
				entries.set(key, value);
			}
			return value;
		},
		set: (key: string, value: V) => {
			entries.delete(key);
			entries.set(key, value);
			while (entries.size > limit) entries.delete(entries.keys().next().value!);
		},
		get size() {
			return entries.size;
		},
	};
};

export type CoreNativeRule = "allow" | "deny" | "confirm";
// Core native exports page code may not call, or only after the user confirms in Luna's confirmation window
// (confirmWindow.ts). Everything else a core plugin exports is meant for the page (pkg, dialogs, caches, download into
// picked folders, …)
const coreDenied = new Set(["sendToRender"]);
const coreConfirmed = new Set(["update", "runElevatedInstall", "startNativeDebugging"]);
export const coreNativeRule = (exportName: string): CoreNativeRule =>
	coreDenied.has(exportName) ? "deny" : coreConfirmed.has(exportName) ? "confirm" : "allow";

/** What the confirmation window says before a confirmed core native runs */
export const coreNativeQuestion = (exportName: string, args: unknown[]): [title: string, lines: string[], confirmText: string] => {
	switch (exportName) {
		case "update":
			return ["Update Luna?", [`Download and install Luna ${String(args[0])}, then restart TIDAL.`], "Update"];
		case "runElevatedInstall":
			return ["Install Luna as administrator?", ["Runs the Luna installer with administrator rights."], "Install"];
		case "startNativeDebugging":
			return [
				"Start native debugging?",
				["Opens a Node inspector on TIDAL's main process. Any program on this computer can then run code in TIDAL."],
				"Start",
			];
		default:
			return [`Run ${exportName}?`, [], "Run"];
	}
};
