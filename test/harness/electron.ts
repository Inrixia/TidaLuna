import os from "os";
import path from "path";
import { vi } from "vitest";

/**
 * Electron stand-in for the `node` test project. The main process modules import electron at module scope, so any
 * test that touches them needs it resolvable. Nothing here talks to Electron: `userDataDir` is a scratch directory
 * the test sets, and network/dialog calls are `vi.fn()`s the test drives.
 */

export const userDataDir = { value: path.join(os.tmpdir(), "luna-test-userdata") };

/** Point Electron's `userData` (and so every cache directory) at a scratch dir */
export const setUserDataDir = (dir: string) => {
	userDataDir.value = dir;
};

export const app = {
	getPath: vi.fn((name: string) => (name === "userData" ? userDataDir.value : path.join(userDataDir.value, name))),
	getName: vi.fn(() => "TIDAL"),
	getVersion: vi.fn(() => "1.0.0"),
	isPackaged: true,
	whenReady: vi.fn(() => Promise.resolve()),
	quit: vi.fn(),
	on: vi.fn(),
	commandLine: { appendSwitch: vi.fn() },
};

export const net = {
	fetch: vi.fn(async () => new Response("", { status: 404 })),
};

export const shell = {
	openPath: vi.fn(async () => ""),
	openExternal: vi.fn(async () => undefined),
};

export const dialog = {
	showMessageBoxSync: vi.fn(() => 1),
	showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })),
	showErrorBox: vi.fn(),
};

export const clipboard = {
	writeText: vi.fn(),
	readText: vi.fn(() => ""),
};

export const safeStorage = {
	isEncryptionAvailable: vi.fn(() => true),
	encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
	decryptString: vi.fn((value: Buffer) => Buffer.from(value).toString("utf8")),
};

/** Enough of BrowserWindow for the permission window and trust code paths */
export class BrowserWindow {
	public static getFocusedWindow = vi.fn((): BrowserWindow | null => null);
	public static getAllWindows = vi.fn((): BrowserWindow[] => []);
	public static fromWebContents = vi.fn((): BrowserWindow | null => null);
	public isDestroyed = vi.fn(() => false);
	public isVisible = vi.fn(() => true);
	public isMinimized = vi.fn(() => false);
	public webContents = {
		send: vi.fn(),
		on: vi.fn(),
		once: vi.fn(),
		executeJavaScript: vi.fn(async () => undefined),
		getURL: vi.fn(() => ""),
		reload: vi.fn(),
		insertCSS: vi.fn(async () => ""),
		openDevTools: vi.fn(),
		setWindowOpenHandler: vi.fn(),
	};
	public on = vi.fn();
	public once = vi.fn();
	public show = vi.fn();
	public hide = vi.fn();
	public focus = vi.fn();
	public close = vi.fn();
	public destroy = vi.fn();
	public loadURL = vi.fn(async () => undefined);
	public loadFile = vi.fn(async () => undefined);
	public removeMenu = vi.fn();
	public setMenu = vi.fn();
	public center = vi.fn();
	public getContentSize = vi.fn((): [number, number] => [600, 400]);
	public setContentSize = vi.fn();
	public setResizable = vi.fn();
}

export const ipcMain = {
	handle: vi.fn(),
	on: vi.fn(),
	removeHandler: vi.fn(),
};

export const protocol = {
	handle: vi.fn(),
	registerSchemesAsPrivileged: vi.fn(),
};

export const session = {
	defaultSession: { webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn() } },
};

export const Menu = { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })), setApplicationMenu: vi.fn() };

const electron = {
	app,
	net,
	shell,
	dialog,
	clipboard,
	safeStorage,
	BrowserWindow,
	ipcMain,
	protocol,
	session,
	Menu,
	BrowserView: class {},
	ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn() },
};

export default electron;

/**
 * Compile-time only: these fakes are checked against Electron's own declarations (native/node_modules/electron,
 * whose global `Electron` namespace the main-process code is written against). If Electron renames a member, changes a
 * signature or drops one, this file stops typechecking instead of leaving a fake that quietly no longer matches what
 * the code under test imports. Nothing here runs.
 */
const checkedAgainstElectron: {
	net: Partial<Electron.Net>;
	shell: Partial<Electron.Shell>;
	dialog: Partial<Electron.Dialog>;
	safeStorage: Partial<Electron.SafeStorage>;
	ipcMain: Partial<Electron.IpcMain>;
	protocol: Partial<Electron.Protocol>;
} = { net, shell, dialog, safeStorage, ipcMain, protocol };
void checkedAgainstElectron;

/** Top-level members this module fakes, checked by name against Electron's own module type */
const moduleMembers: readonly (keyof typeof Electron.CrossProcessExports)[] = [
	"app",
	"net",
	"shell",
	"dialog",
	"clipboard",
	"safeStorage",
	"BrowserWindow",
	"BrowserView",
	"ipcMain",
	"ipcRenderer",
	"protocol",
	"session",
	"Menu",
];
/** Members faked on the app itself */
const appMembers: readonly (keyof Electron.App)[] = ["getPath", "getName", "getVersion", "isPackaged", "whenReady", "quit", "on", "commandLine"];
const clipboardMembers: readonly (keyof Electron.Clipboard)[] = ["writeText", "readText"];
/** Statics faked on the Menu class */
const menuMembers: readonly (keyof typeof Electron.Menu)[] = ["buildFromTemplate", "setApplicationMenu"];
void moduleMembers;
void appMembers;
void clipboardMembers;
void menuMembers;

/** Members faked on the window itself, checked by name: a full BrowserWindow would need the whole class */
const windowMembers: readonly (keyof Electron.BrowserWindow)[] = [
	"isDestroyed",
	"isVisible",
	"isMinimized",
	"on",
	"once",
	"show",
	"hide",
	"focus",
	"close",
	"destroy",
	"loadURL",
	"loadFile",
	"removeMenu",
	"setMenu",
	"center",
	"getContentSize",
	"setContentSize",
	"setResizable",
	"webContents",
];
/** The same for the parts of webContents and the default session the tests drive */
const webContentsMembers: readonly (keyof Electron.WebContents)[] = ["send", "on", "once", "executeJavaScript", "getURL", "reload", "insertCSS", "openDevTools", "setWindowOpenHandler"];
const webRequestMembers: readonly (keyof Electron.WebRequest)[] = ["onHeadersReceived", "onBeforeRequest"];
void windowMembers;
void webContentsMembers;
void webRequestMembers;
