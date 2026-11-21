import { access, mkdir, rename, rm, unlink, writeFile } from "fs/promises";
import { constants } from "fs";
import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import JSZip from "jszip";
import path from "path";

import { app } from "electron";

import { isInside } from "./isInside";

import type { PackageJson } from "type-fest";

export const pkg = async (): Promise<PackageJson> => require("./app/package.json");

export const relaunch = async () => {
	app.relaunch();
	app.exit(0);
};

const appFolder = path.join(process.resourcesPath, "app");

export const needsElevation = async (): Promise<boolean> => {
	if (process.platform !== "linux") return false;
	try {
		await access(appFolder, constants.W_OK);
		return false;
	} catch {
		return true;
	}
};


const validateAppFolder = (folder: string) => {
	const resolved = path.resolve(folder);
	// Must be an absolute path ending with /resources/app inside a known app directory
	if (!resolved.endsWith(path.join("resources", "app"))) {
		throw new Error(`[UPDATER] Refusing elevated operation: unexpected app folder path "${resolved}"`);
	}
	// Must have at least 3 segments (e.g. /opt/tidal-hifi/resources/app)
	const segments = resolved.split(path.sep).filter(Boolean);
	if (segments.length < 3) {
		throw new Error(`[UPDATER] Refusing elevated operation: path too shallow "${resolved}"`);
	}
};

const runElevated = (tool: string, args: string[]) =>
	new Promise<void>((resolve, reject) => {
		const child = execFile(tool, args);
		child.on("close", (code) => {
			if (code === 0) return resolve();
			if (code === 126) return reject(new Error("ELEVATION_CANCELLED"));
			reject(new Error(`${tool} exited with code ${code}`));
		});
		child.on("error", reject);
	});

const elevationTools = ["pkexec", "kdesudo"] as const;

const validateZipEntries = async (zipBuffer: Buffer, destFolder: string) => {
	const zip = await JSZip.loadAsync(zipBuffer);
	for (const filename of Object.keys(zip.files)) {
		const destPath = path.join(destFolder, filename);
		if (!isInside(destFolder, destPath)) {
			throw new Error(`[UPDATER] Zip Slip blocked: unsafe entry "${filename}"`);
		}
	}
	return zip;
};

const elevatedUpdate = async (zipBuffer: Buffer) => {
	validateAppFolder(appFolder);
	await validateZipEntries(zipBuffer, appFolder);
	const tmpZip = path.join(tmpdir(), `luna-update-${randomBytes(16).toString("hex")}.zip`);
	try {
		await writeFile(tmpZip, zipBuffer);
		// Use positional parameters to avoid shell injection — $1 and $2 are never interpreted as shell code
		// Unzip next to the app folder first, so a failed unzip leaves the current install untouched
		const shScript = 'rm -rf -- "$1.new" && mkdir -p -- "$1.new" && unzip -o "$2" -d "$1.new" && rm -rf -- "$1" && mv -- "$1.new" "$1"';
		const shellEscape = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

		for (const tool of elevationTools) {
			try {
				const args =
					tool === "kdesudo"
						? ["-c", `sh -c ${shellEscape(shScript)} _ ${shellEscape(appFolder)} ${shellEscape(tmpZip)}`]
						: ["sh", "-c", shScript, "_", appFolder, tmpZip];
				await runElevated(tool, args);
				return;
			} catch (err: any) {
				if (err.message === "ELEVATION_CANCELLED") throw err;
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		}
		throw new Error("NO_ELEVATION_TOOL");
	} finally {
		await unlink(tmpZip).catch(() => {});
	}
};

let pendingZipBuffer: Buffer | null = null;

export const update = async (version: string): Promise<string> => {
	// Callable from the renderer: a version with "/" or ".." would point the download at another repo
	if (!/^[\w.-]+$/.test(version) || version.includes("..")) throw new Error(`[UPDATER] Invalid version "${version}"`);
	const zipUrl = `https://github.com/Inrixia/TidaLuna/releases/download/${version}/luna.zip`;
	const res = await fetch(zipUrl);
	if (!res.ok) throw new Error(`Failed to download ${zipUrl}\n${res.statusText}`);

	const zipBuffer = Buffer.from(await res.arrayBuffer());

	if (process.platform === "linux" && (await needsElevation())) {
		pendingZipBuffer = zipBuffer;
		return "elevation_required";
	}

	// Load zip purely from buffer (no internal fs usage by the library), rejecting unsafe entries before touching disk
	const zip = await validateZipEntries(zipBuffer, appFolder);

	// Extract next to the app folder and swap it in once complete, so a failed update leaves the current install working
	const newFolder = `${appFolder}.new`;
	const oldFolder = `${appFolder}.old`;
	await rm(newFolder, { recursive: true, force: true });
	await rm(oldFolder, { recursive: true, force: true });
	try {
		await mkdir(newFolder, { recursive: true });
		for (const [filename, file] of Object.entries(zip.files)) {
			const destPath = path.join(newFolder, filename);
			if (file.dir) {
				await mkdir(destPath, { recursive: true });
			} else {
				// Ensure parent directory exists (zip entries aren't always sorted)
				await mkdir(path.dirname(destPath), { recursive: true });
				await writeFile(destPath, await file.async("nodebuffer"));
			}
		}
	} catch (err) {
		await rm(newFolder, { recursive: true, force: true }).catch(() => {});
		throw err;
	}

	await rename(appFolder, oldFolder);
	try {
		await rename(newFolder, appFolder);
	} catch (err) {
		await rename(oldFolder, appFolder);
		throw err;
	}
	await rm(oldFolder, { recursive: true, force: true }).catch(() => {});

	return "done";
};

export const runElevatedInstall = async (): Promise<void> => {
	if (!pendingZipBuffer) throw new Error("No pending update to install");

	try {
		await elevatedUpdate(pendingZipBuffer);
	} finally {
		pendingZipBuffer = null;
	}
};

