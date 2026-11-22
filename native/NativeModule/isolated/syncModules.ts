import path from "path";

/** What the host learns about a module it may `require`: every function listed is run in the main process by `callSync` */
export type HostModule = {
	functions: string[];
	constants: Record<string, string>;
	/** Property name to the name of another host module, e.g. `path.posix` is `path/posix` */
	submodules: Record<string, string>;
};

type SyncFn = (...args: any[]) => unknown;

// Listed by name: only functions that return plain data and whose cost is linear in their input may run for a host.
// They are called synchronously in the main process with arguments that the host chose.
// Not `resolve`, `relative`, `toNamespacedPath`: they fill in the main process's working directory, which a host must not learn.
const pathFunctions = ["basename", "dirname", "extname", "format", "isAbsolute", "join", "normalize", "parse"] as const;
const pathSubmodules = { posix: "path/posix", win32: "path/win32" };

const syncFunctions = new Map<string, Map<string, SyncFn>>();
export const hostModules: Record<string, HostModule> = {};

for (const [moduleName, module] of Object.entries({ path, "path/posix": path.posix, "path/win32": path.win32 })) {
	syncFunctions.set(moduleName, new Map(pathFunctions.map((fn) => [fn, module[fn] as SyncFn])));
	hostModules[moduleName] = {
		functions: [...pathFunctions],
		constants: { sep: module.sep, delimiter: module.delimiter },
		submodules: pathSubmodules,
	};
}

export type SyncResult = { value: unknown } | { error: string };

/** Runs one listed function for a host. Everything passed in comes from plugin code: nothing is looked up outside the maps above. */
export const callSync = (moduleName: unknown, fn: unknown, args: unknown): SyncResult => {
	try {
		const target = typeof moduleName === "string" && typeof fn === "string" ? syncFunctions.get(moduleName)?.get(fn) : undefined;
		if (target === undefined) throw new Error(`'${moduleName}.${fn}' is not available to isolated native code`);
		if (!Array.isArray(args)) throw new Error(`Arguments of '${moduleName}.${fn}' must be an array`);
		return { value: target(...args) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
};
