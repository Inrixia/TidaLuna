import type { AnyFn } from "@inrixia/helpers";
import type { LunaUnload } from "./helpers/unloadSet";
import { modules } from "./modules";

// Define getters for lib and ui to proxy to modules
Object.defineProperty(window.luna, "lib", {
	get: () => modules["@luna/lib"],
	enumerable: true,
	configurable: false,
});
Object.defineProperty(window.luna, "ui", {
	get: () => modules["@luna/ui"],
	enumerable: true,
	configurable: false,
});
Object.defineProperty(window.luna, "dev", {
	get: () => modules["@luna/dev"],
	enumerable: true,
	configurable: false,
});
Object.defineProperty(window.luna, "native", {
	get: () => modules["@luna/lib.native"],
	enumerable: true,
	configurable: false,
});
declare global {
	interface Window {
		luna: {
			// Throw lib, ui & core here for ease of use
			core?: typeof import("@luna/core");
			lib?: typeof import("@luna/lib");
			native?: typeof import("../../plugins/lib.native/src/index.native");
			ui?: typeof import("@luna/ui");
			dev?: typeof import("@luna/dev");
		};
	}
	// Define platform export (see native/preload.ts)
	const __platform: NodeJS.Platform;
	// Define ipcRenderer exports (see native/preload.ts)
	const __ipcRenderer: {
		//** Dont use this! Use @luna/lib ipcRenderer */
		invoke: Electron.IpcRenderer["invoke"];
		//** Dont use this! Use @luna/lib ipcRenderer */
		send: Electron.IpcRenderer["send"];
		//** Dont use this! Use @luna/lib ipcRenderer */
		on: (channel: string, listener: AnyFn) => LunaUnload;
		//** Dont use this! Use @luna/lib ipcRenderer */
		once: (channel: string, listener: AnyFn) => LunaUnload;
	};
	// Requests to Luna core, answered in the main process (see native/core/coreWorld.ts). Use LunaPlugin instead
	const __LunaCore: {
		list(): Promise<import("../../native/core/registry").CorePluginInfo[]>;
		info(url: string): Promise<import("../../native/core/registry").CorePluginInfo | undefined>;
		needsMigration(): Promise<boolean>;
		migrate(entries: { url: string; name?: string; enabled: boolean }[]): Promise<void>;
		load(url: string): Promise<{
			package: import("./LunaPlugin").PluginPackage;
			code: string;
			pending?: import("../../native/core/registry").PendingUpdate;
		}>;
		install(url: string): Promise<boolean>;
		enable(url: string): Promise<boolean>;
		disable(url: string): Promise<void>;
		uninstall(url: string): Promise<void>;
		/** A store moved: the plugin's record goes to its new url, other code there waits as an update */
		moveUrl(from: string, to: string): Promise<boolean>;
		acceptUpdate(url: string): Promise<boolean>;
		/** Runs the plugin's isolated world (see native/worlds.ts). Throws without contextIsolation (tidal-hifi) */
		loadWorld(url: string): Promise<void>;
		unloadWorld(url: string): Promise<void>;
		/** luna.fetch for `pluginUrl` (see native/core/net.ts). Use lunaFetch instead */
		fetch(pluginUrl: string, request: import("../../native/core/net").NetRequest): Promise<import("../../native/core/net").NetResponse>;
		/** luna.fetch requests since TIDAL started, the newest last */
		networkLog(): Promise<import("../../native/core/net").NetLogEntry[]>;
		clearNetworkLog(): Promise<void>;
	};
}
