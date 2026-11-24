import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { fileUrlPlugin } from "./fileUrl";

/**
 * `fileUrlPlugin` makes `import content from "file://some/file.css?minify"` give the file's contents as a string.
 * The path after `file://` is resolved relative to the importing module (not the entry point), `?minify` runs
 * clean-css / html-minifier-terser and `?base64` encodes the bytes.
 *
 * Fixtures live in a temp dir per test, nothing is written into the repo. Every build gets its own directory and
 * outfile, and the bundle is evaluated, so these assert the value a plugin author really gets back.
 */

let dir: string;
let builds = 0;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-fileurl-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * Write `files` (path relative to the build root -> contents) into a fresh build dir, bundle `entry` with the plugin
 * and evaluate the result.
 */
const buildFiles = async (files: Record<string, string | Uint8Array>, entry = "entry.ts"): Promise<any> => {
	const root = path.join(dir, `build-${builds++}`);
	for (const [relativePath, contents] of Object.entries(files)) {
		const file = path.join(root, relativePath);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, contents);
	}
	const outfile = path.join(root, "bundle.mjs");
	await build({
		entryPoints: [path.join(root, entry)],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		logLevel: "silent",
		plugins: [fileUrlPlugin],
	});
	return import(pathToFileURL(outfile).href);
};

/** The value of `import content from "<uri>"`, which is what a plugin's code receives */
const importFile = async (uri: string, files: Record<string, string | Uint8Array> = {}) => {
	const { default: content } = await buildFiles({ ...files, "entry.ts": `import content from "${uri}";\nexport default content;` });
	return content;
};

const css = "/* a comment */\nbody {\n\tcolor: red;\n}\n";
const html =
	"<!DOCTYPE html>\n<html>\n\t<head>\n\t\t<!-- a comment -->\n\t\t<title>My Page</title>\n\t</head>\n\t<body>\n\t\t<p>hi</p>\n\t</body>\n</html>\n";

describe("fileUrlPlugin", () => {
	test("a plain file:// import is the file contents with trailing whitespace trimmed", async () => {
		// Leading whitespace is content, trailing whitespace is not
		expect(await importFile("file://data.txt", { "data.txt": "  hello world  \n\n" })).toBe("  hello world");
	});

	test("any file type is read as text when it is not being minified", async () => {
		expect(await importFile("file://notes.txt", { "notes.txt": "raw notes\n" })).toBe("raw notes");
	});

	test("the path is resolved relative to the importing module, not the entry point", async () => {
		const { default: content } = await buildFiles({
			"data.txt": "from the root",
			"nested/data.txt": "from nested",
			"nested/loader.ts": 'import content from "file://data.txt";\nexport default content;',
			"entry.ts": 'import content from "./nested/loader.ts";\nexport default content;',
		});
		expect(content).toBe("from nested");
	});

	test("?minify runs clean-css on css", async () => {
		expect(await importFile("file://styles.css", { "styles.css": css })).toContain("/* a comment */");
		expect(await importFile("file://styles.css?minify", { "styles.css": css })).toBe("body{color:red}");
	});

	test("?minify runs html-minifier-terser on html", async () => {
		const minified = await importFile("file://page.html?minify", { "page.html": html });
		// Comments dropped, whitespace collapsed, doctype shortened, the page itself intact
		expect(minified).toBe("<!doctype html><html><head><title>My Page</title></head><body><p>hi</p></body></html>");
		expect(minified).not.toContain("<!--");
	});

	test("?base64 gives the file bytes base64 encoded", async () => {
		const bytes = new Uint8Array([0, 1, 2, 255]);
		const encoded = await importFile("file://payload.bin?base64", { "payload.bin": bytes });
		expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
		expect(Buffer.from(encoded, "base64")).toEqual(Buffer.from(bytes));
	});

	test("?base64&minify encodes the minified contents", async () => {
		const encoded = await importFile("file://styles.css?base64&minify", { "styles.css": css });
		expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("body{color:red}");
	});

	test("?minify on an unknown file type fails the build", async () => {
		await expect(importFile("file://notes.txt?minify", { "notes.txt": "raw notes\n" })).rejects.toThrow(/Don't know how to minify file type/);
	});
});
