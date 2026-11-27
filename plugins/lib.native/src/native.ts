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

// AudioStreams, see native/AudioStreams
export type { AudioMeta, AudioStreamStatus } from "../../../native/AudioStreams";
export const audioStreamsUrl = luna.audioStreamsUrl;
export const audioStreamsWindow = luna.audioStreamsWindow;
export const audioStreamsHover = luna.audioStreamsHover;
export const audioStreamsWaitFilled = luna.audioStreamsWaitFilled;
export const audioStreamsStore = luna.audioStreamsStore;
export const audioStreamsStatus = luna.audioStreamsStatus;

// The main process caches (audio, offline) by key, see native/caches.ts
export const cacheList = luna.cacheList;
export const cacheStats = luna.cacheStats;
export const cacheSetLimit = luna.cacheSetLimit;
export const cacheClear = luna.cacheClear;
export const cacheOpenLocation = luna.cacheOpenLocation;
