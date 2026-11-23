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
 * Names of the native files a plugin bundle registers (the call build/plugins/lunaNativePlugin.ts emits, as LunaPlugin.loadExports finds it).
 * For display only: the native permission window (native/NativeModule/trust.ts) still checks each file's code before it runs.
 * native/NativeModule/permissions/verifySource.ts nativeFilesOf reads the same call, but needs Node's vm and crypto, which the renderer lacks.
 */
export const nativeFileNames = (code: string): string[] => {
	const names = new Set<string>();
	for (const match of code.matchAll(/__ipcRenderer\.invoke\(\s*(["'`])__Luna\.registerNative\1\s*,\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2\s*,/g)) {
		names.add(match[3].replace(/\\(.)/g, "$1"));
	}
	return [...names];
};

/** The native files of an update, and which of them it adds or removes compared to the code that runs now */
export const nativeFileChanges = (currentCode: string, updateCode: string): { files: string[]; added: string[]; removed: string[] } => {
	const before = nativeFileNames(currentCode);
	const files = nativeFileNames(updateCode);
	return {
		files,
		added: files.filter((name) => !before.includes(name)),
		removed: before.filter((name) => !files.includes(name)),
	};
};
