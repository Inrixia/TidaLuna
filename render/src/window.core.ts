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
			native?: typeof import("plugins/lib.native/src/index.native");
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
}
