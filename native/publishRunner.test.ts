import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { publishRunner, RUNNER_FILE } from "./publishRunner";

/**
 * The copy of the entry point that lives outside TIDAL's tree.
 *
 * The schedule calls one path forever, but the build it calls ships inside `resources/app`, which a TIDAL update replaces.
 * So the copy has to be put somewhere TIDAL does not own, and kept in step with the Luna that is installed.
 */
let dir: string;
let stateRoot: string;
let resourcesDir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "luna-publish-runner-"));
	stateRoot = path.join(dir, "luna");
	resourcesDir = path.join(dir, "TIDAL", "app-2.48.0", "resources");
	await mkdir(path.join(resourcesDir, "app"), { recursive: true });
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const ship = (contents: string) => writeFile(path.join(resourcesDir, "app", RUNNER_FILE), contents);
const published = () => readFile(path.join(stateRoot, RUNNER_FILE), "utf8");

describe("publishRunner", () => {
	test("puts this build's entry point where the schedule can always find it", async () => {
		await ship("console.log('entry')");

		const result = await publishRunner({ stateRoot, resourcesDir });

		expect(result).toMatchObject({ published: true, reason: "published" });
		expect(await published()).toBe("console.log('entry')");
	});

	test("keeps it in step with the build that is installed", async () => {
		await ship("old entry");
		await publishRunner({ stateRoot, resourcesDir });
		await ship("new entry");

		const result = await publishRunner({ stateRoot, resourcesDir });

		expect(result).toMatchObject({ published: true, reason: "updated" });
		expect(await published()).toBe("new entry");
	});

	test("does not rewrite it when it is already the same, so a normal start changes nothing", async () => {
		await ship("entry");
		await publishRunner({ stateRoot, resourcesDir });

		expect(await publishRunner({ stateRoot, resourcesDir })).toMatchObject({ published: true, reason: "already published" });
	});

	test("says so when this build has no entry point to publish", async () => {
		const result = await publishRunner({ stateRoot, resourcesDir });

		expect(result.published).toBe(false);
		expect(result.reason).toMatch(/nothing to schedule/);
	});

	test("never throws on the boot path, even when it cannot write", async () => {
		await ship("entry");
		// A state root that is a file, so it cannot be made into a folder
		await writeFile(path.join(dir, "blocked"), "");

		const result = await publishRunner({ stateRoot: path.join(dir, "blocked"), resourcesDir });

		expect(result.published).toBe(false);
		expect(result.reason).toMatch(/could not publish/);
	});
});
