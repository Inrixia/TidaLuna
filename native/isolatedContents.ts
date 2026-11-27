// Renderers created with contextIsolation (Electron's typings no longer offer a webContents' preferences, so the
// injector records them when it creates each window, see native/injector.ts).
const isolated = new WeakSet<Electron.WebContents>();

/** Called for every BrowserWindow the injector creates, with the preferences it was created with */
export const recordIsolation = (contents: Electron.WebContents, webPreferences: Electron.WebPreferences | undefined) => {
	// contextIsolation defaults to true since Electron 12
	if (webPreferences?.contextIsolation !== false) isolated.add(contents);
};

/** The renderer runs its preload in an isolated world: page code can't reach what the preload holds */
export const isIsolated = (contents: Electron.WebContents) => isolated.has(contents);
