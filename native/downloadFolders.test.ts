// Run: pnpm exec tsx --test native/downloadFolders.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { createDownloadFolders } from "./downloadFolders";

const root = mkdtempSync(path.join(tmpdir(), "luna-folders-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const setup = () => {
	const dir = path.join(root, String(n++));
	const music = path.join(dir, "Music");
	mkdirSync(music, { recursive: true });
	const file = path.join(dir, "luna-core", "folders.json");
	return {
		dir,
		music,
		file,
		folders: createDownloadFolders(
			() => file,
			() => {},
		),
	};
};

describe("download folders", () => {
	it("refuses every path before the user picked a folder", () => {
		const { music, folders } = setup();
		assert.throws(() => folders.assertAllowed(path.join(music, "a.flac")), /not in a folder picked in a Luna dialog/);
	});

	it("allows files in a folder picked in an open dialog, also after a restart, and nothing outside it", () => {
		const { dir, music, file, folders } = setup();
		folders.pickedToOpen({ canceled: false, filePaths: [music] });
		assert.equal(folders.assertAllowed(path.join(music, "Artist", "a.flac")), path.join(music, "Artist", "a.flac"));
		const again = createDownloadFolders(
			() => file,
			() => {},
		);
		assert.doesNotThrow(() => again.assertAllowed(path.join(music, "a.flac")));
		for (const outside of [path.join(dir, "a.flac"), path.join(dir, "Music-old", "a.flac"), path.join(music, "..", "a.flac")])
			assert.throws(() => again.assertAllowed(outside), /download blocked/);
	});

	it("doesn't keep a canceled dialog, or files picked to be opened", () => {
		const { dir, music, folders } = setup();
		const settings = path.join(dir, "settings.json");
		writeFileSync(settings, "{}");
		folders.pickedToOpen({ canceled: true, filePaths: [music] });
		folders.pickedToOpen({ canceled: false, filePaths: [settings] });
		folders.pickedToSave({ canceled: true, filePath: path.join(dir, "x.flac") });
		assert.throws(() => folders.assertAllowed(path.join(music, "a.flac")));
		assert.throws(() => folders.assertAllowed(settings));
		assert.throws(() => folders.assertAllowed(path.join(dir, "x.flac")));
	});

	it("allows the exact file picked in a save dialog, not its folder", () => {
		const { dir, folders } = setup();
		const saved = path.join(dir, "song.flac");
		folders.pickedToSave({ canceled: false, filePath: saved });
		assert.doesNotThrow(() => folders.assertAllowed(saved));
		assert.throws(() => folders.assertAllowed(path.join(dir, "other.flac")));
	});

	it("keeps each folder once, and no file already in a picked folder", () => {
		const { music, file, folders } = setup();
		folders.pickedToOpen({ canceled: false, filePaths: [music] });
		folders.pickedToOpen({ canceled: false, filePaths: [music + path.sep] });
		folders.pickedToSave({ canceled: false, filePath: path.join(music, "a.flac") });
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [music]);
	});

	it("allows nothing from a file that can't be used, or from entries that aren't absolute paths", () => {
		const { music, file, folders } = setup();
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, "{not json");
		assert.throws(() => folders.assertAllowed(path.join(music, "a.flac")));
		writeFileSync(file, JSON.stringify([".", "", 5, null]));
		assert.throws(() => folders.assertAllowed(path.resolve("a.flac")));
		// Picking again replaces what couldn't be used
		folders.pickedToOpen({ canceled: false, filePaths: [music] });
		assert.doesNotThrow(() => folders.assertAllowed(path.join(music, "a.flac")));
	});

	it("still returns when the picked folder can't be kept, and logs why", () => {
		const { dir, music } = setup();
		// The folder for the file is a file: it can't be written
		const blocker = path.join(dir, "blocker");
		writeFileSync(blocker, "");
		const logs: string[] = [];
		const folders = createDownloadFolders(
			() => path.join(blocker, "folders.json"),
			(message) => void logs.push(message),
		);
		assert.doesNotThrow(() => folders.pickedToOpen({ canceled: false, filePaths: [music] }));
		assert.equal(logs.length, 1);
		assert.match(logs[0], /Picked folder not kept/);
		assert.throws(() => folders.assertAllowed(path.join(music, "a.flac")));
	});
});
