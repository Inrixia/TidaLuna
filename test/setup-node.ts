/**
 * Globals that Luna's preload injects (`native/preload.ts`), for the `node` test project. Modules under native/
 * reference them at import or call time, so they must exist before any test imports those modules.
 */

const ipcHandlers = new Map<string, (...args: any[]) => unknown>();

export const setIpcHandler = (channel: string, handler: (...args: any[]) => unknown) => {
	ipcHandlers.set(channel, handler);
};

(globalThis as any).luna = {};
(globalThis as any).__platform = "win32";
(globalThis as any).__ipcRenderer = {
	invoke: async (channel: string, ...args: any[]) => ipcHandlers.get(channel)?.(...args),
	send: () => {},
	on: () => () => {},
	once: () => () => {},
};
