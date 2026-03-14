import electron from "electron";

import { readFile } from "fs/promises";
import mime from "mime";

import path from "path";
import { fileURLToPath } from "url";

import Module, { createRequire } from "module";

import { ipcHandle } from "./ipc";

const fontUrlRegex = /\.(woff2?|ttf|otf|eot)(\?.*)?$/i;

// #region Bundle
const bundleDir = process.env.TIDALUNA_DIST_PATH ?? path.dirname(fileURLToPath(import.meta.url));
const tidalAppPath = path.join(process.resourcesPath, "original.asar");
const tidalPackagePromise = readFile(path.join(tidalAppPath, "package.json"), "utf8").then(JSON.parse);
// #endregion

// Allow debugging from remote origins (e.g., Chrome DevTools over localhost)
// Requires starting client with --remote-debugging-port=9222
electron.app.commandLine.appendSwitch("remote-allow-origins", "http://localhost:9222");

// Linux sandbox fixes - must run BEFORE app is ready
if (process.platform === "linux") {
	// Zygote causes sandbox initialization failures on some Linux configurations
	electron.app.commandLine.appendSwitch("no-zygote");

	// Match tidal-hifi's .desktop StartupWMClass so GNOME/KDE shows the correct dock icon
	// --class works for X11, CHROME_DESKTOP sets the Wayland app_id
	electron.app.commandLine.appendSwitch("class", "tidal-hifi");
	electron.app.name = "tidal-hifi";
	process.env.CHROME_DESKTOP = "tidal-hifi.desktop";

	// tidal-hifi settings access for Linux integration
	ipcHandle("__Luna.getTidalHifiSetting", async (_, key: string) => {
		try {
			const configPath = path.join(electron.app.getPath("userData"), "config.json");
			const config = JSON.parse(await readFile(configPath, "utf8"));
			// Support nested keys like "discord.showSong"
			return key.split(".").reduce((obj, k) => obj?.[k], config);
		} catch {
			return undefined;
		}
	});

	// tidal-hifi theme file reading
	ipcHandle("__Luna.getTidalHifiThemeCSS", async (_, themeName: string) => {
		if (!themeName || themeName === "none") return undefined;
		const themesDir = path.join(electron.app.getPath("userData"), "themes");
		const userPath = path.join(themesDir, themeName);
		if (!userPath.startsWith(themesDir)) throw new Error(`[🛑Security🛑] Path traversal blocked: ${themeName}`);
		const resourcesDir = process.resourcesPath;
		const resourcesPath = path.join(resourcesDir, themeName);
		if (!resourcesPath.startsWith(resourcesDir)) throw new Error(`[🛑Security🛑] Path traversal blocked: ${themeName}`);
		try {
			return await readFile(userPath, "utf8");
		} catch {
			try {
				return await readFile(resourcesPath, "utf8");
			} catch {
				return undefined;
			}
		}
	});
}

