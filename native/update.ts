import { access, mkdir, rm, unlink, writeFile } from "fs/promises";
import { constants } from "fs";
import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import JSZip from "jszip";
import path from "path";

import { app } from "electron";

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
		if (!destPath.startsWith(destFolder)) {
			throw new Error(`[UPDATER] Zip Slip blocked: unsafe entry "${filename}"`);
		}
	}
};

const elevatedUpdate = async (zipBuffer: Buffer) => {
	validateAppFolder(appFolder);
	await validateZipEntries(zipBuffer, appFolder);
	const tmpZip = path.join(tmpdir(), `luna-update-${randomBytes(16).toString("hex")}.zip`);
	try {
		await writeFile(tmpZip, zipBuffer);
		const cmd = `rm -rf "${appFolder}" && mkdir -p "${appFolder}" && unzip -o "${tmpZip}" -d "${appFolder}"`;

		for (const tool of elevationTools) {
			try {
				await runElevated(tool, tool === "kdesudo" ? ["-c", cmd] : ["sh", "-c", cmd]);
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
	const zipUrl = `https://github.com/Inrixia/TidaLuna/releases/download/${version}/luna.zip`;
	const res = await fetch(zipUrl);
	if (!res.ok) throw new Error(`Failed to download ${zipUrl}\n${res.statusText}`);

	const zipBuffer = Buffer.from(await res.arrayBuffer());

	if (process.platform === "linux" && (await needsElevation())) {
		pendingZipBuffer = zipBuffer;
		return "elevation_required";
	}

	// Load zip purely from buffer (no internal fs usage by the library)
	const zip = await JSZip.loadAsync(zipBuffer);

	await rm(appFolder, { recursive: true, force: true });
	await mkdir(appFolder, { recursive: true });

	// Manually write files to disk
	const entries = Object.keys(zip.files);
	for (const filename of entries) {
		const file = zip.files[filename];
		const destPath = path.join(appFolder, filename);

		// Security: Prevent Zip Slip (directory traversal attacks)
		if (!destPath.startsWith(appFolder)) {
			console.warn(`[UPDATER] == Skipping unsafe path: ${filename}`);
			continue;
		}

		if (file.dir) {
			await mkdir(destPath, { recursive: true });
		} else {
			// Ensure parent directory exists (zip entries aren't always sorted)
			await mkdir(path.dirname(destPath), { recursive: true });

			// Convert to Node Buffer and write
			const content = await file.async("nodebuffer");
			await writeFile(destPath, content);
		}
	}

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

