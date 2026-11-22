export * from "./index.safe";

export * from "./classes";
export * from "./helpers";

export * as ipcRenderer from "./ipc";
export * as redux from "./redux";

import { StyleTag } from "./classes";

import { unloads } from "./index.safe";

export { setWindowTitle } from "./windowTitle";

import "./navigation";

export { errSignal } from "./index.safe";

// Hide the update notification on MacOS as it breaks Luna for some reason
new StyleTag("MacOS-update-fix", unloads, `div div div[data-test="notification-update"]:first-of-type { display: none; }`);
