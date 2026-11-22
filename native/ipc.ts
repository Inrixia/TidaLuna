import electron from "electron";

type IPCParams = Parameters<(typeof Electron)["ipcMain"]["handle"]>;

/** Pages that may not call Luna's handlers: isolated native hosts (see NativeModule/isolated), should one ever get hold of ipcRenderer */
export const ipcRefused = new WeakSet<Electron.WebContents>();

// Safe ipcHandler to ensure no duplicates
export const ipcHandle = (channel: IPCParams["0"], listener: IPCParams["1"]) => {
	const unload = () => electron.ipcMain.removeHandler(channel);
	unload();
	electron.ipcMain.handle(channel, (event, ...args) => {
		if (ipcRefused.has(event.sender)) throw new Error(`'${channel}' is not available to this page`);
		return listener(event, ...args);
	});
	return unload;
};
