import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Every action type this repo refers to by name, with the files that name it.
 *
 * `plugins/lib/src/redux/types/actions/actionTypes.ts` is a copy of `Object.keys(luna.core.buildActions)` taken from
 * TIDAL, so it can stand in for the live list: what the repo names has to exist in it. Every reference is a string
 * literal, so this needs no TIDAL, no login and no model.
 */
const scannedFolders = ["plugins", "render/src"];
const skip = /node_modules|dist|\.tidal-test|coverage|\.test\.tsx?$/;

/** `redux.actions["type"]` and `intercept("type", ...)` / `interceptActionResp("type", ...)` */
const patterns = [/redux\.actions\[\s*["'`]([^"'`]+)["'`]/g, /\bintercept(?:ActionResp)?\(\s*["'`]([^"'`]+)["'`]/g];

export const scanUsedActionTypes = async (repo: string): Promise<Map<string, string[]>> => {
	const used = new Map<string, string[]>();
	for (const folder of scannedFolders) {
		const entries = await readdir(path.join(repo, folder), { recursive: true, withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || skip.test(entry.name) || skip.test(entry.parentPath)) continue;
			const file = path.join(entry.parentPath, entry.name);
			const code = await readFile(file, "utf8");
			for (const pattern of patterns) {
				for (const [, type] of code.matchAll(pattern)) used.set(type!, [...(used.get(type!) ?? []), path.relative(repo, file)]);
			}
		}
	}
	return used;
};
