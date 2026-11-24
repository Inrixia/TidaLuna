import { app, clipboard, dialog, shell } from "electron";
import path from "path";
import { createDownloadFolders } from "./downloadFolders";
export const clipboardWriteText = clipboard.writeText;
export const openExternal = (url: string) => {
	if (!/^https?:\/\//i.test(url)) throw new Error(`[🛑Security🛑] openExternal blocked: only http/https allowed, got "${url}"`);
	return shell.openExternal(url);
};
// Download natives write only where the user picked in these dialogs (downloadFolders.ts)
const downloadFolders = createDownloadFolders(() => path.join(app.getPath("userData"), "luna-core", "folders.json"));
export const showOpenDialog = async (options: Electron.OpenDialogOptions) => {
	const result = await dialog.showOpenDialog(options);
	downloadFolders.pickedToOpen(result);
	return result;
};
export const showSaveDialog = async (options: Electron.SaveDialogOptions) => {
	const result = await dialog.showSaveDialog(options);
	downloadFolders.pickedToSave(result);
	return result;
};
/** Throws unless the user picked `target`, or a folder it is in, in showOpenDialog/showSaveDialog */
export const assertDownloadPath = downloadFolders.assertAllowed;
export const showMessageBox = dialog.showMessageBox;
export const showErrorBox = dialog.showErrorBox;

export * from "./update";
export {
	audioCacheHover,
	audioCacheOpenFolder,
	audioCachePersist,
	audioCacheSetLimit,
	audioCacheStats,
	audioCacheStatus,
	audioCacheUrl,
	audioCacheWaitFilled,
	audioCacheWindow,
	type AudioCacheStats,
	type AudioCacheStatus,
} from "./audioCache";
export { offlineCacheOpenFolder, offlineCacheSetLimit, offlineCacheStats, type OfflineCacheStats } from "./offlineCache";
