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
import { secureLoad } from "./NativeModule/secureLoad";
import { markWorldNative, worldFilePrefix } from "./NativeModule/worldNatives";
import { parseBundle } from "./worldBundle";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// One isolated world per plugin url for the life of the process. 999 is Electron's preload world
const worldIds = new Map<string, number>();
let nextWorldId = 1001;

/** `${url}\n${fileName}` -> exports */
const owned = new Map<string, Record<string, unknown>>();
/** luna.modules name -> url of the world that put it there */
const moduleOwners = new Map<string, string>();
const ownedKey = (url: string, fileName: string) => `${url}\n${fileName}`;

ipcHandle("__LunaWorld.load", async (event, url: unknown) => {
	if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error(`[Luna.worlds] Not a plugin url: ${String(url)}`);
	const accepted = registry().acceptedWorld(url);
	if (accepted === undefined) throw new Error(`[🛑Security🛑] ${url} is not an enabled plugin with a world`);
	const bundle = parseBundle(accepted);

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
		owned.set(ownedKey(url, fileName), exports);
		// Other plugins' natives may import it, as they can any native module (see build/plugins/lunaNativePlugin.ts)
		if (globalThis.luna.modules[fileName] !== undefined && moduleOwners.get(fileName) !== url)
			console.warn(`[Luna.worlds] ${url} replaces native module ${fileName} that another load registered`);
		globalThis.luna.modules[fileName] = exports;
		moduleOwners.set(fileName, url);
	}

	let worldId = worldIds.get(url);
	if (worldId === undefined) worldIds.set(url, (worldId = nextWorldId++));
	return { worldId, code: bundle.code };
});

ipcHandle("__LunaWorld.invoke", async (_event, url: unknown, fileName: unknown, exportName: unknown, ...args: unknown[]) => {
	const exports = typeof url === "string" && typeof fileName === "string" ? owned.get(ownedKey(url, fileName)) : undefined;
	if (exports === undefined) throw new Error(`[🛑Security🛑] ${String(url)} has no native file ${String(fileName)}`);
	// Disabled since its world loaded
	if (!registry().isEnabled(url as string)) throw new Error(`[🛑Security🛑] ${String(url)} is not enabled`);
	const fn = typeof exportName === "string" && Object.hasOwn(exports, exportName) ? exports[exportName] : undefined;
	if (typeof fn !== "function") throw new Error(`[Luna.worlds] ${fileName} has no export ${String(exportName)}`);
	try {
		return await fn(...args);
	} catch (err) {
		if (typeof err === "object" && err !== null) (err as { cause?: unknown }).cause = `[Luna.worlds] (${fileName}).${exportName}`;
		throw err;
	}
});
