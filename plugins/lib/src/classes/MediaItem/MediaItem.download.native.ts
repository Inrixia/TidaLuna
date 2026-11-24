import sanitize from "sanitize-filename";

import { createWriteStream } from "fs";
import { access, constants, lstat, mkdir, rename, unlink } from "fs/promises";
import { basename, join, parse } from "path";
import { pipeline } from "stream/promises";

import { fetchMediaItemStream, type FetchProgress } from "../../../../lib.native/src/index.native";
import { assertMediaFile } from "../../../../lib.native/src/request/guards";

// Type import & native space so not a issue
import type { redux } from "@luna/lib";

import { Semaphore } from "@inrixia/helpers";
import type { TrackPlaybackInfo, VideoPlaybackInfo } from "../PlaybackInfo/PlaybackInfo.types";
import { finalizeDashDownload, finalizeHlsDownload } from "./MediaItem.finalizeDash.native";
import type { MetaTags } from "./MediaItem.tags";

const fileExists = async (path: string): Promise<boolean> => {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
};

/**
 * Deletes the part file `partPath` of a failed download, only if it is a regular file named `<fileName>.part`: never a directory
 * (recursively or not), a symlink's target or any other path a malformed name resolves to
 */
const removePartFile = async (partPath: string, fileName: string) => {
	if (basename(partPath) !== `${fileName}.part`) throw new Error(`Refusing to delete ${partPath}, it isn't the part file of ${fileName}`);
	const info = await lstat(partPath).catch((err: NodeJS.ErrnoException) => {
		if (err.code !== "ENOENT") throw err;
	});
	if (info === undefined) return;
	if (!info.isFile()) throw new Error(`Refusing to delete ${partPath}, it isn't a file`);
	await unlink(partPath);
};

const downloads: Record<redux.ItemId, { progress: FetchProgress; promise: Promise<void> } | undefined> = {};
export const downloadProgress = async (trackId: redux.ItemId) => downloads[trackId]?.progress;
const downloadSema = new Semaphore(1);
export const download = async (playbackInfo: TrackPlaybackInfo | VideoPlaybackInfo, path: string | string[], tags?: MetaTags): Promise<string> =>
	downloadSema.with(async () => {
		const itemId = "videoId" in playbackInfo ? playbackInfo.videoId : playbackInfo.trackId;
		if (Array.isArray(path)) path = join(...path);
		const parsedPath = parse(path);
		// The file is written under its sanitized name, so that is the path to check
		const fileName = sanitize(parsedPath.base);
		// A name sanitized to nothing (e.g. "..") would make the folder itself the file to write and delete
		if (fileName === "") throw new Error(`Download path ${path} has no file name`);
		const filePath = assertMediaFile(join(parsedPath.dir, fileName));
		if (downloads[itemId] !== undefined) {
			await downloads[itemId]!.promise;
			return filePath;
		}
		try {
			// Dont download if file already exists
			if (await fileExists(filePath)) return filePath;
			await mkdir(parsedPath.dir, { recursive: true });

			const progress = { total: 0, downloaded: 0 };
			const stream = await fetchMediaItemStream(playbackInfo, {
				progress,
				tags,
			});

			// Written and finished under a part name, renamed once complete: a crash or kill mid-download would otherwise leave
			// a partial file under the final name, which the check above skips as already downloaded. A part file left behind is overwritten
			const partPath = `${filePath}.part`;
			const promise = (async () => {
				// pipeline rejects on errors from either side and closes both streams
				await pipeline(stream, createWriteStream(partPath));
				// FLAC streams are tagged in-flight, but DASH streams are written as raw
				// fragmented MP4: remux to a standard MP4 and write the tags post-download
				if (playbackInfo.manifestMimeType === "application/dash+xml") await finalizeDashDownload(partPath, tags);
				// HLS video streams are MPEG-TS segments: remux to a standard MP4 and write the tags post-download
				if (playbackInfo.manifestMimeType === "application/vnd.tidal.emu") await finalizeHlsDownload(partPath, tags);
				await rename(partPath, filePath);
			})().catch(async (err) => {
				await removePartFile(partPath, fileName).catch(() => {});
				throw err;
			});
			downloads[itemId] = { progress, promise };

			await promise;
			return filePath;
		} finally {
			delete downloads[itemId];
		}
	});
