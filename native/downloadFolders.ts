import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";
import { isInside } from "./isInside";

/**
 * Folders and files the user picked in a native Luna dialog (expose.ts showOpenDialog/showSaveDialog): the only places
 * Luna's download natives write to. Page code can call download with any path and can open a dialog, but only the user
 * picks what the dialog returns. Kept in a file, so a folder picked once stays allowed after a restart.
 *
 * @param file Where the picked paths are kept (userData/luna-core/folders.json)
 */
export const createDownloadFolders = (file: () => string, log: (message: string) => void = console.warn) => {
	const read = (): string[] => {
		try {
			const picked: unknown = JSON.parse(readFileSync(file(), "utf8"));
			return Array.isArray(picked) ? picked.filter((entry): entry is string => typeof entry === "string" && path.isAbsolute(entry)) : [];
		} catch {
			// None yet, or a file that can't be used: nothing is allowed until the user picks a folder again
			return [];
		}
	};
	const covered = (target: string, picked = read()) => picked.some((entry) => isInside(entry, target));
	const add = (picked: string) => {
		const resolved = path.resolve(picked);
		const all = read();
		// Already allowed: a file in a picked folder, or the same folder again
		if (covered(resolved, all)) return;
		try {
			mkdirSync(path.dirname(file()), { recursive: true });
			writeFileSync(file(), JSON.stringify([...all, resolved]));
		} catch (err) {
			// The dialog's result still goes back; a download there is refused, and says why
			log(`[Luna.core] Picked folder not kept: ${(err as Error)?.message ?? err}`);
		}
	};
	return {
		/** Keeps the folders an open dialog returned. Files picked to be opened (e.g. a settings import) are no place to write to */
		pickedToOpen: (result: { canceled: boolean; filePaths: string[] }) => {
			if (result.canceled) return;
			for (const picked of result.filePaths) if (statSync(picked, { throwIfNoEntry: false })?.isDirectory()) add(picked);
		},
		/** Keeps the file a save dialog returned */
		pickedToSave: (result: { canceled: boolean; filePath?: string }) => {
			if (!result.canceled && result.filePath) add(result.filePath);
		},
		/** Throws unless `target` is a picked file or in a picked folder */
		assertAllowed: (target: string): string => {
			if (covered(path.resolve(target))) return target;
			throw new Error(`[🛑Security🛑] download blocked: ${target} is not in a folder picked in a Luna dialog, pick the folder again`);
		},
	};
};
