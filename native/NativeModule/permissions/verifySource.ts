import { createHash } from "crypto";
import { net } from "electron";
import vm from "vm";

/**
 * Reads the string literal (', " or a template without ${...}) that starts at `start`, after any whitespace.
 * Returns its value and where it ends, or undefined if there is none.
 */
const readLiteral = (text: string, start: number): { value: string; end: number } | undefined => {
	let i = start;
	while (/\s/.test(text[i] ?? "")) i++;
	const quote = text[i];
	if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
	for (let j = i + 1; j < text.length; j++) {
		const char = text[j];
		if (char === "\\") {
			j++;
			continue;
		}
		if (quote === "`" && char === "$" && text[j + 1] === "{") return undefined;
		if (char !== quote) continue;
		// A single literal token, so evaluating it runs no code
		const value = vm.runInNewContext(text.slice(i, j + 1), Object.create(null), { timeout: 1000 });
		return typeof value === "string" ? { value, end: j + 1 } : undefined;
	}
	return undefined;
};

const sha256 = (code: string) => createHash("sha256").update(code, "utf8").digest("hex");

/** The native files the bundle registers (see build/plugins/lunaNativePlugin.ts): fileName -> code hash */
export const nativeFilesOf = (bundle: string): Map<string, string> =>
	new Map([...nativeSourcesOf(bundle)].map(([fileName, code]) => [fileName, sha256(code)]));

/** The native files the bundle registers (see build/plugins/lunaNativePlugin.ts): fileName -> code */
export const nativeSourcesOf = (bundle: string): Map<string, string> => {
	const files = new Map<string, string>();
	// The call build/plugins/lunaNativePlugin.ts emits (as LunaPlugin.loadExports finds it)
	for (const match of bundle.matchAll(/__ipcRenderer\.invoke\(\s*(["'`])__Luna\.registerNative\1\s*,/g)) {
		const fileName = readLiteral(bundle, match.index + match[0].length);
		if (fileName === undefined || bundle.slice(fileName.end).trimStart()[0] !== ",") continue;
		const code = readLiteral(bundle, bundle.indexOf(",", fileName.end) + 1);
		if (code !== undefined) files.set(fileName.value, code.value);
	}
	return files;
};

const checked = new Map<string, Promise<boolean>>();
/**
 * True if `${url}.mjs` registers this exact native code under this file name.
 * The url comes from the renderer, where any plugin could claim another plugin's url; answers that hold across
 * updates are only given to code that the url really serves.
 */
export const verifySource = (url: string, fileName: string, hash: string): Promise<boolean> => {
	const key = `${url}::${fileName}::${hash}`;
	let result = checked.get(key);
	if (result === undefined) {
		result = (async () => {
			try {
				if (!/^https?:\/\//.test(url)) return false;
				const res = await net.fetch(`${url}.mjs`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
				if (!res.ok) return false;
				return nativeFilesOf(await res.text()).get(fileName) === hash;
			} catch (err) {
				console.warn(`[🛑Security🛑] Could not check that '${fileName}' comes from ${url}`, err);
				return false;
			}
		})();
		checked.set(key, result);
		// A failed check (e.g. offline) may succeed later
		result.then((ok) => ok || checked.delete(key));
	}
	return result;
};
