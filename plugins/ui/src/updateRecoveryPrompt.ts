import { ipcRenderer } from "@luna/lib";

import { confirm, whenConfirmReady } from "./helpers/confirm";

/**
 * Asking, once, whether Luna may keep itself installed after TIDAL updates.
 *
 * TIDAL replaces its own install when it updates, which removes Luna until something puts it back. Putting it back means
 * registering a check that runs at logon, which is a persistent change to the machine — so it is asked for, and only a yes
 * registers anything. Declining is remembered too, so the question is asked once rather than on every start; the settings
 * card can change the answer later.
 *
 * Nothing here starts an install: the page can answer the question, and the main process is what registers anything.
 */

export type RecoveryStatus = { decision?: "enabled" | "declined"; mechanism?: string };

export const askAboutUpdateRecovery = async (): Promise<void> => {
	const status = await ipcRenderer.invoke("__Luna.getUpdateRecovery").catch(() => undefined as RecoveryStatus | undefined);
	// Undefined means the main process could not answer; silence is not consent either way, so nothing is asked or sent
	if (status === undefined || status.decision !== undefined) return;

	// The provider that backs confirm() mounts as its own page, so wait rather than racing it
	await whenConfirmReady;

	const { confirmed } = await confirm({
		title: "Keep Luna working after TIDAL updates?",
		description:
			"TIDAL replaces its own install when it updates, which removes Luna until it is put back. Luna can put itself back automatically: this registers a check that runs once after you log in, as you, with no admin rights. Nothing else changes, and you can turn it off in Luna Settings.",
		confirmationText: "Keep Luna working",
		cancellationText: "Not now",
	}).catch(() => ({ confirmed: false }));

	await ipcRenderer.invoke("__Luna.setUpdateRecovery", confirmed ? "enabled" : "declined").catch(() => {});
};
