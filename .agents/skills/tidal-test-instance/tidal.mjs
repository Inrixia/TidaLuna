// Drives TIDAL test instances for Luna development: a TIDAL install shared by the instances of this worktree, each instance with its own profile, running this repo's dist/ as Luna.
// Everything lives in <repo>/.tidal-test/ (gitignored): .app/ is the install, <name>/ an instance. Node 22+, no dependencies. Windows and Linux (tidal-hifi).
//   node tidal.mjs setup [installDir] | list | start [--instance <name>] [--no-login] | stop --instance <name> | stop --all | remove --instance <name> | --instance <name> reload | eval "<expression>" | native "<expression>" | wait "<expression>" [seconds]
//     | logs [seconds] [--since <n>] | dump [dir] | screenshot <out.png> | repl [--native] | cdp [--native] <method> ['<params json>'] [<method> ['<params json>']...]
// `start` without --instance creates an instance with a random name and prints it: give that name to every later command.
// Each running instance has a host process (`__host`) that owns TIDAL, so TIDAL outlives the command that started it, and buffers the page console for `logs`.
// Changing this skill: logic that needs no TIDAL goes in lib.mjs, unit tested by lib.test.ts (`pnpm exec vitest run .agents/skills`). Then run the live checks in TEST.md.
// SKILL.md must not link TEST.md or the tests: agents using the skill don't need them, so they stay out of its context.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	copyTree,
	createInstance,
	createLogBuffer,
	cut,
	debugUrls,
	errorLine,
	escapeRegex,
	formatResult,
	hostHandler,
	parseArgs,
	parseCdpCalls,
	parseCdpLine,
	parseReplLine,
	parseWait,
	lockHeld,
	poll,
	quoteCommandLine,
	removeHostFile,
	sleep,
	removeTree,
	requestStop,
	stopRequested,
	unlockOwn,
	withLock,
	writeFiles,
} from "./lib.mjs";

if (typeof WebSocket !== "function") {
	console.error("tidal.mjs needs Node 22+ (global WebSocket), check `node --version` on PATH");
	process.exit(2);
}
const usage =
	'Usage: node tidal.mjs setup [installDir] | list | start [--instance <name>] [--no-login] | stop --instance <name> | stop --all | remove --instance <name> | --instance <name> reload | eval "<expression>" | native "<expression>" | wait "<expression>" [seconds] | logs [seconds] [--since <n>] | dump [dir] | screenshot <out.png> | repl [--native] | cdp [--native] <method> [\'<params json>\'] [<method> [\'<params json>\']...]';
const { valid, since, native, noLogin, all, command, arg, args, ...parsed } = parseArgs(process.argv.slice(2));
let { instance } = parsed;
// The message is what an agent needs, the stack only costs tokens
if (command !== "__host")
	process.on("uncaughtException", (err) => {
		console.error(err.message);
		process.exit(1);
	});
if (!valid) {
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

const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), "../../..");
const root = join(repo, ".tidal-test");
const sharedApp = join(root, ".app");
const exists = (path) =>
	lstat(path).then(
		() => true,
		() => false,
	);
const instances = async () => (await readdir(root).catch(() => [])).filter((name) => !name.startsWith("."));
if (instance === undefined && !["setup", "list", "start"].includes(command) && !(command === "stop" && all)) {
	const names = await instances();
	console.error(`${command} needs --instance <name>, the one \`start\` printed. Instances here: ${names.join(", ") || "none"}`);
	process.exit(2);
}

let created = false;
if (command === "start" && (instance === undefined || !(await exists(join(root, instance))))) {
	// A given name may be created by another start meanwhile: that start's instance is used, as when it existed before
	const name = instance;
	created = true;
	instance = await createInstance(root, name).catch((err) => {
		if (err.code !== "EEXIST" || name === undefined) throw err;
		created = false;
		return name;
	});
}
const instanceDir = join(root, instance ?? "");
const profileDir = join(instanceDir, "profile");
const hostFile = join(instanceDir, "host.json");
// Outside the instance folder: remove deletes the folder while it holds the lock, and a waiting start must not be able to recreate the lock inside it
// Long: a holder suspended (sleep) for longer would look dead, and the lock only guards against a reused pid. A dead holder is detected at once anyway
const instanceLockStale = 300;
const lockPath = (name) => join(root, `.${name}.instance.lock`);
const lockFile = lockPath(instance ?? "");
const mainLog = join(instanceDir, "main.log");
// Instances set up before the install was shared have their own copy
const appDir = (await exists(join(instanceDir, "app"))) ? join(instanceDir, "app") : sharedApp;

