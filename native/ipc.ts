import electron from "electron";

type IPCParams = Parameters<(typeof Electron)["ipcMain"]["handle"]>;

// Safe ipcHandler to ensure no duplicates
export const ipcHandle = (channel: IPCParams["0"], listener: IPCParams["1"]) => {
	const unload = () => electron.ipcMain.removeHandler(channel);
	unload();
	electron.ipcMain.handle(channel, listener);
	return unload;
};
