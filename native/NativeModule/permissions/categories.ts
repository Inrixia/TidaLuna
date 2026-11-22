import path from "path";

/** What a plugin's native code can be allowed to do. Node modules outside moduleWhitelist.ts are asked for by category. */
export type PermissionCategory = {
	id: string;
	label: string;
	description: string;
	modules: string[];
};

/** Not a module: what every file loaded into the main process is asked for before any of its code runs (see loadWithPermissions) */
export const MAIN_PROCESS = "MainProcess";

export const permissionCategories: PermissionCategory[] = [
	{
		id: "main",
		label: "Run in TIDAL's Main Process",
		description:
			"Run this file's code inside the TIDAL app itself. Luna asks separately for the Node modules it uses, but code running there can't be fully contained: allow it only if you trust the plugin with your computer and your TIDAL account.",
		modules: [MAIN_PROCESS],
	},
	{
		id: "network",
		label: "Network Access",
		description: "Open connections and make requests to any server (TCP, HTTP, TLS, DNS).",
		modules: ["net", "http", "https", "http2", "tls", "dns"],
	},
	{
		id: "udp",
		label: "UDP Sockets",
		description: "Send and receive UDP network packets.",
		modules: ["dgram"],
	},
	{
		id: "filesystem",
		label: "Filesystem",
		description: "Read, write, and delete files on your computer.",
		modules: ["fs", "original-fs"],
	},
	{
		id: "system",
		label: "System Info",
		description: "Read system details: hostname, memory, CPU, user info.",
		modules: ["os"],
	},
	{
		id: "execute",
		label: "Run Programs and Code",
		description: "Start programs, run code in other threads or processes, load WebAssembly.",
		modules: ["child_process", "worker_threads", "cluster", "WebAssembly"],
	},
	{
		id: "electron",
		label: "Electron",
		description: "Use TIDAL's Electron APIs: windows, shell, clipboard, sessions, the whole app.",
		modules: ["electron"],
	},
	{
		id: "tidal",
		label: "TIDAL and Luna App Code",
		description: "Run any file of the TIDAL app or of Luna itself in the main process (e.g. TIDAL's Connect, mDNS or player modules).",
		modules: [],
	},
	{
		id: "debug",
		label: "Debugging",
		description: "Debug or inspect the main process and its JavaScript engine.",
		modules: ["inspector", "v8", "vm", "DebugProcess"],
	},
];

const byModule = new Map(permissionCategories.flatMap((category) => category.modules.map((module) => [module, category])));
const byId = new Map(permissionCategories.map((category) => [category.id, category]));

/** Modules without a category of their own are asked for one by one, as `module:<name>` */
export const categoryOf = (moduleName: string): string => {
	const category = byModule.get(moduleName);
	if (category !== undefined) return category.id;
	// TIDAL's own files, resolved from the resources folder (see nativeRequire). Normalized, so "./app/../../x" is not one
	if (/^\.[\\/]/.test(moduleName) && /^(original\.asar|app)\//.test(path.posix.normalize(moduleName.replaceAll("\\", "/")))) return "tidal";
	return `module:${moduleName}`;
};

export const categoryInfo = (id: string): Omit<PermissionCategory, "id"> => {
	const category = byId.get(id);
	if (category !== undefined) return category;
	const moduleName = id.replace(/^module:/, "");
	return { label: `Module "${moduleName}"`, description: `Use the Node module "${moduleName}".`, modules: [moduleName] };
};
