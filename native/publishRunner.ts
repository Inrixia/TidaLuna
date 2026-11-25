import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

/**
 * Keeping the run where a TIDAL update cannot reach it.
 *
 * The entry point ships inside Luna's own build, which lives in `resources/app` — the folder a TIDAL update replaces. The
 * schedule needs one stable path to call, so a copy is kept in Luna's own folder, outside TIDAL's tree, and refreshed
 * whenever the running build differs from it.
 *
 * Doing it here rather than asking the user to copy a file means the schedule survives an update with nothing to
 * remember, and it cannot drift from the Luna that is actually installed.
 */

export const RUNNER_FILE = "autoUpdate.mjs";

export type PublishResult = { published: boolean; reason: string };

/**
 * Copies this build's entry point into Luna's own folder, or says why it could not.
 *
 * Never throws: it runs on the boot path, and a machine that cannot write this should still start TIDAL. The copy that is
 * there keeps working until the next start manages to replace it.
 */
export const publishRunner = async ({ stateRoot, resourcesDir }: { stateRoot: string; resourcesDir: string }): Promise<PublishResult> => {
	const shipped = await readFile(path.join(resourcesDir, "app", RUNNER_FILE)).catch(() => undefined);
	if (shipped === undefined) return { published: false, reason: `this build has no ${RUNNER_FILE}, so there is nothing to schedule` };

	const target = path.join(stateRoot, RUNNER_FILE);
	const existing = await readFile(target).catch(() => undefined);
	// Same bytes: nothing to do, and a start should not rewrite a file to say what is already true
	if (existing !== undefined && existing.equals(shipped)) return { published: true, reason: "already published" };

	try {
		await mkdir(stateRoot, { recursive: true });
		await writeFile(target, shipped);
		return { published: true, reason: existing === undefined ? "published" : "updated" };
	} catch (err) {
		return { published: false, reason: `could not publish the run: ${(err as Error).message}` };
	}
};
