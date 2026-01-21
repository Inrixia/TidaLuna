export const getNativeIPCEvents = (): Record<string, string> => require("./original.asar/app/shared/client/ClientMessageChannelEnum.js").default;
export const getRenderIPCEvents = (): Record<string, string> => require("./original.asar/app/shared/AppEventEnum.js").default;

import { ipcMain } from "electron";

const ipcListeners: Record<string, (_: any, ...args: any[]) => void> = {};
export const startRenderIpcLog = async () => {
	for (const eventName of Object.values(await getRenderIPCEvents())) {
		ipcListeners[eventName] = (_, ...args) => console.log("[@luna/dev.native]", "Render -> Native", eventName, ...args);
		ipcMain.on(eventName, ipcListeners[eventName]);
	}
};
export const stopRenderIpcLog = async () => {
	for (const eventName in ipcListeners) {
		ipcMain.removeListener(eventName, ipcListeners[eventName]);
		delete ipcListeners[eventName];
	}
};
