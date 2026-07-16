import sanitize from "sanitize-filename";

import { createWriteStream } from "fs";
import { access, constants, mkdir } from "fs/promises";
import { join, parse } from "path";

import { fetchMediaItemStream, type FetchProgress } from "plugins/lib.native/src/index.native";

// Type import & native space so not a issue
import type { redux } from "@luna/lib";

import { Semaphore } from "@inrixia/helpers";
import type { PlaybackInfo } from "../../helpers";
import { finalizeDashDownload } from "./MediaItem.finalizeDash.native";
import type { MetaTags } from "./MediaItem.tags";

const fileExists = async (path: string): Promise<boolean> => {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
};

const downloads: Record<redux.ItemId, { progress: FetchProgress; promise: Promise<void> } | undefined> = {};
export const downloadProgress = async (trackId: redux.ItemId) => downloads[trackId]?.progress;
const downloadSema = new Semaphore(1);
export const download = async (playbackInfo: PlaybackInfo, path: string | string[], tags?: MetaTags): Promise<void> =>
	downloadSema.with(async () => {
		if (downloads[playbackInfo.trackId] !== undefined) return downloads[playbackInfo.trackId]!.promise;
		try {
			if (Array.isArray(path)) path = join(...path);
			// Dont download if file already exists
			if (await fileExists(path)) return;
			const parsedPath = parse(path);
			await mkdir(parsedPath.dir, { recursive: true });
			const filePath = join(parsedPath.dir, sanitize(parsedPath.base));
			const writeStream = createWriteStream(filePath);

			const progress = { total: 0, downloaded: 0 };
			const stream = await fetchMediaItemStream(playbackInfo, {
				progress,
				tags,
			});

			const { resolve, reject, promise } = Promise.withResolvers<void>();
			downloads[playbackInfo.trackId] = { progress, promise };

			stream.pipe(writeStream).on("finish", resolve).on("error", reject);

			await promise;

			// FLAC streams are tagged in-flight, but DASH streams are written as raw
			// fragmented MP4: remux to a standard MP4 and write the tags post-download
			if (playbackInfo.manifestMimeType === "application/dash+xml") await finalizeDashDownload(filePath, tags);
		} finally {
			delete downloads[playbackInfo.trackId];
		}
	});