/** A host API response, undefined when the instance isn't running. The token rejects a stale host.json whose port another process got, the timeout one that took it and never answers */
const hostGet = async (path, dir = instanceDir) => {
	const host = await readFile(join(dir, "host.json"), "utf8").then(JSON.parse, () => undefined);
	if (host === undefined) return undefined;
	return fetch(`http://127.0.0.1:${host.port}${path}${path.includes("?") ? "&" : "?"}token=${host.token}`, { signal: AbortSignal.timeout(2000) })
		.then((res) => (res.ok ? res.json() : undefined))
		.catch(() => undefined);
};
/** The running host's `devtools` and `inspector` WebSocket urls */
const hostState = (dir) => hostGet("/state", dir);
/** Whether the instance `name` runs, or is busy: a live lock file means a start (its TIDAL runs before host.json exists) or a remove is in progress */
const instanceState = async (name) => {
	if ((await hostState(join(root, name))) !== undefined) return "running";
	return (await lockHeld(lockPath(name), { staleSeconds: instanceLockStale })) ? "busy" : "stopped";
};
const notRunning = () => new Error(`Instance ${instance} isn't running, run start --instance ${instance}`);

const targets = (port) =>
	fetch(`http://127.0.0.1:${port}/json`)
		.then((res) => res.json())
		.catch(() => []);
const pageTarget = async () => {
	const state = await hostState();
	if (state === undefined) return undefined;
	const pages = (await targets(new URL(state.devtools).port)).filter((target) => target.type === "page");
	return pages.find((target) => /tidal\.com/.test(target.url)) ?? pages[0];
};
// Node inspector of the main process (Luna's native side)
const nativeTarget = async () => {
	const state = await hostState();
	return state && { webSocketDebuggerUrl: state.inspector };
};

