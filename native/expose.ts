import { clipboard, dialog, shell } from "electron";
export const clipboardWriteText = clipboard.writeText;
export const openExternal = (url: string) => {
	if (!/^https?:\/\//i.test(url)) throw new Error(`[🛑Security🛑] openExternal blocked: only http/https allowed, got "${url}"`);
	return shell.openExternal(url);
};
export const showOpenDialog = dialog.showOpenDialog;
export const showSaveDialog = dialog.showSaveDialog;
export const showMessageBox = dialog.showMessageBox;
export const showErrorBox = dialog.showErrorBox;

export * from "./update";
export {
	audioCacheHover,
	audioCachePersist,
	audioCacheStatus,
	audioCacheUrl,
	audioCacheWaitFilled,
	audioCacheWindow,
	type AudioCacheExtra,
	type AudioCacheStatus,
} from "./audioCache";
export { cacheClear, cacheList, cacheOpenFolder, cacheSetLimit, cacheStats, type CacheStats, type DiskCacheStats } from "./cache";
