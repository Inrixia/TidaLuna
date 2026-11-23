/**
 * Names of the native files a plugin bundle registers (the call build/plugins/lunaNativePlugin.ts emits, as LunaPlugin.loadExports finds it).
 * For display only: the native permission window (native/NativeModule/trust.ts) still checks each file's code before it runs.
 */
export const nativeFileNames = (code: string): string[] => {
	const names = new Set<string>();
	for (const match of code.matchAll(/__ipcRenderer\.invoke\(\s*(["'`])__Luna\.registerNative\1\s*,\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2\s*,/g)) {
		names.add(match[3].replace(/\\(.)/g, "$1"));
	}
	return [...names];
};
