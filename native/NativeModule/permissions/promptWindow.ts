// What Luna's own prompt windows share (the native permission window, ./window.ts, and Luna's confirmation,
// native/core/confirmWindow.ts): a window of its own that the TIDAL page and its plugins can't see or click, and one
// prompt at a time.
import { BrowserWindow } from "electron";

export { escapeHtml } from "./escapeHtml";

// One prompt window at a time, of either kind: two modals over TIDAL could be answered in the wrong order
let queue: Promise<unknown> = Promise.resolve();
/** Runs `task` once the prompts before it are answered */
export const inPromptQueue = <T>(task: () => Promise<T>): Promise<T> => {
	const result = queue.then(task, task);
	queue = result.catch(() => {});
	return result;
};

/** The TIDAL window a prompt may belong to: not a minimized or hidden one, the prompt would be hidden with it */
export const visibleOwner = (parent?: BrowserWindow) =>
	parent !== undefined && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized() ? parent : undefined;

/** A sandboxed window with its own session and no preload, showing only the static page Luna gives it */
export const createPromptWindow = (options: Electron.BrowserWindowConstructorOptions & { partition: string }) => {
	const { partition, ...rest } = options;
	const win = new BrowserWindow({
		...rest,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		autoHideMenuBar: true,
		backgroundColor: "#0a0a0a",
		show: false,
		webPreferences: {
			partition,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			devTools: false,
			spellcheck: false,
		},
	});
	win.removeMenu();
	// The page is ours and static: nothing in it may navigate or open windows
	win.webContents.on("will-navigate", (event) => event.preventDefault());
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	// A window that can't show would hold up every later prompt (see inPromptQueue)
	win.webContents.once("render-process-gone", () => !win.isDestroyed() && win.destroy());
	win.webContents.once("did-fail-load", () => !win.isDestroyed() && win.destroy());
	return win;
};
