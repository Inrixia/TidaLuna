export const getNativeIPCEvents = (): Record<string, string> => require("./original.asar/app/shared/client/ClientMessageChannelEnum.js").default;
export const getRenderIPCEvents = (): Record<string, string> => require("./original.asar/app/shared/AppEventEnum.js").default;

const ipcListeners: Record<string, (_: any, ...args: any[]) => void> = {};
export const startRenderIpcLog = async () => {
	const { ipcMain } = await import("electron");
	for (const eventName of Object.values(await getRenderIPCEvents())) {
		ipcListeners[eventName] = (_, ...args) => console.log("[@luna/dev.native]", "Render -> Native", eventName, ...args);
		ipcMain.on(eventName, ipcListeners[eventName]);
	}
};
export const stopRenderIpcLog = async () => {
	if (Object.keys(ipcListeners).length <= 0) return;
	const { ipcMain } = await import("electron");
	for (const eventName in ipcListeners) {
		ipcMain.removeListener(eventName, ipcListeners[eventName]);
		delete ipcListeners[eventName];
	}
};
