import { app } from "electron";

import AdmZip from "adm-zip";
import { readdir, rm, unlink } from "fs/promises";
import path from "path";

import type { PackageJson } from "type-fest";

export const getPackage = async (): Promise<PackageJson> => require("./app/package.json");
export const relaunch = async () => {
	app.relaunch();
	app.exit(0);
};

const appFolder = process.resourcesPath + "/app";

export const updateLuna = async (zipUrl: string) => {
	// Download the zip file using fetch
	const res = await fetch(zipUrl);
	if (!res.ok) throw new Error(`Failed to download ${zipUrl}\n${res.statusText}`);

	// Unzip to app directory
	const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
	await clearAppFolder();
	zip.extractAllTo(appFolder, true);
	await relaunch();
};

const clearAppFolder = async () => {
	const entries = await readdir(appFolder, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(appFolder, entry.name);
		if (entry.isDirectory()) await rm(fullPath, { recursive: true, force: true });
		else await unlink(fullPath);
	}
};
