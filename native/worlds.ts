// Plugin worlds: a plugin's native-facing code runs in its own isolated world, and only that world can call its natives.
//
// Page code (every plugin's render code, and anything injected into the page) shares one JS realm, so a native channel
// open to the page is open to all of it. A plugin that names a `"lunaWorld"` entry gets instead:
// - its world code and natives from `${url}.world.json` (built by build/plugins/lunaWorldPlugin.ts), fetched by the main
//   process with the plugin's code and accepted with it (core/registry.ts): only an enabled plugin's world loads, and
//   only the version the user accepted. The page only names the url, it never hands over code;
// - its natives asked for and kept like any native file, under "world:<file>" and only for world loads (worldNatives.ts),
//   so page code can't register the same code again to get a channel of its own;
// - a bridge in its world only (core/coreWorld.ts), whose plugin url is fixed by the preload: with contextIsolation,
//   renderer code can send IPC only through what the preload exposes, and the page's `__ipcRenderer` refuses the
//   "__LunaWorld.*" channels, so main trusts the url the preload puts in front of "__LunaWorld.invoke".
import { BrowserWindow } from "electron";

import { createHash } from "crypto";

import { registry } from "./core/registryMain";
import { ipcHandle } from "./ipc";
import { isIsolated } from "./isolatedContents";
import { secureLoad } from "./NativeModule/secureLoad";
import { markWorldNative, moduleOwners, worldFilePrefix } from "./NativeModule/worldNatives";
import { parseBundle } from "./worldBundle";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// A new isolated world for each load (see core/coreWorld.ts). 999 is Electron's preload world
let nextWorldId = 1001;

/** `${url}\n${fileName}` -> exports, and the accepted world text they were loaded for */
const owned = new Map<string, { exports: Record<string, unknown>; world: string }>();

const ownedKey = (url: string, fileName: string) => `${url}\n${fileName}`;

/**
 * Without contextIsolation the page shares the preload's realm and could send these channels itself, with any url:
 * worlds need it (the preload refuses them there too, see core/coreWorld.ts)
 */
const checkIsolated = (sender: Electron.WebContents) => {
	if (!isIsolated(sender)) throw new Error("[🛑Security🛑] Plugin worlds need contextIsolation");
};

ipcHandle("__LunaWorld.load", async (event, url: unknown) => {
	checkIsolated(event.sender);
	if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error(`[Luna.worlds] Not a plugin url: ${String(url)}`);
	const accepted = registry().acceptedWorld(url);
	if (accepted === undefined) throw new Error(`[🛑Security🛑] ${url} is not an enabled plugin with a world`);
	const bundle = parseBundle(accepted);
	// A world's natives can't take a native module name Luna or another plugin registered (others import them by name)
	for (const fileName of Object.keys(bundle.natives)) {
		if (globalThis.luna.modules[fileName] !== undefined && moduleOwners.get(fileName) !== url)
			throw new Error(`[🛑Security🛑] ${url}: native module ${fileName} is already registered by Luna or another plugin`);
	}
	// Reserved now, before any wait: a page native registering the same name meanwhile is refused (NativeModule/index.ts)
	for (const fileName of Object.keys(bundle.natives)) moduleOwners.set(fileName, url);

	// Natives of an earlier load of this url can't be called any more, whatever happens below
	for (const key of owned.keys()) if (key.startsWith(`${url}\n`)) owned.delete(key);

	// The answer for a native covers the world code too: the world decides what its natives are called with
	const worldHash = sha256(bundle.code);
	const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
	for (const [fileName, code] of Object.entries(bundle.natives)) {
		const nativeHash = sha256(code);
		markWorldNative(nativeHash);
		const exports = await secureLoad(
			{ fileName: worldFilePrefix + fileName, code, hash: sha256(`${code}\0${worldHash}`), url, isCore: false, world: { nativeHash } },
			parent,
		);
		owned.set(ownedKey(url, fileName), { exports, world: accepted });
		// Other plugins' natives may import it, as they can any native module (see build/plugins/lunaNativePlugin.ts)
		globalThis.luna.modules[fileName] = exports;
	}

	return { worldId: nextWorldId++, code: bundle.code };
});

ipcHandle("__LunaWorld.invoke", async (event, url: unknown, fileName: unknown, exportName: unknown, ...args: unknown[]) => {
	checkIsolated(event.sender);
	const entry = typeof url === "string" && typeof fileName === "string" ? owned.get(ownedKey(url, fileName)) : undefined;
	if (entry === undefined) throw new Error(`[🛑Security🛑] ${String(url)} has no native file ${String(fileName)}`);
	// Disabled, or an update accepted since its world loaded: the old world's natives stop until the new one loads
	if (registry().acceptedWorld(url as string) !== entry.world)
		throw new Error(`[🛑Security🛑] ${String(url)} is not enabled at the version its world loaded`);
	const { exports } = entry;
	const fn = typeof exportName === "string" && Object.hasOwn(exports, exportName) ? exports[exportName] : undefined;
	if (typeof fn !== "function") throw new Error(`[Luna.worlds] ${fileName} has no export ${String(exportName)}`);
	try {
		return await fn(...args);
	} catch (err) {
		if (typeof err === "object" && err !== null) (err as { cause?: unknown }).cause = `[Luna.worlds] (${fileName}).${exportName}`;
		throw err;
	}
});
