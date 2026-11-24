import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";
import { isInside } from "./isInside";

type Picked = { folders: string[]; files: string[] };

/**
 * Folders and files the user picked in a native Luna dialog (expose.ts showOpenDialog/showSaveDialog): the only places
 * Luna's download natives write to, besides Luna's own folders. Page code can call download with any path and can open
 * a dialog, but only the user picks what the dialog returns. Kept in a file, so a folder picked once stays allowed after
 * a restart.
 *
 * @param file Where the picked paths are kept (userData/luna-core/folders.json)
 * @param own Luna's own folders, always allowed (the audio cache saves its tracks through download)
 */
export const createDownloadFolders = (file: () => string, own: () => string[] = () => [], log: (message: string) => void = console.warn) => {
	const absolute = (list: unknown) =>
		Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string" && path.isAbsolute(entry)) : [];
	const read = (): Picked => {
		try {
			const picked = JSON.parse(readFileSync(file(), "utf8"));
			return { folders: absolute(picked?.folders), files: absolute(picked?.files) };
		} catch {
			// None yet, or a file that can't be used: nothing is allowed until the user picks a folder again
			return { folders: [], files: [] };
		}
	};
	const samePath = (a: string, b: string) => path.relative(a, b) === "";
	/** A picked file is that file only, a picked folder anything in it */
	const covered = (target: string, picked = read()) =>
		[...picked.folders, ...own()].some((folder) => isInside(folder, target)) || picked.files.some((saved) => samePath(saved, target));
	const add = (kind: keyof Picked, entry: string) => {
		const resolved = path.resolve(entry);
		const picked = read();
		// Already allowed: the same folder again, or a file in a picked folder
		if (kind === "folders" ? picked.folders.some((folder) => isInside(folder, resolved)) : covered(resolved, picked)) return;
		try {
			mkdirSync(path.dirname(file()), { recursive: true });
			writeFileSync(file(), JSON.stringify({ ...picked, [kind]: [...picked[kind], resolved] }));
		} catch (err) {
			// The dialog's result still goes back; a download there is refused, and says why
			log(`[Luna.core] Picked folder not kept: ${(err as Error)?.message ?? err}`);
		}
	};
	return {
		/** Keeps the folders an open dialog returned. Files picked to be opened (e.g. a settings import) are no place to write to */
		pickedToOpen: (result: { canceled: boolean; filePaths: string[] }) => {
			if (result.canceled) return;
			for (const picked of result.filePaths) if (statSync(picked, { throwIfNoEntry: false })?.isDirectory()) add("folders", picked);
		},
		/** Keeps the file a save dialog returned */
		pickedToSave: (result: { canceled: boolean; filePath?: string }) => {
			if (!result.canceled && result.filePath) add("files", result.filePath);
		},
		/**
		 * Throws unless `target` is a picked file or in a picked folder (or Luna's own)
		 *
		 * @param requested The path as asked for, when `target` is that path with its file name made safe: the file the user
		 *   named in a save dialog is then written under the safe name, next to it
		 */
		assertAllowed: (target: string, requested?: string): string => {
			const resolved = path.resolve(target);
			const picked = read();
			if (covered(resolved, picked)) return target;
			if (requested !== undefined) {
				const asked = path.resolve(requested);
				if (picked.files.some((saved) => samePath(saved, asked)) && samePath(path.dirname(asked), path.dirname(resolved))) return target;
			}
			throw new Error(`[🛑Security🛑] download blocked: ${target} is not in a folder picked in a Luna dialog, pick the folder again`);
		},
	};
};
