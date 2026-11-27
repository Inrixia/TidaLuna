// The Electron side of the main process caches: their folders and meta backends in userData, and saving them on quit
import electron from "electron";
import path from "path";

import { Cache, type MetaBackend } from "../../cache";
import { JsonFilesBackend } from "./JsonFilesBackend";
import { SqliteBackend } from "./SqliteBackend";
import { SqliteDb } from "./SqliteDb";

export class UserCache {
	/**
	 * Resolves once the app is ready, as userData follows TIDAL's name, which native/injector.ts sets after modules load. The database every
	 * main process cache keeps its metas in is open by then, a table each (see SqliteDb), written synchronously so saving on quit finishes
	 */
	public static readonly ready: Promise<UserCache> = electron.app.whenReady().then(() => {
		const userData = electron.app.getPath("userData");
		return (UserCache.opened = new UserCache(userData, SqliteDb.open(path.join(userData, "luna-cache.sqlite"))));
	});
	/** The instance once ready, closed synchronously on quit */
	private static opened?: UserCache;

	/** Every meta backend made, closed on quit */
	private readonly backends = new Set<MetaBackend>();

	private constructor(
		private readonly userData: string,
		/** `undefined` where Node has no node:sqlite, metas are JSON files instead */
		private readonly db?: SqliteDb,
	) {}

	/** `luna-<name>-cache` in userData: where the cache named `name` keeps its files */
	public dir(name: string) {
		return path.join(this.userData, `luna-${name}-cache`);
	}
	/** The meta backend for the cache named `name`: its own table in the database, or a folder of JSON files without node:sqlite */
	public metaBackend(name: string): MetaBackend<true> {
		const backend =
			this.db !== undefined ? new SqliteBackend(this.db, name) : new JsonFilesBackend(path.join(this.userData, "luna-cache-state", name));
		this.backends.add(backend);
		return backend;
	}

	private close() {
		for (const backend of this.backends) backend.close?.();
		this.db?.close();
	}

	static {
		electron.app.on("before-quit", () => Cache.flushAll());
		// The windows are closed by now, so what they changed since before-quit is saved too before the database is closed.
		// Not on will-quit, which a listener can cancel: the app would keep running with every save failing
		electron.app.on("quit", () => {
			Cache.flushAll();
			for (const cache of Cache.caches.values()) {
				cache.memoryStore.close();
				cache.persistStore?.close();
			}
			UserCache.opened?.close();
		});
	}
}