/** A CDP session on `target`: `send` a method, `on` an event, `closed` resolves when the connection ends */
const connect = async (target) => {
	if (target === undefined) throw notRunning();
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
	const closed = new Promise((res) => (ws.onclose = res));
	closed.then(() => pending.forEach(({ rej }) => rej(new Error("Connection closed"))));
	return {
		send: (method, params) =>
			new Promise((res, rej) => {
				pending.set(++lastId, { res, rej });
				ws.send(JSON.stringify({ id: lastId, method, params }));
			}),
		on: (method, listener) => listeners.set(method, listener),
		close: () => ws.close(),
		closed,
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
/** Puts the tail of main.log into `err`: failures (crash, native dialog, renderer_crash) are only visible there */
const withMainLog = async (err) => {
	const lines = (await readFile(mainLog, "utf8").catch(() => "")).split("\n").slice(-20).join("\n");
	return new Error(`${err.message}\n--- main.log (${mainLog}), last lines:\n${lines}`);
};

/** Sets up the install all instances of this worktree run: a copy of the install (several hundred MB), so what TIDAL does to its own files never touches the original */
const setupApp = async (installDir) => {
	const install = resolve(installDir ?? (await platform.defaultInstall()));
	// Built under a partial name and renamed at the end, so an interrupted setup doesn't look finished. Unique, as agents starting at once in a new worktree all set up
	const partial = `${sharedApp}.${randomBytes(3).toString("hex")}.partial`;
	// Skip the install's own Luna (often a link to some dist), the copy gets a link to this repo's dist instead
	try {
		await copyTree(install, partial, join(install, "resources", "app"));
		const resources = join(partial, "resources");
		if (!(await exists(join(resources, "original.asar")))) await rename(join(resources, "app.asar"), join(resources, "original.asar"));
		// A junction needs no admin rights on Windows, the type is ignored elsewhere
		await symlink(join(repo, "dist"), join(resources, "app"), "junction");
		// Tells a copy from an install hard linked by an older setup
		await writeFile(join(partial, ".copied"), "");
	} catch (err) {
		// A failed copy of the install mustn't stay behind
		await removeTree(partial);
		throw err;
	}
	await rename(partial, sharedApp).catch(async (err) => {
		// Another agent's setup finished first: use that one
		if (!(await exists(sharedApp))) throw err;
		await removeTree(partial);
	});
	return install;
};

/** Runs `fn` holding the lock on the shared install: one copy at a time, and the leftovers of an interrupted copy are swept first */
const inAppLock = (fn) =>
	mkdir(root, { recursive: true }).then(() =>
		withLock(
			join(root, ".app.lock"),
			async () => {
				for (const name of await readdir(root)) if (/^\.app\.\w+\.partial$/.test(name)) await removeTree(join(root, name));
				return fn();
			},
			{ seconds: 900, staleSeconds: 1000 },
		),
	);
// Whether this command started (or restarted) the host: a start that fails then stops it, one that only found the instance running leaves it
let spawned = false;
// Set by the timeout: a start still running then must not spawn TIDAL again while the cleanup stops it
let aborted = false;
// When this command began: a stop requested after that is meant for this start
// Known limit, by design: stop is checked by file mtime at every launch (also the relaunch after the login copy) and after the spawn, not continuously, and a filesystem with coarse mtimes (FAT) can round a stop made within a moment of the start down. A stop that is missed leaves a running instance, which `stop` again ends
const began = Date.now();
const stopRequestFile = join(instanceDir, "stop.request");
const launch = async () => {
	if (!(await exists(appDir))) throw new Error(`${appDir} isn't set up, run setup first`);
	if (aborted) throw new Error("Timed out");
	if (await stopRequested(stopRequestFile, began)) throw new Error(`Instance ${instance} was stopped by a stop command, not launching it`);
	if ((await hostState()) === undefined) {
		await rm(hostFile, { force: true });
		spawned = true;
		if (process.platform === "win32") {
			// A process spawned by this command dies when the agent's tool call ends (its job object closes), so WMI starts the host instead.
			const commandLine = quoteCommandLine([process.execPath, script, "--instance", instance, "__host"]);
			// ShowWindow 0 (SW_HIDE): node.exe is a console program, without it an empty console window opens
			const create =
				"$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; " +
				'$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:TT_CMD; CurrentDirectory=$env:TT_DIR; ProcessStartupInformation=$s}; if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }';
			execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", create], {
				env: { ...process.env, TT_CMD: commandLine, TT_DIR: instanceDir },
				stdio: "pipe",
			});
		} else {
			spawn(process.execPath, [script, "--instance", instance, "__host"], {
				cwd: instanceDir,
				detached: true,
				stdio: "ignore",
			}).unref();
		}
		await poll(hostState, 30, "TIDAL didn't open its debugging ports within 30s").catch(async (err) => {
			throw await withMainLog(err);
		});
	}
	// A stop that came while TIDAL was spawning found nothing to stop
	if (spawned && (aborted || (await stopRequested(stopRequestFile, began)))) {
		await stopInstance();
		throw new Error(`Instance ${instance} was stopped by a stop command`);
	}
	await waitForLuna().catch(async (err) => {
		throw await withMainLog(err);
	});
};
/**
 * Waits until Luna loaded in a page other than the one with `performance.timeOrigin` `stale`. `@luna/dev` is the last core plugin render/src/index.ts loads, so once it's there the core plugins are.
 * Also waits for TIDAL's app to mount (its #app-loader gone, ~2s later): navigating before that is undone by the mount
 */
