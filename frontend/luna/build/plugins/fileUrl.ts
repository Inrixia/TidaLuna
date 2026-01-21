import { Plugin } from "esbuild";

import CleanCSS from "clean-css";
import { readFile } from "fs/promises";
import path from "path";

import { minify as minifyHtml } from "html-minifier-terser";

// Thx github.com/n1ckoates
// Based on Vencord's file-uri-plugin
// https://github.com/Vendicated/Vencord/blob/main/scripts/build/common.mjs
export const fileUrlPlugin: Plugin = {
	name: "fileUrl",
	setup: (build) => {
		const filter = /^file:\/\/.+/;
		build.onResolve({ filter }, (args) => ({
			path: args.path,
			pluginData: {
				uri: args.path,
				path: path.join(args.resolveDir, args.path.slice("file://".length).split("?")[0]),
			},
			namespace: "file-url",
		}));
		build.onLoad({ filter, namespace: "file-url" }, async ({ pluginData: { path, uri } }) => {
			const { searchParams } = new URL(uri);
			const base64 = searchParams.has("base64");
			const minify = searchParams.has("minify");
			const encoding = base64 ? "base64" : "utf-8";

			let content;
			if (!minify) {
				content = (await readFile(path, encoding)).trimEnd();
			} else {
				const file = await readFile(path, "utf-8");
				if (path.endsWith(".html")) {
					content = await minifyHtml(file, {
						collapseWhitespace: true,
						removeComments: true,
						minifyCSS: true,
						minifyJS: true,
						removeEmptyAttributes: true,
						removeRedundantAttributes: true,
						removeScriptTypeAttributes: true,
						removeStyleLinkTypeAttributes: true,
						useShortDoctype: true,
					});
				} else if (path.endsWith(".css")) {
					content = new CleanCSS().minify(file).styles;
				} else {
					throw new Error(`Don't know how to minify file type: ${path}`);
				}

				if (base64) content = Buffer.from(content).toString("base64");
			}

			return {
				contents: `export default ${JSON.stringify(content)}`,
			};
		});
	},
};
