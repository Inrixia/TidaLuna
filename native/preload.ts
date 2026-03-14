import { unloadableEmitter, type AnyFn } from "@inrixia/helpers";

import { contextBridge, ipcRenderer, webFrame } from "electron";

const ipcRendererUnloadable = unloadableEmitter(ipcRenderer, null, "ipcRenderer");

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

// Allow render side to execute invoke
expose("__ipcRenderer", {
	invoke: ipcRenderer.invoke,
	send: ipcRenderer.send,
	on: (channel: string, listener: AnyFn) => ipcRendererUnloadable.onU(null, channel, (_, ...args) => listener(...args)),
	once: (channel: string, listener: AnyFn) => ipcRendererUnloadable.onceU(null, channel, (_, ...args) => listener(...args)),
});

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

// Load the luna.js renderer code and store it in window.luna.core
(async () => {
	try {
		await webFrame.executeJavaScript(
			`(async () => {
				// Check with the main process if this page was processed by Luna's HTTPS handler
				const isLunaPage = await __ipcRenderer.invoke("__Luna.isLunaPage", location.href);
				if (!isLunaPage) {
					console.log("[Luna.preload] Skipping non-Luna page:", location.href);
					return;
				}

				const originalConsole = { ...console };
				try {
					const renderJs = await __ipcRenderer.invoke("__Luna.renderJs");
					const renderUrl = URL.createObjectURL(new Blob([renderJs], { type: "text/javascript" }));
					window.luna ??= {};
					window.luna.core = await import(renderUrl);
					window.luna.core.modules["@luna/core"] = window.luna.core;
				} catch (err) {
					setTimeout(() => {
						// Created in native/injector.ts
						const messageContainer = document.getElementById('tidaluna-loading-text');
						if (messageContainer !== null) {
							messageContainer.innerHTML += \`
							<h2>Failed to load luna.js</h2><br/>
							<span style="color: red">\${err.message}</span><br/><br/>
							<span>\${err.stack}</span>\`;
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
	} catch (err) {
		ipcRenderer.invoke("__Luna.preloadErr", err);
		throw err;
	}
	console.log(`[Luna.preload] luna.js loaded!`);
})();
