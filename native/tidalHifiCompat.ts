/**
 * tidal-hifi sandbox compatibility layer
 * Only loaded when running on tidal-hifi (detected via package name)
 */
import * as electron from "electron";
import { ipcRenderer } from "electron";
import * as remote from "@electron/remote";

// Expose process globally
(globalThis as any).process = { platform: "linux", env: {}, cwd: () => "/", argv: [] };

// Path utilities
const path = {
	join: (...a: string[]) => a.join("/").replace(/\/+/g, "/"),
	dirname: (p: string) => p.split("/").slice(0, -1).join("/") || ".",
	resolve: (base: string, rel: string) => {
		const parts = base.split("/").filter((p) => p && p !== ".");
		for (const p of rel.split("/")) {
			if (p === "..") parts.pop();
			else if (p && p !== ".") parts.push(p);
		}
		return parts.join("/") || ".";
	},
};

// electron-store mock
function Store(this: any) { this.d = {}; }
Store.prototype = {
	get(k: string, def?: any) { return this.d[k] ?? def; },
	set(k: string, v: any) { this.d[k] = v; },
	has(k: string) { return k in this.d; },
	delete(k: string) { delete this.d[k]; },
	clear() { this.d = {}; },
};

// Module cache for require shim
const modules: Record<string, any> = {
	"@electron/remote": remote,
	electron,
	path,
	fs: {},
	"electron-store": Store,
	"mpris-service": () => ({}),
	request: {},
	"hotkeys-js": () => {},
};

/**
 * Execute tidal-hifi's original preload with a custom require shim
 */
export const execTidalHifiPreload = async () => {
	const cache: Record<string, any> = {};
	const dirs = ["."];

	const require = (id: string): any => {
		if (modules[id]) return modules[id];
		if (cache[id]) return cache[id];

		if (id.startsWith("./") || id.startsWith("../")) {
			const file = path.resolve(dirs.at(-1)!, id) + ".js";
			if (cache[file]) return cache[file];

			const res = ipcRenderer.sendSync("__Luna.readTidalModule", file);
			if (!res.success) return {};

			const mod = { exports: {} as any };
			cache[file] = mod.exports;
			dirs.push(path.dirname(file));
			try {
				new Function("require", "exports", "module", res.code)(require, mod.exports, mod);
				cache[file] = mod.exports;
			} finally {
				dirs.pop();
			}
			return mod.exports;
		}
		return {};
	};

	const code = await ipcRenderer.invoke("__Luna.originalPreload");
	new Function("require", "exports", "module", code)(require, {}, { exports: {} });
};
