import { contextBridge, ipcRenderer, webFrame } from "electron";

import { exposeCore } from "./core/coreWorld";
import { tidalMainHosts } from "./tidalHosts";

// Support both contextIsolation: true (official Tidal) and false (tidal-hifi)
const expose = (name: string, value: any) => {
	if (process.contextIsolated) {
		contextBridge.exposeInMainWorld(name, value);
	} else {
		(window as any)[name] = value;
	}
};

// Expose platform for OS-specific plugins
expose("__platform", process.platform);

// This preload runs for every page the session loads (popups, TIDAL's crash and error pages, anything a window navigates to).
// Only TIDAL's own pages, the ones Luna loads into, get the IPC bridge: it reaches every handler in the main process
const isTidalPage = location.protocol === "https:" && tidalMainHosts.has(location.hostname);

// Luna's core world (native/core/coreWorld.ts): the page gets requests the main process answers and a filtered IPC bridge
if (isTidalPage) exposeCore();

// Luna's confirmation window opens only while TIDAL is in use (see native/core/confirmPage.ts confirmGate). Focus alone is
// not reported by every Linux window manager, so a trusted click or key in TIDAL counts too: page code can't make one.
// Leaving TIDAL ends it
if (isTidalPage) {
	let lastSent = -Infinity;
	const sawUserInput = (event: Event) => {
		if (!event.isTrusted || performance.now() - lastSent < 1000) return;
		lastSent = performance.now();
		ipcRenderer.send("__Luna.userInput", true);
	};
	for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, sawUserInput, { capture: true, passive: true });
	window.addEventListener(
		"blur",
		(event) => {
			if (!event.isTrusted || event.target !== window) return;
			lastSent = -Infinity;
			ipcRenderer.send("__Luna.userInput", false);
		},
		{ capture: true, passive: true },
	);
}

type ConsoleMethodName = {
	[K in keyof Console]: Console[K] extends (...args: any[]) => any ? K : never;
}[keyof Console];
ipcRenderer.on("__Luna.console", (_event, prop: ConsoleMethodName, args: any[]) => {
	try {
		console[prop].apply(console, args);
	} catch (e) {
		console.error("[Luna.native]", "Failed to forward console to renderer", e, args);
	}
});

// Load the luna.js renderer code and store it in window.luna.core. The checks run here (the page's IPC bridge can't reach
// these channels), the code is handed to the page
(async () => {
	if (!isTidalPage) return;
	try {
		// Check with the main process if this page was processed by Luna's HTTPS handler
		const isLunaPage = (href: string): Promise<boolean> => ipcRenderer.invoke("__Luna.isLunaPage", href);
		// A reload on any route but / is answered by Tidal's service worker, which never reaches the HTTPS handler,
		// so the page loads without Luna (e.g. Tidal's "High memory - reloading web client"). Reload at / instead and
		// put the route back before Tidal boots.
		const restoreKey = "luna.restoreRoute";
		if (!(await isLunaPage(location.href))) {
			const canRetryAtRoot = location.pathname !== "/" && sessionStorage.getItem(restoreKey) === null;
			if (canRetryAtRoot && (await isLunaPage(location.origin + "/"))) {
				console.log("[Luna.preload] Reloading at / to load Luna, then restoring:", location.href);
				sessionStorage.setItem(restoreKey, location.pathname + location.search + location.hash);
				location.replace("/");
				return;
			}
			sessionStorage.removeItem(restoreKey);
			console.log("[Luna.preload] Skipping non-Luna page:", location.href);
			return;
		}
		const restoreRoute = sessionStorage.getItem(restoreKey);
		if (restoreRoute !== null) {
			sessionStorage.removeItem(restoreKey);
			if (location.pathname === "/") history.replaceState(history.state, "", restoreRoute);
		}
		const renderJs = await ipcRenderer.invoke("__Luna.renderJs");
		// Blob urls belong to the document, so the page can import one made here
		const renderUrl = URL.createObjectURL(new Blob([renderJs], { type: "text/javascript" }));

		try {
			await webFrame.executeJavaScript(
				`(async () => {
				const originalConsole = { ...console };
				try {
					window.luna ??= {};
					window.luna.core = await import(${JSON.stringify(renderUrl)});
					window.luna.core.modules["@luna/core"] = window.luna.core;
				} catch (err) {
					setTimeout(() => {
						// Created in native/injector.ts
						const messageContainer = document.getElementById('tidaluna-loading-text');
						if (messageContainer !== null) {
							const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
							messageContainer.innerHTML += \`
							<h2>Failed to load luna.js</h2><br/>
							<span style="color: red">\${escHtml(String(err.message))}</span><br/><br/>
							<span>\${escHtml(String(err.stack))}</span>\`;
						}
					});
					err.message = "[Luna.preload] Failed to load luna.js:\\n" + err.message;
					console.error(err);
					throw err;
				} finally {
				 	// Undo any console fuckery that tidal does
					window.console = globalThis.console = console = originalConsole;
				}
			})()`,
				true,
			);
		} finally {
			URL.revokeObjectURL(renderUrl);
		}
	} catch (err) {
		ipcRenderer.invoke("__Luna.preloadErr", err);
		throw err;
	}
	console.log(`[Luna.preload] luna.js loaded!`);
})();
