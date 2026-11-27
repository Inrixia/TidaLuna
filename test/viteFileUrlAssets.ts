import { readFile } from "fs/promises";
import path from "path";

import type { Plugin } from "vitest/config";

const fileUrlPrefix = "file://";
const virtualPrefix = "\0luna-file-url:";

/**
 * `file://` imports as the build's fileUrl plugin understands them: `import svg from "file://assets/logo.svg?base64"`
 * evaluates to the file's contents, base64 encoded when `?base64` is asked for. esbuild handles that during a build, so
 * without this vitest could not import a module that inlines an asset.
 */
export const viteFileUrlAssets = (): Plugin => ({
	name: "luna-file-url-assets",
	enforce: "pre",
	resolveId(source, importer) {
		// `file:///C:/...` is an absolute URL the runtime resolves itself, only a relative `file://path` is an asset of ours
		if (!source.startsWith(fileUrlPrefix) || source.startsWith("file:///")) return;
		const [rawPath, query] = source.slice(fileUrlPrefix.length).split("?", 2);
		const resolvedPath = path.resolve(importer === undefined ? process.cwd() : path.dirname(importer), rawPath);
		return virtualPrefix + resolvedPath + "?" + (query ?? "");
	},
	async load(id) {
		if (!id.startsWith(virtualPrefix)) return;
		const [filePath, query = ""] = id.slice(virtualPrefix.length).split("?", 2);
		const base64 = new URLSearchParams(query).has("base64");
		const contents = await readFile(filePath, base64 ? "base64" : "utf-8");
		return { code: `export default ${JSON.stringify(contents.trimEnd())};`, map: null };
	},
});
