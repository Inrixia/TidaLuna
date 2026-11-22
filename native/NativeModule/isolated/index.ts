import electron from "electron";
import path from "path";
import { fileURLToPath } from "url";

import type { NativeModuleInfo } from "..";
import { callSync, hostModules } from "./syncModules";

type NativeExports = Record<string, (...args: unknown[]) => Promise<unknown>>;
type LoadResult = { exportNames: unknown } | { error: string };
type Host = {
	exportNames: string[];
	call: (exportName: string, args: unknown[]) => Promise<unknown>;
	stop: (reason: Error) => void;
	/** Its process died on its own (not stopped from here) */
	crashed: () => boolean;
	/** Number of the load that started it (see `lastLoad`) */
	load: number;
};

// Built next to injector.mjs. Read from the injector's own folder, not TIDALUNA_DIST_PATH (like coreNatives.ts).
const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "nativeHost.preload.mjs");
/** Seconds a host has to load its code */
const loadTimeout = 10;

/**
 * Native files named `*.isolated.native.*` are loaded by `isolatedLoad` instead of `secureLoad`.
 * Only files that renderer code imports and that are not the plugin's main entry: the main entry is registered under
 * the package name, and a file imported by another native file is bundled into that file (see build/plugins/lunaNativePlugin.ts).
 */
export const isIsolatedNative = (fileName: string) => /\.isolated\.native\.[a-z]+$/.test(fileName);

let hostSession: Promise<Electron.Session> | undefined;
// In-memory session only hosts use: none of TIDAL's cookies, preloads or protocol handlers, and no way out to the network
const getHostSession = () =>
	(hostSession ??= (async () => {
		const ses = electron.session.fromPartition("luna-native-host");
		ses.webRequest.onBeforeRequest((_, callback) => callback({ cancel: true }));
		ses.setPermissionRequestHandler((_, __, callback) => callback(false));
		ses.setPermissionCheckHandler(() => false);
		ses.on("will-download", (event) => event.preventDefault());
		// WebRTC is not seen by webRequest. Hosts may only use it through the proxy (see setWebRTCIPHandlingPolicy below), and nothing listens there.
		await ses.setProxy({ proxyRules: "http://127.0.0.1:1", proxyBypassRules: "<-loopback>" });
		return ses;
	})());

const consoleLevels = { info: "log", warning: "warn", error: "error", debug: "debug" } as const;
const legacyConsoleLevels = ["debug", "log", "warn", "error"] as const;

// An Error thrown by isolated code arrives as plain data (see host.preload.ts)
const toError = (thrown: unknown) => {
	const { name, message, stack } = Object(thrown) as Record<string, unknown>;
	const err = new Error(String(message));
	if (typeof name === "string") err.name = name;
	if (typeof stack === "string") err.stack = stack;
	return err;
};

// Views of the hosts that are loading or running: a view nothing refers to is garbage collected together with its page
const views = new Set<Electron.WebContentsView>();
// fileName -> the host that currently runs it
const hosts = new Map<string, Host>();
// fileName -> number of the load asked for last. Loads finish in any order, the one asked for last has to win.
// A load that is not the last one any more is given up (see startHost): whoever asked last gets the answer.
const lastLoad = new Map<string, number>();
// fileName -> number of the load whose host served the file last, running or died
const served = new Map<string, number>();
// Load numbers are never given out twice: a load that was given up must not match `lastLoad` again later
let loads = 0;

/** Thrown for a load that a later load of the same file has replaced. Nothing failed: the later load decides. */
export class LoadedAgain extends Error {
	constructor(fileName: string) {
		super(`Native module '${fileName}' was loaded again`);
	}
}

/** Stops the process that runs `fileName`, if any */
export const stopIsolated = (fileName: string) => hosts.get(fileName)?.stop(new LoadedAgain(fileName));

/** @param restartOf Load number of a host whose process died: its restart is the same load, so it never outranks a later one */
const startHost = async (moduleInfo: NativeModuleInfo, restartOf?: number): Promise<Host> => {
	const { fileName } = moduleInfo;
	const before = lastLoad.get(fileName) ?? 0;
	const load = restartOf ?? ++loads;
	lastLoad.set(fileName, Math.max(load, before));
	try {
		return await loadHost(moduleInfo, load);
	} catch (err) {
		if (lastLoad.get(fileName) !== load) throw new LoadedAgain(fileName);
		// This load was the last asked for and failed: what served the file before it is current again (and may restart)
		lastLoad.set(fileName, served.get(fileName) ?? 0);
		throw err;
	}
};

