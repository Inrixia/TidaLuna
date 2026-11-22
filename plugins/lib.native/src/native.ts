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
export type { AudioCacheStats, AudioCacheStatus } from "../../../native/audioCache";
export const audioCacheUrl = luna.audioCacheUrl;
export const audioCacheWindow = luna.audioCacheWindow;
export const audioCacheHover = luna.audioCacheHover;
export const audioCacheStatus = luna.audioCacheStatus;
export const audioCacheStats = luna.audioCacheStats;
export const audioCacheSetLimit = luna.audioCacheSetLimit;
export const audioCacheOpenFolder = luna.audioCacheOpenFolder;
