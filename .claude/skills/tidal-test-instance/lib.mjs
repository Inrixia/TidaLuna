// tidal.mjs's logic that needs no TIDAL: argument parsing, instance folders, output shaping, repl lines, the host's HTTP API. Tested in lib.test.ts
import { randomBytes } from "node:crypto";
import { copyFile, link, mkdir, readdir, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const commands = [
	"setup",
	"list",
	"start",
	"stop",
	"reload",
	"eval",
	"native",
	"wait",
	"logs",
	"dump",
	"screenshot",
	"repl",
	"cdp",
	"__host",
];
/** Instance names are file names and go into process command lines, so only these characters */
export const validName = (name) => /^[\w-]{1,32}$/.test(name);

/** The command line: `--instance`, `--since` and `--native` anywhere, then command and its arguments. `valid` false means print usage */
export const parseArgs = (argv) => {
	const args = [...argv];
	let missingValue = false;
	const flag = (name) => {
		const index = args.indexOf(name);
		if (index === -1) return undefined;
		const value = args.splice(index, 2)[1];
		// `start --instance` must not silently become a random instance, nor `--instance --native` an instance named --native
		if (value === undefined || value.startsWith("--")) missingValue = true;
		return value;
	};
	const instance = flag("--instance");
	const since = flag("--since");
	const nativeIndex = args.indexOf("--native");
	if (nativeIndex !== -1) args.splice(nativeIndex, 1);
	const [command, arg] = args;
	const isSeconds = (value) => value === undefined || Number(value) >= 0;
	const valid =
		!missingValue &&
		(instance === undefined || validName(instance)) &&
		commands.includes(command) &&
		!(["eval", "native", "wait", "screenshot", "cdp"].includes(command) && arg === undefined) &&
		!(command === "logs" && !isSeconds(arg)) &&
		!(command === "wait" && !isSeconds(args[2])) &&
		(since === undefined || Number(since) >= 0);
	return { valid, instance, since, native: nativeIndex !== -1, command, arg, args };
};

/** Creates a new instance folder in `root`, with a random name unless `name` is given. mkdir without recursive is atomic, so parallel agents never get the same one */
export const createInstance = async (root, name) => {
	await mkdir(root, { recursive: true });
	for (;;) {
		const candidate = name ?? randomBytes(3).toString("hex");
		try {
			await mkdir(join(root, candidate));
			return candidate;
		} catch (err) {
			if (err.code !== "EEXIST" || name !== undefined) throw err;
		}
	}
};

/** Links every file of `from` into `to`, skipping `skip`. Copies where linking isn't allowed: across drives, or files of another user on Linux (fs.protected_hardlinks) */
export const linkTree = async (from, to, skip) => {
	await mkdir(to, { recursive: true });
	for (const entry of await readdir(from, { withFileTypes: true })) {
		const source = join(from, entry.name);
		const target = join(to, entry.name);
		if (resolve(source) === skip) continue;
		if (entry.isDirectory()) await linkTree(source, target, skip);
		// Recreated, not followed: copying a link to a folder would fail. A junction needs no admin rights on Windows, the type is ignored elsewhere
		else if (entry.isSymbolicLink()) await symlink(await readlink(source), target, (await stat(source)).isDirectory() ? "junction" : "file");
		else await link(source, target).catch(() => copyFile(source, target));
	}
};

/** Writes `files` (relative path to content) under `dir`, never outside it: the paths come from TIDAL */
export const writeFiles = async (dir, files) => {
	for (const [name, content] of Object.entries(files)) {
		const path = resolve(dir, name.replace(/^\/+/, ""));
		if (!path.startsWith(dir + sep)) continue;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
	}
	return Object.keys(files).length;
};

/** Cuts text so a huge value doesn't flood the output */
export const cut = (text) => (text.length > 20000 ? `${text.slice(0, 20000)}… (cut, ${text.length} chars, return less)` : text);
/** A CDP RemoteObject as compact JSON (or its description when it has no JSON value), cut */
export const formatResult = (result) => cut(result.value === undefined ? (result.description ?? result.type) : JSON.stringify(result.value));
/** An error as one line, `Error: ` added unless it starts with an error name */
export const errorLine = (err) => err.message.split("\n")[0].replace(/^(?!\w*Error\b)/, "Error: ");

/** A repl line: `:<name> <rest>` is a command, anything else (name undefined) an expression */
export const parseReplLine = (line) => {
	const [, name, rest = ""] = line.match(/^:(\w+)\s*(.*)$/s) ?? [];
	return { name, rest };
};
/** `:wait [seconds] <expression>`, 30s by default */
export const parseWait = (rest) => {
	const [, seconds, expression] = rest.match(/^(\d+)\s+(.*)$/s) ?? [, 30, rest];
	return { seconds: Number(seconds), expression };
};
/** `:cdp <Method> [params json]` */
export const parseCdpLine = (rest) => {
	const [, method, params] = rest.match(/^(\S+)\s*(.*)$/s) ?? [, rest, ""];
	return { method, params: params === "" ? undefined : JSON.parse(params) };
};
/** `cdp` arguments: methods, each optionally followed by its params as JSON */
export const parseCdpCalls = (list) => {
	const calls = [];
	for (let i = 0; i < list.length; i++) {
		const params = list[i + 1]?.trimStart().startsWith("{") ? JSON.parse(list[i + 1]) : undefined;
		calls.push({ method: list[i], params });
		if (params !== undefined) i++;
	}
	return calls;
};

/** The debugging urls Electron prints once listening (port 0 lets the OS pick, so they're only known from its output). Only whole lines: output can arrive split mid-url */
export const debugUrls = (output) => ({
	devtools: output.match(/DevTools listening on (ws:\/\/\S+)\s/)?.[1],
	inspector: output.match(/Debugger listening on (ws:\/\/\S+)\s/)?.[1],
});

/** A Windows command line. Paths can't contain quotes on Windows and instance names are [\w-], so quoting each part is enough */
export const quoteCommandLine = (parts) => {
	if (parts.some((part) => part.includes('"'))) throw new Error(`Can't quote ${parts.find((part) => part.includes('"'))}`);
	return parts.map((part) => `"${part}"`).join(" ");
};
/** `pkill -f` takes a regex: matches `text` literally */
export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
/** Retries `check` every 250ms until it returns something other than undefined (errors count as undefined), throws `error` after `seconds` */
export const poll = async (check, seconds, error) => {
	for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(250)) {
		const result = await check().catch(() => undefined);
		if (result !== undefined) return result;
	}
	throw new Error(error);
};

/** The host's console buffer: numbered lines, the oldest dropped past `max` */
export const createLogBuffer = (max = 10000) => {
	const lines = [];
	let seq = 0;
	return {
		add: (text) => {
			lines.push({ seq: ++seq, text });
			if (lines.length > max) lines.shift();
		},
		/** Lines after `since`, and the `next` to pass for only newer ones */
		after: (since) => ({ lines: lines.filter((line) => line.seq > since).map((line) => line.text), next: seq }),
	};
};
/** The host's HTTP API: `/state` and `/logs?since=n`, every request needs `token` (host.json's port may be reused by another process once the host is gone) */
export const hostHandler = ({ token, state, logs }) =>
	function handle(req, res) {
		const url = new URL(req.url, "http://host");
		if (url.searchParams.get("token") !== token) return res.writeHead(403).end();
		if (url.pathname === "/state") return res.end(JSON.stringify(state));
		if (url.pathname === "/logs") return res.end(JSON.stringify(logs.after(Number(url.searchParams.get("since") ?? 0))));
		res.writeHead(404).end();
	};
