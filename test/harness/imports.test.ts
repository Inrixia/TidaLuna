import { describe, expect, test } from "vitest";

/**
 * Guards the test harness itself: the modules Luna's plugins are built from must all import without booting TIDAL.
 * A failure here means the `@luna/core` stand-in is missing something or a module grew a TIDAL dependency, and every
 * test of that module would fail with a confusing error.
 */
const modules = [
	"../../plugins/lib/src/classes/Album",
	"../../plugins/lib/src/classes/Artist",
	"../../plugins/lib/src/classes/AudioCache",
	"../../plugins/lib/src/classes/ContextMenu",
	"../../plugins/lib/src/classes/ContentBase",
	"../../plugins/lib/src/classes/ImageOverrides",
	"../../plugins/lib/src/classes/MediaItem/MediaItem",
	"../../plugins/lib/src/classes/MediaItem/MediaItem.tags",
	"../../plugins/lib/src/classes/MediaItem/MediaItems",
	"../../plugins/lib/src/classes/Playlist",
	"../../plugins/lib/src/classes/PlayState",
	"../../plugins/lib/src/classes/Quality",
	"../../plugins/lib/src/classes/Shortcut",
	"../../plugins/lib/src/classes/StyleTag",
	"../../plugins/lib/src/classes/TidalApi",
	"../../plugins/lib/src/helpers/brainzJson",
	"../../plugins/lib/src/helpers/listenerError",
	"../../plugins/lib/src/helpers/parseDate",
	"../../plugins/lib/src/helpers/safeTimeout",
	"../../plugins/lib/src/helpers/trackTable",
	"../../plugins/lib/src/redux",
	"../../render/src/ReactiveStore",
	// applySeedSettings and SettingsTransfer import render/src/LunaPlugin.ts, which loads boot code, so tests for
	// them mock that import instead of relying on the harness
	"../../render/src/helpers/findModule",
	"../../render/src/helpers/resolvePath",
	"../../render/src/helpers/unloadSet",
	"../../render/src/requestCache",
	"../../render/src/trace",
];

describe("modules import without TIDAL", () => {
	test.each(modules)("%s", async (path) => {
		await expect(import(path)).resolves.toBeTypeOf("object");
	});
});
