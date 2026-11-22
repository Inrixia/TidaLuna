// Drives a TIDAL test instance for Luna development: a copy of the TIDAL install with its own profile, running this repo's dist/ as Luna.
// Instances live in <repo>/.tidal-test/<n>/ (gitignored). Node 22+, no dependencies. Windows and Linux (tidal-hifi).
//   node tidal.mjs [--instance <n>] setup [installDir] | start | stop | reload | eval "<expression>" | native "<expression>" | logs [seconds] | dump [dir] | screenshot <out.png>
//     | cdp [--native] <method> ['<params json>'] [<method> ['<params json>']...]
import { execFileSync, spawn } from "node:child_process";
import { openSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const usage =
	"Usage: node tidal.mjs [--instance <n>] setup [installDir] | start | stop | reload | eval \"<expression>\" | native \"<expression>\" | logs [seconds] | dump [dir] | screenshot <out.png> | cdp [--native] <method> ['<params json>'] [<method> ['<params json>']...]";
const args = process.argv.slice(2);
let instance = "1";
const instanceFlag = args.indexOf("--instance");
if (instanceFlag !== -1) [, instance] = args.splice(instanceFlag, 2);
const nativeFlag = args.indexOf("--native");
if (nativeFlag !== -1) args.splice(nativeFlag, 1);
const [command, arg] = args;
if (
	!/^\d+$/.test(instance ?? "") ||
	!["setup", "start", "stop", "reload", "eval", "native", "logs", "dump", "screenshot", "cdp"].includes(command) ||
	(["eval", "native", "screenshot", "cdp"].includes(command) && arg === undefined) ||
	(command === "logs" && arg !== undefined && !(Number(arg) >= 0))
) {
	console.error(usage);
	process.exit(2);
}

const platforms = {
	win32: {
		exe: "TIDAL.exe",
		flags: [],
		// The daily client's profile, its login is copied to logged out instances
		dailyProfile: join(process.env.APPDATA ?? "", "TIDAL"),
		defaultInstall: async () => {
			const root = join(process.env.LOCALAPPDATA ?? "", "TIDAL");
			const versions = (await readdir(root))
				.filter((name) => name.startsWith("app-"))
				.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
			if (versions.length === 0) throw new Error(`No TIDAL install found in ${root}, pass its folder to setup`);
			return join(root, versions.at(-1));
		},
	},
	// The copy loses chrome-sandbox's setuid bit, so Chromium's sandbox can't start
	linux: {
		exe: "tidal-hifi",
		flags: ["--no-sandbox"],
		dailyProfile: join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "tidal-hifi"),
		defaultInstall: async () => "/opt/tidal-hifi",
	},
};
const platform = platforms[process.platform];
if (platform === undefined) throw new Error(`Unsupported platform ${process.platform}`);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const instanceDir = join(repo, ".tidal-test", instance);
const appDir = join(instanceDir, "app");
const profileDir = join(instanceDir, "profile");
const port = 9230 + Number(instance);
// Node inspector of the main process (Luna's native side)
const inspectPort = 9330 + Number(instance);
const exists = (path) =>
	lstat(path).then(
		() => true,
		() => false,
	);

const targets = (port) =>
	fetch(`http://127.0.0.1:${port}/json`)
		.then((res) => res.json())
		.catch(() => []);
const pageTarget = async () => {
	const pages = (await targets(port)).filter((target) => target.type === "page");
	return pages.find((target) => /tidal\.com/.test(target.url)) ?? pages[0];
};
const nativeTarget = async () => (await targets(inspectPort))[0];

/** A CDP session on `target`: `send` a method, `on` an event */
const connect = async (target) => {
	if (target === undefined) throw new Error(`Instance ${instance} isn't running (nothing on ports ${port}/${inspectPort}), run start first`);
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = () => rej(new Error(`Could not connect to ${target.webSocketDebuggerUrl}`));
	});
	let lastId = 0;
	const pending = new Map();
	const listeners = new Map();
	ws.onmessage = ({ data }) => {
		const message = JSON.parse(data);
		if (message.id === undefined) return listeners.get(message.method)?.(message.params);
		const { res, rej } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error !== undefined) rej(new Error(message.error.message));
		else res(message.result);
	};
	return {
		send: (method, params) =>
			new Promise((res, rej) => {
				pending.set(++lastId, { res, rej });
				ws.send(JSON.stringify({ id: lastId, method, params }));
			}),
		on: (method, listener) => listeners.set(method, listener),
		close: () => ws.close(),
	};
};
const evaluate = async (method, params, target = pageTarget) => {
	const session = await connect(await target());
	try {
		return await session.send(method, params);
	} finally {
		session.close();
	}
};
const evalIn = async (target, expression) => {
	// includeCommandLineAPI gives the main process `require`
	const params = { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true };
	const { result, exceptionDetails } = await evaluate("Runtime.evaluate", params, target);
	if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
	return result;
};
const evalInPage = (expression) => evalIn(pageTarget, expression);
const evalInNative = (expression) => evalIn(nativeTarget, expression);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
/** Retries `check` every 250ms until it returns something other than undefined (errors count as undefined), throws `error` after `seconds` */
const poll = async (check, seconds, error) => {
	for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(250)) {
		const result = await check().catch(() => undefined);
		if (result !== undefined) return result;
	}
	throw new Error(error);
};

