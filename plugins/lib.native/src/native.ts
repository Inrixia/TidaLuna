export const pkg = luna.pkg;
export const update = luna.update;
export const relaunch = luna.relaunch;
export const needsElevation = luna.needsElevation;
export const runElevatedInstall = luna.runElevatedInstall;
export const sendToRender = luna.sendToRender;

// Electron
export const showOpenDialog = luna.showOpenDialog;
export const showSaveDialog = luna.showSaveDialog;
export const showMessageBox = luna.showMessageBox;
export const showErrorBox = luna.showErrorBox;
export const clipboardWriteText = luna.clipboardWriteText;
export const openExternal = luna.openExternal;

// Audio cache, see native/audioCache.ts
export type { AudioCacheExtra, AudioCacheStatus } from "../../../native/audioCache";
export const audioCacheUrl = luna.audioCacheUrl;
export const audioCacheWindow = luna.audioCacheWindow;
export const audioCacheHover = luna.audioCacheHover;
export const audioCacheWaitFilled = luna.audioCacheWaitFilled;
export const audioCachePersist = luna.audioCachePersist;
export const audioCacheStatus = luna.audioCacheStatus;

// Every disk cache (audio, offline) by name, see native/cache
export type { CacheStats, DiskCacheStats } from "../../../native/cache";
export const cacheList = luna.cacheList;
export const cacheStats = luna.cacheStats;
export const cacheSetLimit = luna.cacheSetLimit;
export const cacheOpenFolder = luna.cacheOpenFolder;
export const cacheClear = luna.cacheClear;