const loadHost = async ({ fileName, code }: NativeModuleInfo, load: number): Promise<Host> => {
	// Read from the default export: a named import of something this Electron lacks would stop the injector from loading
	if (typeof electron.WebContentsView !== "function") throw new Error(`Isolated native code ('${fileName}') needs Electron 30 or newer`);

	const session = await getHostSession();
	const view = new electron.WebContentsView({
		webPreferences: {
			preload,
			session,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			backgroundThrottling: false,
		},
	});
	views.add(view);
	const { webContents } = view;

	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
	let nextId = 0;
	let stopped: Error | undefined;
	let crashed = false;
	let failLoad = (_: Error) => {};
	const stop = (reason: Error) => {
		if (stopped !== undefined) return;
		stopped = reason;
		failLoad(reason);
		for (const { reject } of pending.values()) reject(reason);
		pending.clear();
		views.delete(view);
		if (hosts.get(fileName) === host) hosts.delete(fileName);
		if (!webContents.isDestroyed()) webContents.close({ waitForBeforeUnload: false });
	};
	const gone = (reason: string) => {
		if (stopped !== undefined) return;
		crashed = true;
		stop(new Error(`Process of native module '${fileName}' is gone (${reason})`));
	};

	const host: Host = {
		exportNames: [],
		load,
		call: (exportName, args) =>
			new Promise<unknown>((resolve, reject) => {
				if (stopped !== undefined) return reject(stopped);
				const id = nextId++;
				pending.set(id, { resolve, reject });
				try {
					webContents.send("__LunaNativeHost.call", id, exportName, args);
				} catch (err) {
					pending.delete(id);
					reject(err);
				}
			}),
		stop,
		crashed: () => crashed,
	};

	webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
	webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	webContents.on("will-navigate", (event) => event.preventDefault());
	webContents.on("render-process-gone", (_, { reason }) => gone(reason));
	webContents.once("destroyed", () => gone("destroyed"));
	// Electron 35+ has level and message on the event, older versions pass them (level as a number) after it
	webContents.on("console-message", (event, ...legacy: unknown[]) => {
		const level = typeof legacy[0] === "number" ? legacyConsoleLevels[legacy[0]] : consoleLevels[event.level];
		console[level ?? "log"](`(${fileName})`, typeof legacy[1] === "string" ? legacy[1] : event.message);
	});

	webContents.ipc.on("__LunaNativeHost.callSync", (event, moduleName, fn, args) => {
		event.returnValue = callSync(moduleName, fn, args);
	});
	webContents.ipc.on("__LunaNativeHost.result", (_, id, ok, value, isError) => {
		const call = pending.get(id);
		if (call === undefined) return;
		pending.delete(id);
		if (ok === true) call.resolve(value);
		else call.reject(isError === true ? toError(value) : value);
	});

	const exportNames = new Promise<string[]>((resolve, reject) => {
		// Counted in ticks, not on the clock: a trust prompt blocks this process for as long as the user reads it,
		// and afterwards the answer of a host that loaded long ago is still waiting behind the timer.
		let ticks = 0;
		const timer = setInterval(() => {
			if (++ticks >= loadTimeout) stop(new Error(`Native module '${fileName}' did not load in ${loadTimeout}s`));
		}, 1000);
		failLoad = (err) => {
			clearInterval(timer);
			reject(err);
		};
		webContents.ipc.handle("__LunaNativeHost.init", () => ({ fileName, code, modules: hostModules }));
		webContents.ipc.handle("__LunaNativeHost.loaded", (_, result: LoadResult) => {
			if ("error" in result) return stop(new Error(String(result.error)));
			clearInterval(timer);
			resolve(Array.isArray(result.exportNames) ? result.exportNames.filter((name) => typeof name === "string") : []);
		});
		webContents.loadURL("about:blank").catch(stop);
	});

	const loadedAgain = new LoadedAgain(fileName);
	host.exportNames = await exportNames;
	if (lastLoad.get(fileName) !== load) {
		stop(loadedAgain);
		throw loadedAgain;
	}
	// Only now that the new code runs: a load that fails leaves the host that ran this file before working
	hosts.get(fileName)?.stop(loadedAgain);
	hosts.set(fileName, host);
	served.set(fileName, load);
	return host;
};

/**
 * Runs native code in its own sandboxed renderer process instead of the main process. The code gets no Node or Electron:
 * `require` only knows the modules in ./syncModules.ts, everything else is what a web page has, without network.
 * The process is identified by its webContents, so nothing it sends can make it act as another module.
 * Loading a `fileName` again stops the process that ran it before.
 */
export const isolatedLoad = async (moduleInfo: NativeModuleInfo): Promise<NativeExports> => {
	const { fileName } = moduleInfo;
	let host = await startHost(moduleInfo);
	let restart: Promise<Host> | undefined;

	// No prototype: the export name comes from the renderer and must not find Object.prototype's functions
	const exports: NativeExports = Object.create(null);
	for (const exportName of host.exportNames) {
		exports[exportName] = async (...args) => {
			// A process that died is started again by the next call, unless a new load of the file has been asked for since.
			// What the module kept in memory is lost.
			if (host.crashed() && lastLoad.get(fileName) === host.load) {
				host = await (restart ??= startHost(moduleInfo, host.load).finally(() => (restart = undefined)));
			}
			return host.call(exportName, args);
		};
	}
	return exports;
};
