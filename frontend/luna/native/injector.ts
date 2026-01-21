import electron from "electron";
import os from "os";

import { readFile, rm, writeFile } from "fs/promises";
import mime from "mime";

import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import Module, { createRequire } from "module";

const fontUrlRegex = /\.(woff2?|ttf|otf|eot)(\?.*)?$/i;

// #region Bundle
const bundleDir = process.env.TIDALUNA_DIST_PATH ?? path.dirname(fileURLToPath(import.meta.url));
const tidalAppPath = path.join(process.resourcesPath, "original.asar");

// Safe ipcHandler to ensure no duplicates
const ipcHandle: (typeof Electron)["ipcMain"]["handle"] = (channel, listener) => {
	electron.ipcMain.removeHandler(channel);
	electron.ipcMain.handle(channel, listener);
};
// #endregion

// Define globalThis.luna
declare global {
	var luna: {
		modules: Record<string, any>;
		tidalWindow?: Electron.BrowserWindow;
	};
}

globalThis.luna = {
	modules: {},
};

// Allow debugging from remote origins (e.g., Chrome DevTools over localhost)
// Requires starting client with --remote-debugging-port=9222
electron.app.commandLine.appendSwitch("remote-allow-origins", "http://localhost:9222");

const bundleFile = async (url: string): Promise<[Buffer, ResponseInit]> => {
	const fileName = url.slice(13);
	// Eh, can already use native to touch fs dont stress escaping bundleDir
	const filePath = path.join(bundleDir, fileName);
	let content = await readFile(filePath);

	// If JS file, check for .map and append if exists
	if (fileName.endsWith(".mjs")) {
		const mapPath = filePath + ".map";
		try {
			// Append base64 encoded source map to the end of the file
			const base64Map = Buffer.from(await readFile(mapPath, "utf8")).toString("base64");
			const sourceMapComment = `\n//# sourceURL=${url}\n//# sourceMappingURL=data:application/json;base64,${base64Map}`;
			content = Buffer.concat([content, Buffer.from(sourceMapComment, "utf8")]);
		} catch {
			// .map file does not exist, do nothing
		}
	}
	return [content, { headers: { "Content-Type": mime.getType(fileName)! } }];
};

// Preload bundle files for https://luna/
const lunaBundle = bundleFile("https://luna/luna.mjs").then(([content]) => content);
ipcHandle("__Luna.renderJs", () => lunaBundle);

// #region CSP/Script Prep
// Ensure app is ready
electron.app.whenReady().then(async () => {
	electron.protocol.handle("https", async (req) => {
		if (req.url.startsWith("https://luna/")) {
			try {
				// @ts-expect-error: Buffer is valid for Response body
				return new Response(...(await bundleFile(req.url)));
			} catch (err: any) {
				return new Response(err.message, { status: err.message.startsWith("ENOENT") ? 404 : 500, statusText: err.message });
			}
		}

		// Bypass CSP & Mark meta scripts for quartz injection
		if (req.url === "https://desktop.tidal.com/" || req.url === "https://tidal.com/" || req.url === "https://listen.tidal.com/") {
			const res = await electron.net.fetch(req, { bypassCustomProtocolHandlers: true });
			let body = await res.text();
			body = body.replace(
				/(<meta http-equiv="Content-Security-Policy")|(<script type="module" crossorigin src="(.*?)">)/g,
				(match, cspMatch, scriptMatch, src) => {
					if (cspMatch) {
						// Remove CSP
						return `<meta name="LunaWuzHere"`;
					} else if (scriptMatch) {
						// Mark module scripts for quartz injection
						return `<script type="luna/quartz" src="${src}">`;
					}

					// Should not happen if the regex is correct
					return match;
				},
			);
			return new Response(body, res);
		}
		// Fix tidal trying to bypass cors
		if (req.url.endsWith("?cors")) return fetch(req);
		// Fix font loading - fonts require credentials: 'omit' for CORS
		if (fontUrlRegex.test(req.url)) {
			return electron.net.fetch(req.url, {
				bypassCustomProtocolHandlers: true,
				credentials: "omit",
			});
		}
		// All other requests passthrough
		return electron.net.fetch(req, { bypassCustomProtocolHandlers: true });
	});
	// Force service worker to fetch resources by clearing it's cache.
	electron.session.defaultSession.clearStorageData({
		storages: ["cachestorage"],
	});
});