const launch = async () => {
	if (!(await exists(appDir))) throw new Error(`Instance ${instance} isn't set up, run setup first`);
	if ((await pageTarget()) === undefined) {
		// Set by VS Code's terminal, it makes Electron run as plain Node
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE;
		const flags = ["--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"];
		const ports = [`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectPort}`];
		// Main-process output, including native logs from before the window exists and crashes
		const log = openSync(join(instanceDir, "main.log"), "w");
		spawn(join(appDir, platform.exe), [`--user-data-dir=${profileDir}`, ...ports, ...flags, ...platform.flags], {
			detached: true,
			stdio: ["ignore", log, log],
			env,
		}).unref();
	}
	await waitForLuna();
};
/** Waits until Luna loaded in a page other than the one with `performance.timeOrigin` `stale` */
const waitForLuna = (stale) =>
	poll(
		async () => {
			const { value } = await evalInPage("window.luna?.core ? performance.timeOrigin : null");
			return typeof value === "number" && value !== stale ? value : undefined;
		},
		60,
		"Luna didn't load within 60s. A new profile can open renderer_crash.html on first start: stop and start again.",
	);
const reloadPage = async () => {
	const { value: stale } = await evalInPage("performance.timeOrigin");
	await evaluate("Page.reload", { ignoreCache: true });
	await waitForLuna(stale);
};

/** A console argument as text, objects JSON-stringified in the page (errors keep their stack) */
const formatArg = async (session, arg) => {
	if (arg.type === "string") return arg.value;
	if (arg.objectId === undefined || arg.subtype === "error")
		return arg.unserializableValue ?? (arg.value !== undefined ? JSON.stringify(arg.value) : arg.description);
	const stringify = "function () { try { return JSON.stringify(this) ?? String(this); } catch { return String(this); } }";
	const { result } = await session
		.send("Runtime.callFunctionOn", { objectId: arg.objectId, functionDeclaration: stringify, returnByValue: true })
		.catch(() => ({ result: {} }));
	const text = result.value ?? arg.description;
	return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
};

// Run in the main process: TIDAL's own main-process sources (resources/original.asar, read through Electron's asar-aware fs), node_modules skipped
const readOriginalAsar = () => {
	const { readdirSync, readFileSync, statSync } = process.getBuiltinModule("fs");
	const root = `${process.resourcesPath}/original.asar`;
	const files = {};
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const path = `${dir}/${name}`;
			if (name === "node_modules") continue;
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.(m?js|cjs|json|html)$/.test(name)) files[path.slice(root.length + 1)] = readFileSync(path, "utf8");
		}
	};
	walk(root);
	return files;
};
/** Writes `files` (relative path to content) under `dir`, never outside it */
const writeFiles = async (dir, files) => {
	for (const [name, content] of Object.entries(files)) {
		const path = resolve(dir, name.replace(/^\/+/, ""));
		if (!path.startsWith(dir + sep)) continue;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
	}
	return Object.keys(files).length;
};

const stopInstance = async () => {
	// Only this instance's processes, never the user's daily client
	if (process.platform === "win32") {
		const path = `${appDir}\\*`.replaceAll("'", "''");
		execFileSync("powershell", ["-NoProfile", "-Command", `Get-Process | Where-Object Path -like '${path}' | Stop-Process -Force`]);
	} else {
		try {
			execFileSync("pkill", ["-f", "--", appDir]);
		} catch {
			// Nothing was running
		}
	}
	// Let the killed processes release the profile's files
	while ((await pageTarget()) !== undefined) await sleep(250);
	await sleep(1000);
};

