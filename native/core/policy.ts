// Pure decisions about Luna's own native code, kept apart so they can be tested without Electron.

export type CoreNativeRule = "allow" | "deny" | "confirm";
// Core native exports page code may not call, or only after the user confirms in Luna's confirmation window
// (confirmWindow.ts). Everything else a core plugin exports is meant for the page (pkg, dialogs, caches, download into
// picked folders, …)
const coreDenied = new Set(["sendToRender"]);
const coreConfirmed = new Set(["update", "runElevatedInstall", "startNativeDebugging"]);
export const coreNativeRule = (exportName: string): CoreNativeRule =>
	coreDenied.has(exportName) ? "deny" : coreConfirmed.has(exportName) ? "confirm" : "allow";

/** What the confirmation window says before a confirmed core native runs */
export const coreNativeQuestion = (exportName: string, args: unknown[]): [title: string, lines: string[], confirmText: string] => {
	switch (exportName) {
		case "update":
			return ["Update Luna?", [`Download and install Luna ${String(args[0])}, then restart TIDAL.`], "Update"];
		case "runElevatedInstall":
			return ["Install Luna as administrator?", ["Runs the Luna installer with administrator rights."], "Install"];
		case "startNativeDebugging":
			return [
				"Start native debugging?",
				["Opens a Node inspector on TIDAL's main process. Any program on this computer can then run code in TIDAL."],
				"Start",
			];
		default:
			return [`Run ${exportName}?`, [], "Run"];
	}
};
