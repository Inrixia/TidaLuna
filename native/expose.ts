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

// Main process caches (audio, offline) and AudioStreams helpers, see native/caches.ts
export {
	audioStreamsHover,
	audioStreamsStatus,
	audioStreamsStore,
	audioStreamsUrl,
	audioStreamsWaitFilled,
	audioStreamsWindow,
	cacheClear,
	cacheList,
	cacheOpenLocation,
	cacheSetLimit,
	cacheStats,
	type AudioMeta,
	type AudioStreamStatus,
} from "./caches";