// #region Proxied BrowserWindow
const ProxiedBrowserWindow = new Proxy(electron.BrowserWindow, {
	construct(target, args) {
		const options = args[0];

		// Improve memory limits
		options.webPreferences.nodeOptions = "--max-old-space-size=8192";

		// Ensure smoothScrolling is always enabled
		options.webPreferences.smoothScrolling = true;

		// tidal-hifi does not set the title, rely on dev tools instead.
		const isTidalWindow = options.title == "TIDAL" || options.webPreferences?.devTools;

		// explicitly set icon before load on linux
		const platformIsLinux = process.platform === "linux";
		const iconPath = path.join(tidalAppPath, "assets/icon.png");
		if (platformIsLinux) {
			options.icon = iconPath;
		}

		if (isTidalWindow) {
			// Store original preload and add a handle to fetch it later (see ./preload.ts)
			const origialPreload = options.webPreferences?.preload;
			ipcHandle("__Luna.originalPreload", () => origialPreload);

			// Replace the preload instead of using setPreloads because of some differences in internal behaviour.
			// Set preload script to Luna's
			options.webPreferences.preload = path.join(bundleDir, "preload.mjs");

			// TODO: Find why sandboxing has to be disabled
			options.webPreferences.sandbox = false;
		}

		const window = (luna.tidalWindow = new target(options));

		// if we are on linux and this is the main tidal window,
		// set the icon again after load (potential KDE quirk)
		if (platformIsLinux && isTidalWindow) {
			window.webContents.once("did-finish-load", () => {
				window.setIcon(iconPath);
			});
		}

		// #region Open from link
		// MacOS
		electron.app.setAsDefaultProtocolClient("tidaLuna");
		electron.app.on("open-url", (_, url) => window.webContents.send("__Luna.openUrl", url));
		// Windows/Linux
		electron.app.on("second-instance", (_, argv) => window.webContents.send("__Luna.openUrl", argv[argv.length - 1]));
		// #endregion

		// #region Native console logging
		// Overload console logging to forward to dev-tools
		const _console = console;
		const consolePrefix = "[Luna.native]";
		console = new Proxy(_console, {
			get(target, prop, receiver) {
				const originalValue = target[prop as keyof typeof target];
				if (typeof originalValue === "function") {
					return (...args: any[]) => {
						if (args.length > 0) {
							args = [consolePrefix, ...args];
						}
						// Call the original console method
						(originalValue as Function).apply(target, args);
						// Send the log data to the renderer process
						try {
							// Use prop.toString() in case prop is a Symbol
							window.webContents.send("__Luna.console", prop.toString(), args);
						} catch (e) {
							const args = ["Failed to forward console to renderer", e];
							_console.error(consolePrefix, ...args);
							try {
								window.webContents.send("__Luna.console", "error", args);
							} catch {}
						}
					};
				}
				// Return non-function properties directly
				return Reflect.get(target, prop, receiver);
			},
		});
		// #endregion
		return window;
	},
});
// #endregion

const tidalPackage = await readFile(path.resolve(path.join(tidalAppPath, "package.json")), "utf8").then(JSON.parse);
const startPath = path.join(tidalAppPath, tidalPackage.main);

// @ts-expect-error This exists?
electron.app.setAppPath?.(tidalAppPath);
electron.app.name = tidalPackage.name;

const blockedModules = new Set(["jszip"]);
const _require = Module.prototype.require;
Module.prototype.require = function (id) {
	if (blockedModules.has(id)) {
		console.warn(`[Luna.native] Intercepted and blocked global require('${id}')`);
		return {};
	}
	return _require.apply(this, [id]);
};
require = createRequire(tidalAppPath);

// Replace the default electron BrowserWindow with our proxied one
const electronPath = require.resolve("electron");
delete require.cache[electronPath]!.exports;
require.cache[electronPath]!.exports = {
	...electron,
	BrowserWindow: ProxiedBrowserWindow,
};
// #endregion

// #region Restore DevTools
const originalBuildFromTemplate = electron.Menu.buildFromTemplate;
electron.Menu.buildFromTemplate = (template) => {
	template.push({
		role: "toggleDevTools",
		visible: false,
	});
	return originalBuildFromTemplate(template);
};
// #endregion

// #region Start app
require(startPath);
// #endregion

// #region LunaNative
const requirePrefix = `import { createRequire } from 'module';const require = createRequire(${JSON.stringify(pathToFileURL(process.resourcesPath + "/").href)});`;
// Call to register native module
ipcHandle("__Luna.registerNative", async (_, name: string, code: string) => {
	const tempDir = os.tmpdir();
	const tempFile = path.join(tempDir, Math.random().toString() + ".mjs");
	try {
		await writeFile(tempFile, requirePrefix + code, "utf8");

		// Load module
		const exports = (globalThis.luna.modules[name] = await import(pathToFileURL(tempFile).href));
		const channel = `__LunaNative.${name}`;

		// Register handler for calling module exports
		ipcHandle(channel, async (_, exportName, ...args) => {
			try {
				return await exports[exportName](...args);
			} catch (err: any) {
				// Set cause to identify a native module
				err.cause = `[Luna.native] (${name}).${exportName}`;
				throw err;
			}
		});

		return channel;
	} finally {
		await rm(tempFile, { force: true });
	}
});

// Literally just to log if preload fails
ipcHandle("__Luna.preloadErr", async (_, err: Error) => {
	console.error(err);
	electron.dialog.showErrorBox("TidaLuna", err.message);
});
// #endregion