/** TIDAL's session once restored, `userId` is null when logged out */
const session = () =>
	poll(
		async () => {
			const { value } = await evalInPage("window.luna?.lib?.redux.store.getState().session");
			return value?.isInitialized && !value.isLoading ? value : undefined;
		},
		30,
		"TIDAL's session didn't initialize within 30s",
	);
/** Right after a load the session reports initialized with `userId` still null, the login follows a moment later */
const loggedInSession = () =>
	poll(
		async () => {
			const restored = await session();
			return restored.userId !== null ? restored : undefined;
		},
		10,
		"",
	).catch(() => session());

// TIDAL's login (@tidal-music/auth) is only in localStorage, so copying the daily client's Local Storage copies it. Only that: IndexedDB holds Luna's plugins and settings too.
// Copied file by file while the daily client may run: readFile can read its open leveldb files where copyFile can't, LOCK stays locked and isn't needed.
const copyDailyLogin = async () => {
	const from = join(platform.dailyProfile, "Local Storage", "leveldb");
	const to = join(profileDir, "Local Storage", "leveldb");
	for (let attempt = 1; ; attempt++) {
		try {
			await rm(to, { recursive: true, force: true });
			await mkdir(to, { recursive: true });
			const files = (await readdir(from)).filter((name) => name !== "LOCK");
			for (const name of files) await writeFile(join(to, name), await readFile(join(from, name)));
			// The same files afterwards means no compaction ran during the copy, which could leave it inconsistent
			if ((await readdir(from)).filter((name) => name !== "LOCK").join() === files.join()) return;
		} catch (err) {
			if (err.code !== "ENOENT") throw err;
		}
		if (attempt === 3) throw new Error(`Could not copy ${from}, the daily client kept changing it`);
	}
};

// Runs in the page. Each login is stored as AuthDB/<storageKey>{Data,Counter,Salt,Key}, encrypted with a key derived from storageKey, and TIDAL
// uses the one whose storageKey derives from its clientUniqueKey. Copied logins have the daily client's key, so this sets clientUniqueKey (kept by
// localforage in IndexedDB) to the one of the newest copied login. Returns whether it found one.
const useCopiedLogin = async () => {
	const bytes = (name) => Uint8Array.from(localStorage.getItem(`AuthDB/${name}`) ?? "", (char) => char.charCodeAt(0));
	let newest;
	for (const name of Object.keys(localStorage)) {
		const storageKey = name.match(/^AuthDB\/(.+)Data$/)?.[1];
		if (storageKey === undefined) continue;
		try {
			const password = await crypto.subtle.importKey("raw", new TextEncoder().encode(storageKey), "PBKDF2", false, ["deriveKey"]);
			const wrappingKey = await crypto.subtle.deriveKey(
				{ name: "PBKDF2", hash: "SHA-256", iterations: 100_000, salt: bytes(`${storageKey}Salt`) },
				password,
				{ name: "AES-KW", length: 256 },
				false,
				["unwrapKey"],
			);
			const key = await crypto.subtle.unwrapKey("raw", bytes(`${storageKey}Key`), wrappingKey, "AES-KW", "AES-CTR", false, ["decrypt"]);
			const data = await crypto.subtle.decrypt(
				{ name: "AES-CTR", counter: bytes(`${storageKey}Counter`), length: 64 },
				key,
				bytes(`${storageKey}Data`),
			);
			const login = JSON.parse(new TextDecoder().decode(data));
			// Without a refresh token it's an anonymous session, not a login
			if (login.refreshToken && (newest === undefined || login.accessToken?.expires > newest.accessToken?.expires)) newest = login;
		} catch {
			// Incomplete entry
		}
	}
	if (newest === undefined) return false;
	const db = await new Promise((res, rej) => {
		const req = indexedDB.open("localforage");
		req.onsuccess = () => res(req.result);
		req.onerror = () => rej(req.error);
	});
	await new Promise((res, rej) => {
		const tx = db.transaction("keyvaluepairs", "readwrite");
		tx.objectStore("keyvaluepairs").put(newest.clientUniqueKey, "_TIDAL_clientUniqueKey");
		tx.oncomplete = res;
		tx.onerror = () => rej(tx.error);
	});
	db.close();
	return true;
};

// A blocked main process (e.g. an unanswered native "Security Warning" dialog) would otherwise hang forever. start can launch twice.
const timeout = command === "start" ? 180 : command === "logs" ? Number(arg ?? 0) + 30 : 90;
setTimeout(() => {
	console.error(`Timed out after ${timeout}s`);
	process.exit(1);
}, timeout * 1000).unref();

