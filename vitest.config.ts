import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

import { coverageThresholds } from "./test/coverageThresholds";

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * `@luna/*` and `electron` are resolved by esbuild at build time, and `@luna/core` is replaced by a stub because
 * render/src/index.ts boots TIDAL (it awaits TIDAL's scripts on import). See test/harness/core.ts.
 */
const aliases = [
	{ find: /^test\/(.*)$/, replacement: resolvePath("./test/$1") },
	{ find: /^@luna\/core$/, replacement: resolvePath("./test/harness/core.ts") },
	{ find: /^@luna\/lib\.native$/, replacement: resolvePath("./plugins/lib.native/src/index.native.ts") },
	{ find: /^@luna\/lib$/, replacement: resolvePath("./test/harness/lib.ts") },
	{ find: /^@luna\/ui$/, replacement: resolvePath("./test/harness/ui.ts") },
	{ find: /^@luna\/dev$/, replacement: resolvePath("./plugins/dev/src/index.ts") },
];

const electronAlias = { find: /^electron$/, replacement: resolvePath("./test/harness/electron.ts") };

/**
 * Files that unit tests can't meaningfully cover, excluded so the coverage number describes the code we test:
 * TIDAL boot and its minified-module surgery, the Electron entry points and protocol wiring, plugin barrels, and
 * type-only modules. Runtime behaviour of these is covered by the tidal-test-instance skill instead.
 */
const untestable = [
	"**/types/**",
	"**/*.d.ts",
	"**/*.test.ts",
	"test/**",
	"dist/**",
	".tidal-test/**",
	"node_modules/**",
	"render/src/index.ts",
	"render/src/exposeTidalInternals.ts",
	"render/src/exposeTidalInternals.patchAction.ts",
	"render/src/modules.ts",
	"render/src/window.core.ts",
	"render/src/loadingContainer.ts",
	"render/src/nativeScrollbars.ts",
	"render/src/tidalPatches.ts",
	"render/src/tidalTransform.ts",
	"native/injector.ts",
	"native/preload.ts",
	"native/expose.ts",
	"native/ipc.ts",
	"native/update.ts",
	// A process entry point, like injector.ts: run by the schedule, nothing imports it
	"native/autoUpdateEntry.ts",
	"plugins/*/src/index.ts",
	"plugins/*/src/index.tsx",
	"plugins/*/src/index.safe.ts",
	// Main-process stream fetching needs a real TIDAL CDN and TIDAL's own dash manifests
	"plugins/lib.native/**",
	// tidal-hifi bridge, only meaningful on Linux against the tidal-hifi app
	"plugins/linux/**",
	// Dev tooling, exercised by hand against a running TIDAL
	"plugins/dev/**",
];

export default defineConfig({
	resolve: { alias: aliases },
	test: {
		projects: [
			{
				resolve: { alias: [...aliases, electronAlias] },
				test: {
					name: "node",
					environment: "node",
					include: ["native/**/*.test.ts", "build/**/*.test.ts"],
					setupFiles: [resolvePath("./test/setup-node.ts")],
					// Under coverage instrumentation a file with a heavy import graph is far slower than its dry run
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
			{
				test: {
					name: "dom",
					environment: "happy-dom",
					include: ["render/**/*.test.ts", "plugins/**/*.test.ts", "test/**/*.test.ts"],
					setupFiles: [resolvePath("./test/setup-dom.ts")],
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov", "json-summary"],
			reportsDirectory: "./coverage",
			// The code we intend to unit test. UI components are left out for now: they need react, which Luna takes
			// from TIDAL at runtime rather than from package.json (see test/harness/ui.ts).
			include: [
				"build/**",
				"native/**",
				"plugins/lib/src/**",
				"render/src/**",
				"plugins/ui/src/SettingsPage/tabs.ts",
				"plugins/ui/src/SettingsPage/PluginsTab/installedPlugins.ts",
			],
			exclude: untestable,
			// Floors live in test/coverageThresholds.ts so the PR comment reports the same numbers CI enforces
			thresholds: coverageThresholds,
		},
	},
});