const bundleFile = async (url: string): Promise<[Buffer, ResponseInit]> => {
	const fileName = url.slice(13);
	const filePath = path.join(bundleDir, fileName);
	if (!filePath.startsWith(bundleDir)) throw new Error(`[🛑Security🛑] Path traversal blocked: ${fileName}`);
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

// #region HTTPS Handler
const tidalMainHosts = new Set(["listen.tidal.com", "tidal.com", "desktop.tidal.com", "stage.tidal.com"]);
const lunaPages = new Set<string>();
ipcHandle("__Luna.isLunaPage", async (_, href: string) => lunaPages.has(new URL(href).origin + new URL(href).pathname));
let httpsHandlerActive = false;

const httpsHandler = async (req: Request): Promise<Response> => {
	if (req.url.startsWith("https://luna/")) {
		try {
			// @ts-expect-error: Buffer is valid for Response body
			return new Response(...(await bundleFile(req.url)));
		} catch (err: any) {
			return new Response(err.message, { status: err.message.startsWith("ENOENT") ? 404 : 500, statusText: err.message });
		}
	}

	// Bypass CSP & Mark meta scripts for quartz injection on Tidal main pages
	const reqUrl = new URL(req.url);
	if (tidalMainHosts.has(reqUrl.hostname) && !path.extname(reqUrl.pathname)) {
		const res = await electron.net.fetch(req, { bypassCustomProtocolHandlers: true });
		const contentType = res.headers.get("content-type") ?? "";
		if (!contentType.includes("text/html")) return res;
		let body = await res.text();
		// Only modify the Tidal SPA shell (contains CSP meta tag)
		if (!body.includes('<meta http-equiv="Content-Security-Policy"')) return new Response(body, res);
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
		lunaPages.add(reqUrl.origin + reqUrl.pathname);
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
	try {
		return await electron.net.fetch(req, { bypassCustomProtocolHandlers: true });
	} catch (err: any) {
		console.error(`[HTTPS] Fetch error for ${req.url}:`, err.message);
		throw err;
	}
};

const registerHttpsHandler = () => {
	try {
		electron.protocol.handle("https", httpsHandler);
	} catch {
		// Handler might already be registered
	}
	httpsHandlerActive = true;
};

const unregisterHttpsHandler = () => {
	try {
		electron.protocol.unhandle("https");
	} catch {
		// Handler might not be registered
	}
	httpsHandlerActive = false;
};

// Ensure app is ready
electron.app.whenReady().then(async () => {
	// Register the HTTPS handler
	registerHttpsHandler();

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

		const platformIsLinux = process.platform === "linux";

		// Check if this is the main Tidal window
		// tidal-hifi does not set the title, rely on dev tools instead.
		const isTidalWindow = options.title === "TIDAL" || options.webPreferences?.devTools;

		if (isTidalWindow) {
			if (platformIsLinux) {
				// Linux (tidal-hifi): Replace preload
				options.webPreferences.preload = path.join(bundleDir, "preload.mjs");
			} else {
				// Windows/macOS (TIDAL official): Add Luna preload via session
				const lunaPreload = path.join(bundleDir, "preload.mjs");
				if (typeof electron.session.defaultSession.registerPreloadScript === "function") {
					// Electron 35+: Use new API
					electron.session.defaultSession.registerPreloadScript({
						type: "frame",
						filePath: lunaPreload,
					});
				} else {
					// Electron < 35: Use legacy setPreloads API
					const existingPreloads = electron.session.defaultSession.getPreloads();
					electron.session.defaultSession.setPreloads([...existingPreloads, lunaPreload]);
				}
			}

			// Sandbox isolates plugins from Node.js and system access
			options.webPreferences.sandbox = true;
			options.webPreferences.contextIsolation = true;
		}

		const window = new target(options);

		globalThis.luna.sendToRender = window.webContents.send.bind(window.webContents);

		// Linux (tidal-hifi): Handle OAuth login in a popup window
		if (platformIsLinux) {
			let loginWindow: electron.BrowserWindow | null = null;
			let authCallbackPending = false;

			window.webContents.on("will-navigate", (event, url) => {
				if (!url.startsWith("https://login.tidal.com/authorize")) return;

				event.preventDefault();
				if (loginWindow) {
					loginWindow.loadURL(url);
					loginWindow.show();
					return;
				}

				loginWindow = new electron.BrowserWindow({
					width: 600,
					height: 700,
					backgroundColor: "#151a22",
					webPreferences: {
						contextIsolation: true,
						nodeIntegration: false,
						session: electron.session.defaultSession,
					},
				});
				loginWindow.setMenuBarVisibility(false);

				unregisterHttpsHandler();
				loginWindow.loadURL(url);

				loginWindow.on("closed", () => {
					loginWindow = null;
					if (!authCallbackPending) registerHttpsHandler();
				});

				loginWindow.webContents.on("will-redirect", (event, redirectUrl) => {
					const navUrl = new URL(redirectUrl);
					if (!tidalMainHosts.has(navUrl.hostname)) return;
					if (!navUrl.pathname.startsWith("/login/auth")) return;
					if (!navUrl.searchParams.has("code")) return;

					event.preventDefault();
					authCallbackPending = true;
					loginWindow?.destroy();
					loginWindow = null;
					registerHttpsHandler();

					// Trigger SPA navigation without page reload
					const authPath = navUrl.pathname + navUrl.search;
					window.webContents.executeJavaScript(`
						window.history.pushState({}, "", ${JSON.stringify(authPath)});
						window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
					`);
					authCallbackPending = false;
				});
			});
		}

		// Allow opening dev tools with F12 without interfering with Tidal's own shortcuts (e.g., Ctrl+Shift+I)
		window.webContents.on("before-input-event", (event, input) => {
			if (input.key === "F12") {
				window.webContents.toggleDevTools();
				event.preventDefault();
			}
		});

		// Notify renderer to unload plugins before window closes (but not when minimizing to tray)
		window.on("close", (event) => {
			// Use setImmediate to check after other handlers have run
			// If defaultPrevented is true, it's a close-to-tray, so skip unloading plugins
			setImmediate(() => {
				if (!event.defaultPrevented) {
					try {
						window.webContents.send("window.close");
					} catch {
						// Window might already be destroyed
					}
				}
			});
		});

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
		let rendererAlive = true;
		window.webContents.on("render-process-gone", (_, details) => {
			rendererAlive = false;
			_console.error(consolePrefix, `Renderer process gone: ${details.reason}`);
		});
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
						// Send the log data to the renderer process (if still alive)
						if (rendererAlive && !window.isDestroyed() && !window.webContents.isDestroyed()) {
							try {
								window.webContents.send("__Luna.console", prop.toString(), args);
							} catch (e) {
								_console.error(consolePrefix, "Failed to forward console to renderer", e);
							}
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

const tidalPackage = await tidalPackagePromise;
const startPath = path.join(tidalAppPath, tidalPackage.main);

// @ts-expect-error This exists?
electron.app.setAppPath?.(tidalAppPath);
electron.app.setName(tidalPackage.name);

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
import "./NativeModule";
// #endregion

// Literally just to log if preload fails
ipcHandle("__Luna.preloadErr", async (_, err: Error) => {
	console.error(err);
	electron.dialog.showErrorBox("TidaLuna", err.message);
});
