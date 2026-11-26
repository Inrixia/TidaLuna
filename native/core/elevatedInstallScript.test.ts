import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DIGEST_MISMATCH_EXIT, SYMLINK_EXIT, elevatedInstallScript } from "./elevatedInstallScript";

const hasTools = ["sh", "unzip", "sha256sum", "mktemp"].every((t) => spawnSync(t, ["--version"]).error === undefined || t === "sh");

const zipOf = async (content: string) => Buffer.from(await new JSZip().file("a.txt", content).generateAsync({ type: "uint8array" }));
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!hasTools)("elevatedInstallScript", () => {
	let dir: string;
	let app: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "luna-script-"));
		app = join(dir, "app");
		await mkdir(app);
		await writeFile(join(app, "old.txt"), "old");
	});
	afterEach(() => rm(dir, { recursive: true, force: true }));

	const run = (zipPath: string, digest: string) => spawnSync("sh", ["-c", elevatedInstallScript, "_", app, zipPath, digest], { encoding: "utf8" });

	it("installs the zip whose digest matches", async () => {
		const good = await zipOf("new");
		await writeFile(join(dir, "u.zip"), good);
		expect(run(join(dir, "u.zip"), sha256(good)).status).toBe(0);
		expect(await readdir(app)).toEqual(["a.txt"]);
		expect(await readFile(join(app, "a.txt"), "utf8")).toBe("new");
	});

	it("refuses a zip swapped after the digest was taken and leaves the install as it was", async () => {
		const good = await zipOf("new");
		await writeFile(join(dir, "u.zip"), await zipOf("evil"));
		const res = run(join(dir, "u.zip"), sha256(good));
		expect(res.status).toBe(DIGEST_MISMATCH_EXIT);
		expect(res.stderr).toMatch(/does not match the confirmed download/);
		expect(await readdir(app)).toEqual(["old.txt"]);
		expect(await readdir(dir)).not.toContain("app.new");
	});

	// Info-ZIP unzip on Windows (Git for Windows) does not create links, so this only means something on Linux
	it.skipIf(process.platform === "win32")("refuses a zip with a symlink, a real release or not, and leaves the install as it was", async () => {
		const zip = new JSZip().file("a.txt", "new").file("link", "/etc", { unixPermissions: 0o120777 });
		const bytes = Buffer.from(await zip.generateAsync({ type: "uint8array", platform: "UNIX" }));
		await writeFile(join(dir, "u.zip"), bytes);
		const res = run(join(dir, "u.zip"), sha256(bytes));
		expect(res.status).toBe(SYMLINK_EXIT);
		expect(res.stderr).toMatch(/contains a symlink/);
		expect(await readdir(app)).toEqual(["old.txt"]);
		expect(await readdir(dir)).not.toContain("app.new");
	});

	it("fails and leaves the install alone when the zip is missing", async () => {
		const res = run(join(dir, "missing.zip"), sha256(await zipOf("new")));
		expect(res.status).not.toBe(0);
		expect(await readdir(app)).toEqual(["old.txt"]);
	});
});
