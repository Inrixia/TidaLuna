/**
 * Whether new code fetched for a plugin waits for the user (LunaPlugin.acceptUpdate) instead of replacing the code that runs.
 * Dev plugins, live reload (the user asked for every change) and Luna's own plugins update without asking,
 * and a plugin without stored code (first install) has nothing else to run.
 */
export const updateWaitsForUser = (plugin: {
	codeChanged: boolean;
	hasCode: boolean;
	isDev: boolean;
	liveReload: boolean;
	isCore: boolean;
}): boolean => plugin.codeChanged && plugin.hasCode && !plugin.isDev && !plugin.liveReload && !plugin.isCore;

/**
 * A dev plugin is served from this machine (`slot.mjs serve`, `pnpm watch`): http on host 127.0.0.1, any port.
 * Checked by host, not by prefix, so `http://127.0.0.1.example.com` or `http://127.0.0.1@example.com` don't count (dev plugins skip the update prompt).
 */
export const isDevUrl = (url: string): boolean => {
	try {
		const { protocol, hostname } = new URL(url);
		return protocol === "http:" && hostname === "127.0.0.1";
	} catch {
		return false;
	}
};

/**
 * The text LunaPlugin.loadExports imports for a plugin's code.
 * Native code registering names the plugin's url, so its permissions are kept per plugin (see native/NativeModule/trust.ts).
 * Only the call build/plugins/lunaNativePlugin.ts emits, not the same text inside a native file's code string.
 */
export const codeToImport = (code: string, url: string): string =>
	code.replace(
		/(__ipcRenderer\.invoke\(\s*)(["'`])__Luna\.registerNative\2\s*,/g,
		(_, call) => `${call}"__Luna.registerNativeFrom",${JSON.stringify(url)},`,
	);

/** sha256 of the text as UTF-8, lowercase hex */
export const sha256Hex = async (text: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
