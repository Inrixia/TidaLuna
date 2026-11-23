import path from "path";

/**
 * Groups of Node modules outside moduleWhitelist.ts, to show what a plugin's native code names in words.
 * For information only: a file allowed to run in the main process is not held to them (see trust.ts).
 */
export type PermissionCategory = {
	id: string;
	label: string;
	description: string;
	modules: string[];
};

const permissionCategories: PermissionCategory[] = [
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
const OTHER: Omit<PermissionCategory, "modules"> = { id: "other", label: "Other Modules", description: "Use other Node modules." };

const categoryOf = (moduleName: string): Omit<PermissionCategory, "modules"> => {
	const category = byModule.get(moduleName);
	if (category !== undefined) return category;
	// TIDAL's own files, resolved from the resources folder (see nativeRequire). Normalized, so "./app/../../x" is not one
	if (/^\.[\\/]/.test(moduleName) && /^(original\.asar|app)\//.test(path.posix.normalize(moduleName.replaceAll("\\", "/"))))
		return permissionCategories.find(({ id }) => id === "tidal")!;
	return OTHER;
};

/** `modules` by category, in the order of permissionCategories, those without one last */
export const groupModules = (modules: Iterable<string>): PermissionCategory[] => {
	const groups = new Map<string, PermissionCategory>();
	for (const moduleName of modules) {
		const { id, label, description } = categoryOf(moduleName);
		let group = groups.get(id);
		if (group === undefined) groups.set(id, (group = { id, label, description, modules: [] }));
		group.modules.push(moduleName);
	}
	const order = [...permissionCategories.map(({ id }) => id), OTHER.id];
	return [...groups.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
};