switch (command) {
	case "setup": {
		if (await exists(appDir)) throw new Error(`${appDir} already exists`);
		const install = resolve(arg ?? (await platform.defaultInstall()));
		const installLuna = join(install, "resources", "app");
		// Skip the install's own Luna (often a link to some dist), the copy gets a link to this repo's dist instead
		await cp(install, appDir, { recursive: true, verbatimSymlinks: true, filter: (from) => resolve(from) !== installLuna });
		const resources = join(appDir, "resources");
		if (!(await exists(join(resources, "original.asar")))) await rename(join(resources, "app.asar"), join(resources, "original.asar"));
		// A junction needs no admin rights on Windows, the type is ignored elsewhere
		await symlink(join(repo, "dist"), join(resources, "app"), "junction");
		console.log(`Set up instance ${instance} in ${instanceDir} from ${install}`);
		break;
	}
	case "start": {
		await launch();
		let { userId } = await session();
		if (userId === null && (await exists(join(platform.dailyProfile, "Local Storage")))) {
			console.log(`Logged out, copying the login of the daily client in ${platform.dailyProfile}`);
			await stopInstance();
			await copyDailyLogin();
			await launch();
			if ((await evalInPage(`(${useCopiedLogin})()`)).value === true) {
				await reloadPage();
				({ userId } = await loggedInSession());
			}
		}
		const login = userId === null ? "logged out" : `logged in as user ${userId}`;
		console.log(`Instance ${instance} running, Luna loaded, ${login} (CDP port ${port}, main process inspector ${inspectPort})`);
		process.exit(0);
	}
	case "stop": {
		await stopInstance();
		console.log(`Stopped instance ${instance}`);
		break;
	}
	case "reload": {
		await reloadPage();
		console.log(`Reloaded instance ${instance}, Luna loaded`);
		break;
	}
	case "eval":
	case "native": {
		const result = await (command === "eval" ? evalInPage : evalInNative)(arg);
		console.log(result.value === undefined ? (result.description ?? result.type) : JSON.stringify(result.value, null, 2));
		break;
	}
	case "logs": {
		// Runtime.enable replays the console messages buffered so far, then they stream until the time is up
		const page = await connect(await pageTarget());
		// Formatting objects is async, chained so messages print in order
		let printing = Promise.resolve();
		const print = (format) => (printing = printing.then(async () => console.log(await format())));
		page.on("Runtime.consoleAPICalled", ({ type, args }) =>
			print(async () => `[${type}] ${(await Promise.all(args.map((arg) => formatArg(page, arg)))).join(" ")}`),
		);
		page.on("Runtime.exceptionThrown", ({ exceptionDetails }) =>
			print(() => `[exception] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
		);
		await page.send("Runtime.enable");
		await sleep(Number(arg ?? 0) * 1000 + 500);
		await printing;
		page.close();
		process.exit(0);
	}
	case "dump": {
		const dir = resolve(arg ?? join(instanceDir, "sources"));
		// TIDAL's web modules as Luna loaded them (keys of luna.core.tidalModules are their paths)
		const render = await evalInPage(
			"(async () => Object.fromEntries(await Promise.all(Object.keys(luna.core.tidalModules).map(async (path) => [path, await (await fetch(path)).text()]))))()",
		);
		const renderCount = await writeFiles(join(dir, "render"), render.value);
		const nativeCount = await writeFiles(join(dir, "native"), (await evalInNative(`(${readOriginalAsar})()`)).value);
		console.log(`Wrote ${renderCount} render modules to ${join(dir, "render")} and ${nativeCount} main-process files to ${join(dir, "native")}`);
		break;
	}
	case "screenshot": {
		const { data } = await evaluate("Page.captureScreenshot", { format: "png" });
		await writeFile(arg, Buffer.from(data, "base64"));
		console.log(`Saved ${arg}`);
		break;
	}
	case "cdp": {
		// Calls run in order on one session, so a domain's enable applies to the calls after it
		const session = await connect(await (nativeFlag === -1 ? pageTarget : nativeTarget)());
		const calls = args.slice(1);
		for (let i = 0; i < calls.length; i++) {
			const method = calls[i];
			const params = calls[i + 1]?.trimStart().startsWith("{") ? JSON.parse(calls[++i]) : undefined;
			console.log(`${method}: ${JSON.stringify(await session.send(method, params), null, 2)}`);
		}
		session.close();
		break;
	}
}