const waitForLuna = (stale) =>
	poll(
		async () => {
			const { value } = await evalInPage(
				"window.luna?.core?.modules?.['@luna/dev'] && !document.querySelector('#wimp > #app-loader') ? performance.timeOrigin : null",
			);
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
	const text = String(result.value ?? arg.description ?? arg.type);
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

const stopInstance = async (name = instance) => {
	const dir = join(root, name);
	// Only this instance's processes, never the user's daily client or other instances: Chromium passes --user-data-dir to every process it starts
	const profileArg = `--user-data-dir=${join(dir, "profile")}`;
	if (process.platform === "win32") {
		const kill =
			"Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:TT_PROFILE) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
		execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", kill], { env: { ...process.env, TT_PROFILE: profileArg } });
	} else {
		try {
			// SIGKILL like Stop-Process -Force: a test instance has nothing to save
			execFileSync("pkill", ["-KILL", "-f", "--", escapeRegex(profileArg)]);
		} catch {
			// Nothing was running
		}
	}
	// The host exits with TIDAL. Then let the killed processes release the profile's files
	await poll(async () => ((await hostState(dir)) === undefined ? true : undefined), 15, `Instance ${name} still running 15s after killing it`);
	await rm(join(dir, "host.json"), { force: true });
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
			const files = (await readdir(from, { withFileTypes: true }))
				.filter((entry) => entry.isFile() && entry.name !== "LOCK")
				.map((entry) => entry.name);
			for (const name of files) {
				// The timeout's cleanup deletes the copy: nothing is written after it
				if (aborted) throw new Error("Timed out");
				await writeFile(join(to, name), await readFile(join(from, name)));
			}
			// The same files afterwards means no compaction ran during the copy, which could leave it inconsistent
			const after = (await readdir(from, { withFileTypes: true }))
				.filter((entry) => entry.isFile() && entry.name !== "LOCK")
				.map((entry) => entry.name);
			if (after.join() === files.join()) return;
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

/** The host: owns TIDAL, publishes its debugging urls in host.json, keeps the page console for `logs`. Exits with TIDAL */
const host = async () => {
	// Set by VS Code's terminal, it makes Electron run as plain Node
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	// The window opens behind others: these keep Chromium rendering it as if it were in front
	const flags = [
		"--disable-backgrounding-occluded-windows",
		"--disable-background-timer-throttling",
		"--disable-renderer-backgrounding",
		"--disable-features=CalculateNativeWinOcclusion",
	];
	// Port 0: the OS picks free ports, so instances never collide. TIDAL prints the urls it got
	const ports = ["--remote-debugging-port=0", "--inspect=127.0.0.1:0"];
	const token = randomBytes(16).toString("hex");
	const tidal = spawn(join(appDir, platform.exe), [`--user-data-dir=${profileDir}`, ...ports, ...flags, ...platform.flags], {
		cwd: instanceDir,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Main-process output, including native logs from before the window exists and crashes
	const log = createWriteStream(mainLog);
	process.on("uncaughtException", (err) => log.write(`[tidal.mjs host] ${err.stack}\n`));
	// TIDAL didn't start (no exit event follows): nothing left to host
	tidal.on("error", (err) => log.end(`[tidal.mjs host] Could not start TIDAL: ${err.message}\n`, () => process.exit(1)));
	tidal.on("exit", (code) => {
		// Only its own: a second host for the same instance exits on the profile lock and must leave the first one's host.json
		removeHostFile(hostFile, token);
		log.end(`[tidal.mjs host] TIDAL exited with ${code}\n`, () => process.exit(0));
	});

	const state = {};
	const logs = createLogBuffer();
	const server = createServer(hostHandler({ token, state, logs }));
	await new Promise((res) => server.listen(0, "127.0.0.1", res));

	let output = "";
	let published = false;
	let quiet;
	// Runs in the main process: TIDAL's windows show in the background, never taking the focus. Luna's prompts (own session) are left alone.
	const quietWindows = async (inspector) => {
		const hook = `(() => {
			const { app, BrowserWindow, session } = require("electron");
			const quiet = (win) => {
				if (win.webContents.session !== session.defaultSession) return;
				win.focus = win.moveTop = () => {};
				win.show = win.showInactive.bind(win);
			};
			app.on("browser-window-created", (_, win) => quiet(win));
			BrowserWindow.getAllWindows().forEach(quiet);
			return BrowserWindow.getAllWindows().length;
		})()`;
		const session = await connect({ webSocketDebuggerUrl: inspector });
		const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
			expression: hook,
			includeCommandLineAPI: true,
			returnByValue: true,
		});
		session.close();
		log.write(
			`[tidal.mjs host] window hook ${exceptionDetails ? `failed: ${exceptionDetails.exception?.description}` : `installed, ${result.value} windows open`}\n`,
		);
	};
	const onOutput = async (data) => {
		log.write(data);
		if (published) return;
		output += data;
		const { devtools, inspector } = debugUrls(output);
		// The inspector is up before TIDAL makes its window, so the hook is in place when it does
		if (inspector !== undefined)
			quiet ??= quietWindows(inspector).catch((err) => log.write(`[tidal.mjs host] window hook failed: ${err.message}\n`));
		if (devtools === undefined || inspector === undefined) return;
		published = true;
		await quiet;
		Object.assign(state, { devtools, inspector });
		// Written whole under another name, so a reader never sees half of it
		await writeFile(`${hostFile}.partial`, JSON.stringify({ port: server.address().port, token }));
		await rename(`${hostFile}.partial`, hostFile);
		followConsole();
	};
	tidal.stdout.on("data", onOutput);
	tidal.stderr.on("data", onOutput);

	// One page session for TIDAL's lifetime: it sees every console message, also across reloads. Reconnects when the page target changes
	const followConsole = async () => {
		for (;;) {
			const page = await poll(pageTarget, 3600, "").catch(() => undefined);
			const session = await connect(page).catch(() => undefined);
			if (session === undefined) {
				await sleep(1000);
				continue;
			}
			// Formatting objects is async, chained so messages are kept in order
			let printing = Promise.resolve();
			// A message that fails to format is logged as such, a rejected chain would drop every later one
			const add = (format) =>
				(printing = printing.then(async () =>
					logs.add(
						await Promise.resolve()
							.then(format)
							.catch((err) => `[tidal.mjs] Could not format a console message: ${err.message}`),
					),
				));
			session.on("Runtime.consoleAPICalled", ({ type, args }) =>
				add(async () => `[${type}] ${(await Promise.all(args.map((arg) => formatArg(session, arg)))).join(" ")}`),
			);
			session.on("Runtime.exceptionThrown", ({ exceptionDetails }) =>
				add(() => `[exception] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
			);
			// Replays the console messages buffered so far
			await session.send("Runtime.enable").catch(() => {});
			await session.closed;
		}
	};
};

// A blocked main process (e.g. an unanswered native "Security Warning" dialog) would otherwise hang forever. start can launch twice.
// Known limit: a timeout in the moments between the host's creation and its spawn of TIDAL finds no process of the profile to stop, and the host then starts TIDAL (rare; `stop` ends it).
const armTimeout = (seconds, cleanup) =>
	setTimeout(async () => {
		aborted = true;
		console.error(`Timed out after ${seconds}s`);
		// Bounded: a hung kill or delete mustn't keep a timed out command alive
		await Promise.race([cleanup?.().catch(() => {}), sleep(40_000)]);
		process.exit(1);
	}, seconds * 1000).unref();
/** Stops the instance this command launched, so a failed start leaves nothing running */
const stopIfSpawned = async () => {
	if (spawned) await stopInstance();
};
const seconds = command === "wait" ? Number(args[2] ?? 30) : Number(arg ?? 0);
if (!["start", "repl", "__host"].includes(command))
	// setup waits up to 900s for the install lock, then copies
	armTimeout(command === "setup" ? 1800 : command === "logs" || command === "wait" ? seconds + 30 : command === "remove" ? 1100 : all ? 600 : 90);

/** The host's page console lines after `since` */
const readLogs = async (since) => (await hostGet(`/logs?since=${since}`)) ?? Promise.reject(notRunning());
/** Commands that print one result, shared by the command line and repl's ":<command>" */
const shared = {
	reload: async () => (await reloadPage(), `Reloaded instance ${instance}, Luna loaded`),
	eval: async (expression) => formatResult(await evalInPage(expression)),
	native: async (expression) => formatResult(await evalInNative(expression)),
	wait: async (expression, seconds) => {
		// Truthy ends the wait, errors count as not yet
		const check = async () => {
			const result = await evalInPage(expression);
			return result.value ? result : undefined;
		};
		return formatResult(await poll(check, seconds, `Still falsy after ${seconds}s: ${expression}`));
	},
	screenshot: async (file) => {
		// A window behind others (never focused, see quietWindows) doesn't repaint by itself: without this the screenshot is a stale frame
		await evalInNative(`require("electron").BrowserWindow.getAllWindows().forEach((win) => win.webContents.invalidate())`);
		const { data } = await evaluate("Page.captureScreenshot", { format: "png" });
		await writeFile(file, Buffer.from(data, "base64"));
		return `Saved ${file}`;
	},
};

switch (command) {
	case "__host": {
		await host();
		break;
	}
	case "setup": {
		await inAppLock(async () => {
			if (await exists(sharedApp))
				throw new Error(
					`${sharedApp} already exists (an old hard linked one is replaced by the next start that finds no instance running), delete it to set it up again`,
				);
			console.log(`Set up ${sharedApp} from ${await setupApp(arg)}`);
		});
		break;
	}
	case "list": {
		for (const name of await instances()) console.log(`${name}: ${await instanceState(name)}`);
		break;
	}
	case "start": {
		// Locked as a whole, not only the host spawn: two starts of a logged out instance would otherwise both stop it to copy the login. The second waits, then finds the instance running
		await withLock(
			lockFile,
			async () => {
				// Under the instance lock, so no other start is between its install check and its lock (it would read as stopped). Locked only when the install is missing or old, so a start doesn't wait for another's copy for nothing
				if (appDir === sharedApp && !(await exists(join(sharedApp, ".copied")))) {
					await inAppLock(async () => {
						// An install hard linked by an older setup (no .copied marker) is replaced by a copy, unless instances run from it: deleting it under them would break them
						if ((await exists(sharedApp)) && !(await exists(join(sharedApp, ".copied")))) {
							const busy = [];
							// Instances with their own app copy (older still) don't use it. Running and starting ones (their lock is held) count
							// Counts every non-stopped instance, also one only waiting for a lock: not told apart, and a wrong hint only delays the migration
							for (const name of await instances())
								if (
									!(await exists(join(root, name, "app"))) &&
									(name === instance ? (await hostState()) !== undefined : (await instanceState(name)) !== "stopped")
								)
									busy.push(name);
							// Known limit: while an instance runs on the old install every start says so, and only stopping it allows the migration
							if (busy.length > 0)
								console.log(
									`${sharedApp} is hard linked by an older setup: stop ${busy.join(", ")}, then start again to get a copy (this start continues on the old install)`,
								);
							else {
								// Renamed first: a rename fails whole when a file is in use, where deleting in place could leave a half deleted install. The renamed tree is removed next (or swept as a partial)
								const old = `${sharedApp}.${randomBytes(3).toString("hex")}.partial`;
								try {
									await rename(sharedApp, old);
								} catch (err) {
									// Some file is in use (a leftover TIDAL, a scan): stays as it was, this start runs on it
									console.log(
										`${sharedApp} is hard linked by an older setup and in use (${err.code}): stop TIDAL processes of this worktree, then start again to get a copy (this start continues on the old install)`,
									);
									return;
								}
								// A failed delete leaves a partial that the next install lock sweeps
								await removeTree(old).catch((err) => console.log(`Could not delete ${old}: ${err.message}`));
							}
						}
						if (!(await exists(sharedApp))) console.log(`Set up ${sharedApp} from ${await setupApp()}`);
					});
				}
				if (!(await exists(instanceDir))) throw new Error(`Instance ${instance} was removed while this start waited`);
				// Armed once the lock is held, so waiting for another start doesn't use up the time of this one
				let copiedLogin = false;
				// Only graceful ends are covered (failure, timeout): a start killed hard leaves it for remove, as SKILL.md says
				// A start that failed must not leave the daily client's refresh token in the profile: deleted once TIDAL is stopped
				// (The IndexedDB key useCopiedLogin sets stays: harmless without the token, remove deletes the profile)
				const dropCopiedLogin = async () => {
					// Once: the failing flow and the timeout both end here
					if (!copiedLogin) return;
					copiedLogin = false;
					await rm(join(profileDir, "Local Storage", "leveldb"), { recursive: true, force: true }).then(
						() => console.error(`Deleted the copied login of the daily client from ${profileDir}`),
						() => console.error(`The daily client's login is in ${profileDir}: run remove --instance ${instance} to delete it`),
					);
				};
				// Not stopped: TIDAL may still hold the folder, so it is left for remove
				const keepLoginHint = () =>
					copiedLogin && console.error(`The daily client's login is in ${profileDir}: run remove --instance ${instance} to delete it`);
				// One cleanup for the failing flow and the timeout: the one that comes second waits for it, not exits in the middle of it
				let cleanup;
				const cleanUp = () => (cleanup ??= stopIfSpawned().then(dropCopiedLogin, keepLoginHint));
				armTimeout(180, async () => {
					// This process holds the lock and exits without releasing it
					await cleanUp().finally(() => unlockOwn(lockFile));
				});
				try {
					await launch();
					// loggedInSession, not session: right after a load userId is still null for a logged in instance, which would copy the login again
					let { userId } = await loggedInSession();
					// --no-login: stays logged out, to test what a logged out client does. A start without it asks for the login, so a running logged out instance (also one left by a start killed before the copy) is restarted with it
					if (userId === null && !noLogin && (await exists(join(platform.dailyProfile, "Local Storage")))) {
						console.log(`Logged out, copying the login of the daily client in ${platform.dailyProfile}`);
						// A start that fails from here on leaves the instance stopped (it was killed for the copy), not running
						await stopInstance();
						// Set first: a copy that fails halfway leaves part of the login
						copiedLogin = true;
						await copyDailyLogin();
						await launch();
						if ((await evalInPage(`(${useCopiedLogin})()`)).value === true) {
							await reloadPage();
							({ userId } = await loggedInSession());
						}
					}
					const login = userId === null ? "logged out" : `logged in as user ${userId}`;
					const { devtools, inspector } = await hostState();
					console.log(
						`Instance ${instance} running, Luna loaded, ${login} (CDP ${new URL(devtools).port}, main process inspector ${new URL(inspector).port})`,
					);
					if (copiedLogin) console.log(`It holds a copy of the daily client's login: run remove --instance ${instance} when finished`);
					if (created) console.log(`Pass --instance ${instance} to every later command, batch steps with repl.`);
				} catch (err) {
					// A start that failed after launching leaves nothing running (also when it restarted the instance itself to copy the login)
					await cleanUp();
					throw err;
				}
			},
			{ seconds: 1000, staleSeconds: instanceLockStale, onWait: () => console.log(`Waiting for another command on instance ${instance}`) },
		);
		process.exit(0);
	}
	case "stop": {
		// Not under the instance lock, deliberately: stop is how a hung start gets killed (that start then fails and cleans up). --all includes instances still starting for that reason too (documented in SKILL.md)
		if (!all && !(await exists(instanceDir))) throw new Error(`Instance ${instance} doesn't exist`);
		if (all) {
			const running = [];
			for (const name of await instances()) if ((await instanceState(name)) !== "stopped") running.push(name);
			const failed = [];
			// One that can't be stopped doesn't keep the others running
			for (const name of running)
				await requestStop(join(root, name, "stop.request"))
					.catch(() => {})
					.then(() => stopInstance(name))
					.catch((err) => failed.push(`${name} (${err.message})`));
			const stopped = running.filter((name) => !failed.some((entry) => entry.startsWith(`${name} `)));
			if (running.length === 0) console.log("No instance running");
			else if (stopped.length > 0) console.log(`Stopped ${stopped.join(", ")}`);
			if (failed.length > 0) throw new Error(`Could not stop ${failed.join(", ")}`);
			break;
		}
		await requestStop(stopRequestFile).catch(() => {});
		await stopInstance();
		console.log(`Stopped instance ${instance}`);
		break;
	}
	case "remove": {
		if (!(await exists(instanceDir))) throw new Error(`Instance ${instance} doesn't exist`);
		// A start in progress is stopped first (it holds the lock until it is done or timed out), then waited for under the lock: not spawned into a folder being deleted
		await requestStop(stopRequestFile).catch(() => {});
		await stopInstance();
		await withLock(
			lockFile,
			async () => {
				await stopInstance();
				// removeTree never enters links: an older instance's own install holds a junction to this repo's dist/. Retried: Windows may hold the profile's files a moment after their process is gone
				for (let attempt = 1; ; attempt++) {
					try {
						await removeTree(instanceDir);
						break;
					} catch (err) {
						if (attempt === 5)
							throw new Error(`${err.message}
The folder ${instanceDir} is partly deleted: run remove --instance ${instance} again before using it`);
						await sleep(500);
					}
				}
			},
			{ seconds: 1000, staleSeconds: instanceLockStale, onWait: () => console.log(`Waiting for another command on instance ${instance}`) },
		);
		console.log(`Removed instance ${instance}, with its profile and login`);
		break;
	}
	case "reload":
	case "eval":
	case "native":
	case "screenshot": {
		console.log(await shared[command](arg));
		break;
	}
	case "wait": {
		console.log(await shared.wait(arg, seconds));
		break;
	}
	case "logs": {
		// The host has the page console since TIDAL started. Only lines after --since, then new ones until the time is up
		let next = Number(since ?? 0);
		const end = Date.now() + seconds * 1000;
		do {
			const logs = await readLogs(next);
			for (const line of logs.lines) console.log(line);
			next = logs.next;
		} while (Date.now() < end && (await sleep(500), true));
		console.log(`(next: --since ${next})`);
		break;
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
	case "repl": {
		// One line in, its result out, with the line echoed as "> line" so a heredoc batch's output stays readable.
		// Lines are expressions (page, main process with --native) or ":<command> <arg>", see replCommands
		let logCursor = (await readLogs(0)).next;
		const replCommands = {
			...shared,
			wait: (rest) => {
				const { expression, seconds } = parseWait(rest);
				return shared.wait(expression, seconds);
			},
			logs: async () => {
				const logs = await readLogs(logCursor);
				logCursor = logs.next;
				return logs.lines.length === 0 ? "(no new logs)" : logs.lines.join("\n");
			},
			cdp: async (rest) => {
				const { method, params } = parseCdpLine(rest);
				return cut(JSON.stringify(await cdpSession.send(method, params)));
			},
		};
		let cdpSession;
		for await (const line of createInterface({ input: process.stdin })) {
			if (line.trim() === "") continue;
			console.log(`> ${line.length > 80 ? `${line.slice(0, 80)}…` : line}`);
			const { name, rest } = parseReplLine(line);
			const run = async () => {
				if (name === undefined) return shared[native ? "native" : "eval"](line);
				if (!(name in replCommands)) throw new Error(`Unknown :${name}, use one of :${Object.keys(replCommands).join(" :")}`);
				// One page session for all :cdp lines, so a domain's enable applies to later calls
				if (name === "cdp" && cdpSession === undefined) {
					cdpSession = await connect(await pageTarget());
					// If the page target goes away, the next :cdp opens a new one
					const forget = () => (cdpSession = undefined);
					cdpSession.closed.then(forget, forget);
				}
				return replCommands[name](rest);
			};
			// Per line, like the single commands' timeout: a blocked main process must not hang the batch
			const timeout = armTimeout(name === "wait" ? parseWait(rest).seconds + 30 : 90);
			console.log(await run().catch(errorLine));
			clearTimeout(timeout);
		}
		cdpSession?.close();
		process.exit(0);
	}
	case "cdp": {
		// Calls run in order on one session, so a domain's enable applies to the calls after it
		const session = await connect(await (native ? nativeTarget : pageTarget)());
		for (const { method, params } of parseCdpCalls(args.slice(1)))
			console.log(`${method}: ${cut(JSON.stringify(await session.send(method, params)))}`);
		session.close();
		break;
	}
}
