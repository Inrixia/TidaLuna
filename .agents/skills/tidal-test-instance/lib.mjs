// tidal.mjs's logic that needs no TIDAL: argument parsing, instance folders, output shaping, repl lines, the host's HTTP API. Tested in lib.test.ts
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, readlink, rm, rmdir, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const commands = [
	"setup",
	"list",
	"start",
	"stop",
	"remove",
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

/** The command line: `--instance`, `--since`, `--native`, `--no-login` and `--all` anywhere, then command and its arguments. `valid` false means print usage */
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
	// Only next to the command (`stop --all`, `--all stop`): further on it's an argument of the command, e.g. part of an expression
	const switchFlag = (name) => {
		const index = args.indexOf(name);
		if (index === -1 || index > 1) return false;
		args.splice(index, 1);
		return true;
	};
	// Not for commands taking free-form text: an expression that is exactly `--all` stays an expression
	const freeFormCommands = ["eval", "native", "wait", "screenshot", "cdp"];
	const freeForm = freeFormCommands.includes(args.find((arg) => !arg.startsWith("--")));
	const noLogin = !freeForm && switchFlag("--no-login");
	const all = !freeForm && switchFlag("--all");
	const [command, arg] = args;
	const isSeconds = (value) => value === undefined || Number(value) >= 0;
	const valid =
		!missingValue &&
		(instance === undefined || validName(instance)) &&
		commands.includes(command) &&
		!(freeFormCommands.includes(command) && arg === undefined) &&
		!(command === "logs" && !isSeconds(arg)) &&
		!(command === "wait" && !isSeconds(args[2])) &&
		!(noLogin && command !== "start") &&
		// `stop --all` is every instance, so it takes no name
		!(all && (command !== "stop" || instance !== undefined)) &&
		(since === undefined || Number(since) >= 0);
	return { valid, instance, since, native: nativeIndex !== -1, noLogin, all, command, arg, args };
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

/** Copies every file of `from` into `to`, skipping `skip`. Copies, not hard links: an install updating itself in place would change the shared copy too */
export const copyTree = async (from, to, skip) => {
	await mkdir(to, { recursive: true });
	for (const entry of await readdir(from, { withFileTypes: true })) {
		const source = join(from, entry.name);
		const target = join(to, entry.name);
		if (resolve(source) === skip) continue;
		if (entry.isDirectory()) await copyTree(source, target, skip);
		// Recreated, not followed: copying a link to a folder would fail. A junction needs no admin rights on Windows, the type is ignored elsewhere
		else if (entry.isSymbolicLink())
			await symlink(await readlink(source), target, (await stat(source).catch(() => undefined))?.isDirectory() ? "junction" : "file");
		else await copyFile(source, target);
	}
};

/**
 * Writes `files` (relative path to content) under `dir`, never outside it: the paths come from TIDAL.
 *
 * Returns how many were written, not how many were offered: a caller prints that number as the result of a dump, so it has
 * to be the files on disk. `dir` is resolved once, because comparing a resolved path against an unresolved `dir` rejected
 * every write whenever the caller passed one with a trailing separator, and said nothing while doing it.
 */
export const writeFiles = async (dir, files) => {
	const base = resolve(dir);
	let written = 0;
	for (const [name, content] of Object.entries(files)) {
		const path = resolve(base, name.replace(/^\/+/, ""));
		if (!path.startsWith(base + sep)) continue;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
		written++;
	}
	return written;
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

/** Whether a process with this pid exists */
export const pidAlive = (pid) => {
	// 0 would signal the whole process group
	if (!(pid > 0)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: it exists, owned by someone else
		return err.code === "EPERM";
	}
};
// How long a lock without a pid counts as just created (the holder is writing it), both for waiting on it and for knowing it is held
const pidGrace = 2000;
/**
 * Runs `fn` holding the lock file `file`, so two commands never launch the same instance at once. The lock is created with `wx`
 * (atomic) and holds the pid of its holder. It is stale, and taken over, when its holder is gone, its pid unreadable, or it is older
 * than `staleSeconds` (a crashed holder's pid may be reused by another process). A lock that isn't stale is waited for, up to `seconds`.
 */
// staleSeconds: a lock older than this whose holder is alive is a reused pid (holders refresh the mtime while they run)
export const withLock = async (file, fn, { alive = pidAlive, seconds = 60, staleSeconds = 300, onWait } = {}) => {
	const end = Date.now() + seconds * 1000;
	// 0 for content that isn't a pid, so garbage compares equal to itself (NaN doesn't) and is taken over
	const pid = (text) => (/^\d+$/.test(text.trim()) ? Number(text) : 0);
	const read = () => readFile(file, "utf8").then(pid, (err) => (["ENOENT", "EPERM", "EBUSY"].includes(err.code) ? null : Promise.reject(err)));
	const age = (path) =>
		stat(path).then(
			(info) => Date.now() - info.mtimeMs,
			() => 0,
		);
	// Two takers of one stale lock must not both delete it: the second would remove the lock the first just created. So taking over is itself locked, and the lock is only deleted while it still holds the pid found stale
	const takeOver = async (holder, stillStale) => {
		const mutex = `${file}.takeover`;
		// A mutex older than any takeover takes means a crashed one (two waiters removing it at the same instant is the only gap, and needs a crash first)
		if ((await age(mutex)) > 10_000) await rm(mutex, { force: true });
		try {
			await writeFile(mutex, "", { flag: "wx" });
		} catch (err) {
			if (err.code !== "EEXIST") throw err;
			// Another waiter is taking over
			return sleep(50);
		}
		try {
			// Rechecked inside the mutex: the holder may have been replaced by one with the same (reused) pid
			if ((await read().catch(() => null)) === holder && (await stillStale())) await rm(file, { force: true });
		} finally {
			await rm(mutex, { force: true });
		}
	};
	for (;;) {
		try {
			await writeFile(file, String(process.pid), { flag: "wx" });
			break;
		} catch (err) {
			// The lock's folder is gone, e.g. .tidal-test was deleted while this waited
			if (err.code === "ENOENT") throw new Error(`${dirname(file)} doesn't exist`);
			// Windows reports a file being deleted as EPERM/EBUSY: the same as held
			if (!["EEXIST", "EPERM", "EBUSY"].includes(err.code)) throw err;
		}
		let holder = await read();
		// Released meanwhile (or being deleted, which Windows reports as EPERM/EBUSY for a while): retry shortly
		if (holder === null) {
			if (Date.now() > end) throw new Error(`${file} can't be read`);
			await sleep(50);
			continue;
		}
		// Created but not yet written: given a moment before an unreadable pid counts as stale
		if (!(holder > 0)) holder = (await sleep(pidGrace), await read());
		if (holder === null) continue;
		if (!(holder > 0) || !alive(holder) || (await age(file)) > staleSeconds * 1000) {
			await takeOver(holder, async () => !(holder > 0) || !alive(holder) || (await age(file)) > staleSeconds * 1000);
			continue;
		}
		if (onWait) (onWait(), (onWait = undefined));
		if (Date.now() > end) throw new Error(`${file} is held by process ${holder}, which is still running`);
		await sleep(250);
	}
	// The holder keeps the lock's mtime fresh, so only a dead holder's lock ever grows old
	// Only while the lock is still ours: after a takeover it is somebody else's, and must age
	const touch = setInterval(
		() =>
			read()
				.then((holder) => holder === process.pid && utimes(file, new Date(), new Date()))
				.catch(() => {}),
		(staleSeconds * 1000) / 3,
	);
	try {
		return await fn();
	} finally {
		clearInterval(touch);
		await unlockOwn(file);
	}
};

/** Whether the lock `file` is held: by a live process, and not so old that its pid is probably reused */
export const lockHeld = async (file, { alive = pidAlive, staleSeconds = 300 } = {}) => {
	const [text, info] = await Promise.all([readFile(file, "utf8").catch(() => ""), stat(file).catch(() => undefined)]);
	if (info === undefined) return false;
	const age = Date.now() - info.mtimeMs;
	// Created a moment ago, its pid not yet written
	if (text === "") return age < pidGrace;
	// The same rules as withLock: only a plain pid counts
	return /^\d+$/.test(text.trim()) && Number(text) > 0 && alive(Number(text)) && age <= staleSeconds * 1000;
};
/** Deletes the lock `file` if this process holds it (after a takeover it is somebody else's). By pid: a process takes a given lock once at a time, as the commands do */
export const unlockOwn = async (file) => {
	if (Number(await readFile(file, "utf8").catch(() => 0)) === process.pid) await rm(file, { force: true });
};

/**
 * Deletes `path` and everything in it. A link (symlink, Windows junction) is deleted itself and never entered, so a junction to
 * a build folder or to the real TIDAL install is left alone. Files and folders go one by one: nothing here recurses through a link.
 */
export const removeTree = async (path) => {
	const info = await lstat(path).catch(() => undefined);
	if (info === undefined) return;
	if (!info.isDirectory()) return unlink(path);
	for (const entry of await readdir(path)) await removeTree(join(path, entry));
	await rmdir(path);
};
/** Marks that a stop was asked for, so a start that is still waiting (for a lock, an install copy) doesn't launch afterwards */
export const requestStop = (file) => writeFile(file, "");
/** Whether a stop was requested after `since` (a time in ms): an older request belongs to an earlier start */
export const stopRequested = async (file, since) => ((await stat(file).catch(() => undefined))?.mtimeMs ?? 0) > since;

/** Removes the host.json at `file` if it is the one of the host with `token`: a host that never got to publish must not delete another's */
export const removeHostFile = (file, token) => {
	try {
		if (JSON.parse(readFileSync(file, "utf8")).token === token) rmSync(file, { force: true });
	} catch {
		// Missing or unreadable: nothing of ours
	}
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
