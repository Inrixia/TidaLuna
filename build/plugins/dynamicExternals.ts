import type { Plugin } from "esbuild";

export const dynamicExternalsPlugin = ({
	moduleContents,
	externals,
}: {
	moduleContents: (module: string) => string;
	externals?: string[];
}): Plugin => ({
	name: "dynamicExternals",
	setup(build) {
		const sanitizeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
		const externalsRegex = (externals ?? build.initialOptions.external)?.map(sanitizeRegex).join("|");
		if (externalsRegex === undefined) return;
		const filter = new RegExp(`^(?:${externalsRegex})$`);
		build.onResolve({ filter }, (args) => ({
			path: args.path,
			namespace: "dynamicExternals",
		}));
		build.onLoad({ filter: /.*/, namespace: "dynamicExternals" }, (args) => ({
			contents: moduleContents(args.path),
		}));
	},
});
