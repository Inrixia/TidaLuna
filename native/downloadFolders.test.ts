// Run: pnpm exec vitest run native/downloadFolders.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createDownloadFolders } from "./downloadFolders";

const root = mkdtempSync(path.join(tmpdir(), "luna-folders-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
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
			() => [path.join(dir, "own")],
			() => {},
		),
	};
};

describe("download folders", () => {
	it("refuses every path before the user picked a folder", () => {
		const { music, folders } = setup();
		expect(() => folders.assertAllowed(path.join(music, "a.flac"))).toThrow(/not in a folder picked in a Luna dialog/);
	});

	it("allows files in a folder picked in an open dialog, also after a restart, and nothing outside it", () => {
		const { dir, music, file, folders } = setup();
		folders.pickedToOpen({ canceled: false, filePaths: [music] });
		expect(folders.assertAllowed(path.join(music, "Artist", "a.flac"))).toBe(path.join(music, "Artist", "a.flac"));
		const again = createDownloadFolders(
			() => file,
			() => [],
			() => {},
		);
		expect(() => again.assertAllowed(path.join(music, "a.flac"))).not.toThrow();
		for (const outside of [path.join(dir, "a.flac"), path.join(dir, "Music-old", "a.flac"), path.join(music, "..", "a.flac")])
			expect(() => again.assertAllowed(outside)).toThrow(/download blocked/);
	});

	it("doesn't keep a canceled dialog, or files picked to be opened", () => {
		const { dir, music, folders } = setup();
		const settings = path.join(dir, "settings.json");
		writeFileSync(settings, "{}");
		folders.pickedToOpen({ canceled: true, filePaths: [music] });
		folders.pickedToOpen({ canceled: false, filePaths: [settings] });
		folders.pickedToSave({ canceled: true, filePath: path.join(dir, "x.flac") });
		expect(() => folders.assertAllowed(path.join(music, "a.flac"))).toThrow();
		expect(() => folders.assertAllowed(settings)).toThrow();
		expect(() => folders.assertAllowed(path.join(dir, "x.flac"))).toThrow();
	});

	it("allows the exact file picked in a save dialog, not its folder", () => {
		const { dir, folders } = setup();
		const saved = path.join(dir, "song.flac");
		folders.pickedToSave({ canceled: false, filePath: saved });
		expect(() => folders.assertAllowed(saved)).not.toThrow();
		expect(() => folders.assertAllowed(path.join(dir, "other.flac"))).toThrow();
	});

	it("keeps each folder once, and no file already in a picked folder", () => {
		const { dir, music, file, folders } = setup();
		folders.pickedToOpen({ canceled: false, filePaths: [music] });
		folders.pickedToOpen({ canceled: false, filePaths: [music + path.sep] });
		folders.pickedToSave({ canceled: false, filePath: path.join(music, "a.flac") });
		folders.pickedToSave({ canceled: false, filePath: path.join(dir, "b.flac") });
		folders.pickedToSave({ canceled: false, filePath: path.join(dir, "b.flac") });
		expect(JSON.parse(readFileSync(file, "utf8"))).toStrictEqual({ folders: [music], files: [path.join(dir, "b.flac")] });
	});

	it("doesn't take a saved file for a folder", () => {
		const { dir, folders } = setup();
		const saved = path.join(dir, "song.flac");
		folders.pickedToSave({ canceled: false, filePath: saved });
		expect(() => folders.assertAllowed(path.join(saved, "sub", "a.flac"))).toThrow(/download blocked/);
	});

	it("writes a saved file under its safe name next to it, nothing else", () => {
		const { dir, folders } = setup();
		const saved = path.join(dir, "Live: Paris.flac");
		folders.pickedToSave({ canceled: false, filePath: saved });
		expect(() => folders.assertAllowed(path.join(dir, "Live Paris.flac"), saved)).not.toThrow();
		expect(() => folders.assertAllowed(path.join(dir, "Live Paris.flac"))).toThrow();
		expect(() => folders.assertAllowed(path.join(dir, "Live Paris.flac"), path.join(dir, "other.flac"))).toThrow();
		expect(() => folders.assertAllowed(path.join(dir, "sub", "Live Paris.flac"), saved)).toThrow();
		// Only the saved name with characters taken out, not another file next to it
		expect(() => folders.assertAllowed(path.join(dir, "Other.flac"), saved)).toThrow();
		expect(() => folders.assertAllowed(path.join(dir, "Live Paris.m4a"), saved)).toThrow();
	});

	it("allows a saved name the plugin added the extension to, not other names", () => {
		const { dir, folders } = setup();
		const saved = path.join(dir, "song");
		folders.pickedToSave({ canceled: false, filePath: saved });
		expect(() => folders.assertAllowed(path.join(dir, "song.flac"))).not.toThrow();
		expect(() => folders.assertAllowed(path.join(dir, "sng.flac"), path.join(dir, "song.flac"))).not.toThrow();
		expect(() => folders.assertAllowed(path.join(dir, "other.flac"), path.join(dir, "song.flac"))).toThrow();
		expect(() => folders.assertAllowed(path.join(dir, "songs.flac"))).toThrow();
		expect(() => folders.assertAllowed(path.join(dir, "song", "a.flac"))).toThrow();
	});

	it("always allows Luna's own folders", () => {
		const { dir, folders } = setup();
		expect(() => folders.assertAllowed(path.join(dir, "own", "Artist - Title [1].flac"))).not.toThrow();
		expect(() => folders.assertAllowed(path.join(dir, "own-old", "a.flac"))).toThrow();
	});

	it("allows nothing from a file that can't be used, or from entries that aren't absolute paths", () => {
		const { music, file, folders } = setup();
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, "{not json");
		expect(() => folders.assertAllowed(path.join(music, "a.flac"))).toThrow();
		writeFileSync(file, JSON.stringify({ folders: [".", "", 5, null], files: "x" }));
		expect(() => folders.assertAllowed(path.resolve("a.flac"))).toThrow();
		// Picking again replaces what couldn't be used
		folders.pickedToOpen({ canceled: false, filePaths: [music] });
		expect(() => folders.assertAllowed(path.join(music, "a.flac"))).not.toThrow();
	});

	it("still returns when the picked folder can't be kept, and logs why", () => {
		const { dir, music } = setup();
		// The folder for the file is a file: it can't be written
		const blocker = path.join(dir, "blocker");
		writeFileSync(blocker, "");
		const logs: string[] = [];
		const folders = createDownloadFolders(
			() => path.join(blocker, "folders.json"),
			() => [],
			(message) => void logs.push(message),
		);
		expect(() => folders.pickedToOpen({ canceled: false, filePaths: [music] })).not.toThrow();
		expect(logs.length).toBe(1);
		expect(logs[0]).toMatch(/Picked folder not kept/);
		expect(() => folders.assertAllowed(path.join(music, "a.flac"))).toThrow();
	});
});
