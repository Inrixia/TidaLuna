import electron, { type IpcMainInvokeEvent } from "electron";
import os from "os";

import { readFile, writeFile } from "fs/promises";
import mime from "mime";

import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import Module, { createRequire } from "module";

// #region Bundle
const bundleDir = process.env.TIDALUNA_DIST_PATH ?? path.dirname(fileURLToPath(import.meta.url));
const tidalAppPath = path.join(process.resourcesPath, "original.asar");

// Safe ipcHandler to ensure no duplicates
const ipcHandle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any) => {
	electron.ipcMain.removeHandler(channel);
	electron.ipcMain.handle(channel, listener);
};
// #endregion

// Define globalThis.luna
declare global {
	var luna: {
		modules: Record<string, any>;
		tidalWindow?: electron.BrowserWindow;
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
	electron.protocol.handle("https", async (req: Request) => {
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

			// Improved regex for robustness
			body = body.replace(
				/(<meta\s+http-equiv="Content-Security-Policy"[^>]*>)|(<script\s+type="module"\s+crossorigin\s+src="(.*?)">)/gi,
				(match: string, cspMatch: string, scriptMatch: string, src: string) => {
					if (cspMatch) {
						// Remove CSP
						return `<meta name="LunaWuzHere"`;
					} else if (scriptMatch) {
						// Mark module scripts for quartz injection
						return `<script type="luna/quartz" src="${src}">`;
					}
					return match;
				},
			);
			return new Response(body, res);
		}
		// Fix tidal trying to bypass cors
		if (req.url.endsWith("?cors")) return fetch(req);
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
		electron.app.on("open-url", (_: any, url: string) => window.webContents.send("__Luna.openUrl", url));
		// Windows/Linux
		electron.app.on("second-instance", (_: any, argv: string[]) => window.webContents.send("__Luna.openUrl", argv[argv.length - 1]));
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
							} catch { }
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
Module.prototype.require = function (id: string) {
	if (blockedModules.has(id)) {
		console.warn(`[Luna.native] Intercepted and blocked global require('${id}')`);
		return {};
	}
	return _require.apply(this, [id]);
};
const require = createRequire(tidalAppPath);

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
electron.Menu.buildFromTemplate = (template: any) => {
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

// Call to register native module
ipcHandle("__Luna.loadNative", async (_, fileName: string, logicalName: string) => {
	// Security check: ensure fileName has no path separators to prevent directory traversal
	if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
		throw new Error("[Luna.native] Security Error: Invalid filename for native module");
	}

	const filePath = path.join(bundleDir, fileName);

	try {
		// Load module from disk. 
		// Note: The file must have been placed there by the build process.
		const exports = (globalThis.luna.modules[logicalName] = await import(pathToFileURL(filePath).href));
		const channel = `__LunaNative.${logicalName}`;

		// Register handler for calling module exports
		ipcHandle(channel, async (_, exportName, ...args) => {
			try {
				return await exports[exportName](...args);
			} catch (err: any) {
				// Set cause to identify a native module
				err.cause = `[Luna.native] (${logicalName}).${exportName}`;
				throw err;
			}
		});

		return channel;
	} catch (err) {
		console.error(`[Luna.native] Failed to load native module ${logicalName} from ${fileName}`, err);
		throw err;
	}
});

// Literally just to log if preload fails
ipcHandle("__Luna.preloadErr", async (_, err: Error) => {
	console.error(err);
	electron.dialog.showErrorBox("TidaLuna", err.message);
});
// #region Legacy Support (Trust System)
import { createHash } from "crypto";

const trustedHashesPath = path.join(electron.app.getPath("userData"), "trusted-native.json");
let trustedHashes: Set<string> = new Set();

// Load trusted hashes on startup
(async () => {
	try {
		const data = await readFile(trustedHashesPath, "utf-8");
		trustedHashes = new Set(JSON.parse(data));
	} catch {
		// Ignore error
	}
})();

const saveTrustedHash = async (hash: string) => {
	trustedHashes.add(hash);
	await writeFile(trustedHashesPath, JSON.stringify([...trustedHashes], null, 2));
};

ipcHandle("__Luna.registerNative", async (_, nativeCode: string, pluginName: string = "Unknown Plugin") => {
	const hash = createHash("sha256").update(nativeCode).digest("hex");

	// Legacy Plugin Compatibility Fix done via global setup above

	if (!trustedHashes.has(hash)) {
		// Send request to renderer
		// @ts-expect-error
		const timestamp = Date.now();
		const responseChannel = `__Luna.trustResponse:${hash}:${timestamp}`;
		luna.tidalWindow?.webContents.send("__Luna.requestTrust", pluginName, hash, timestamp);

		// Wait for response from renderer
		const response = await new Promise<number>((resolve) => {
			// timeout after 60s to prevent hanging forever if UI fails
			const timeout = setTimeout(() => {
				electron.ipcMain.removeHandler(responseChannel);
				resolve(0); // auto-block on timeout
			}, 60000);

			electron.ipcMain.once(responseChannel, (_, result) => {
				clearTimeout(timeout);
				resolve(result);
			});
		});

		if (response === 0) {
			throw new Error(`[Luna.native] User blocked execution of native code from ${pluginName}`);
		}

		if (response === 2) {
			await saveTrustedHash(hash);
		}
	}

	// Is Trusted or Allowed Once
	const tempDir = electron.app.getPath("temp");
	const timestamp = Date.now();
	const tempFile = path.join(tempDir, `luna-legacy-${hash.substring(0, 8)}-${timestamp}.mjs`);

	// Generic shim for legacy plugins
	const shimmedCode = `
import { createRequire } from 'module'; 
import { pathToFileURL } from 'url'; 
const __nodeRequire = createRequire(pathToFileURL("${electron.app.getPath("userData").replace(/\\/g, "/")}/").href);
const require = (id) => {
    return __nodeRequire(id);
};
${nativeCode}`;

	await writeFile(tempFile, shimmedCode);

	try {
		// Use pathToFileURL for Windows compatibility with ESM import
		await import(pathToFileURL(tempFile).href);
		return null;
	} catch (err) {
		console.error(`[Luna.native] Failed to execute legacy plugin ${pluginName}`, err);
		throw err;
	}
});
// #endregion

// #endregion
