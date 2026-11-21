// Drives a TIDAL test instance for Luna development: a copy of the TIDAL install with its own profile, running this repo's dist/ as Luna.
// Instances live in <repo>/.tidal-test/<n>/ (gitignored). Node 22+, no dependencies. Windows and Linux (tidal-hifi).
//   node tidal.mjs [--instance <n>] setup [installDir] | start | stop | eval "<expression>" | screenshot <out.png>
import { execFileSync, spawn } from "node:child_process";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = 'Usage: node tidal.mjs [--instance <n>] setup [installDir] | start | stop | eval "<expression>" | screenshot <out.png>';
const args = process.argv.slice(2);
let instance = "1";
const instanceFlag = args.indexOf("--instance");
if (instanceFlag !== -1) [, instance] = args.splice(instanceFlag, 2);
const [command, arg] = args;
if (
	!/^\d+$/.test(instance ?? "") ||
	!["setup", "start", "stop", "eval", "screenshot"].includes(command) ||
	(["eval", "screenshot"].includes(command) && arg === undefined)
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
const exists = (path) =>
	lstat(path).then(
		() => true,
		() => false,
	);

const pageTarget = async () => {
	const targets = await fetch(`http://127.0.0.1:${port}/json`)
		.then((res) => res.json())
		.catch(() => undefined);
	const pages = targets?.filter((target) => target.type === "page") ?? [];
	return pages.find((target) => /tidal\.com/.test(target.url)) ?? pages[0];
};

const evaluate = async (method, params) => {
	const page = await pageTarget();
	if (page === undefined) throw new Error(`Instance ${instance} isn't running (nothing on CDP port ${port}), run start first`);
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = () => rej(new Error(`Could not connect to ${page.webSocketDebuggerUrl}`));
	});
	try {
		return await new Promise((res, rej) => {
			ws.onmessage = ({ data }) => {
				const message = JSON.parse(data);
				if (message.error !== undefined) rej(new Error(message.error.message));
				else res(message.result);
			};
			ws.send(JSON.stringify({ id: 1, method, params }));
		});
	} finally {
		ws.close();
	}
};
const evalInPage = async (expression) => {
	const { result, exceptionDetails } = await evaluate("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
	return result;
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const launch = async () => {
	if (!(await exists(appDir))) throw new Error(`Instance ${instance} isn't set up, run setup first`);
	if ((await pageTarget()) === undefined) {
		// Set by VS Code's terminal, it makes Electron run as plain Node
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE;
		const flags = ["--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"];
		spawn(join(appDir, platform.exe), [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, ...flags, ...platform.flags], {
			detached: true,
			stdio: "ignore",
			env,
		}).unref();
	}
	for (let tries = 0; tries < 60; tries++) {
		const loaded = await evalInPage("!!window.luna?.core").catch(() => undefined);
		if (loaded?.value === true) return;
		await sleep(1000);
	}
	throw new Error("Luna didn't load within 60s. A new profile can open renderer_crash.html on first start: stop and start again.");
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
const session = async () => {
	for (let tries = 0; tries < 30; tries++) {
		const session = await evalInPage("window.luna?.lib?.redux.store.getState().session").catch(() => undefined);
		if (session?.value?.isInitialized && !session.value.isLoading) return session.value;
		await sleep(1000);
	}
	throw new Error("TIDAL's session didn't initialize within 30s");
};
/** Right after a load the session reports initialized with `userId` still null, the login follows a moment later */
const loggedInSession = async () => {
	for (let tries = 0; tries < 20; tries++) {
		const restored = await session();
		if (restored.userId !== null) return restored;
		await sleep(500);
	}
	return await session();
};

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
const timeout = command === "start" ? 180 : 90;
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
				await evaluate("Page.reload");
				await launch();
				({ userId } = await loggedInSession());
			}
		}
		console.log(`Instance ${instance} running, Luna loaded, ${userId === null ? "logged out" : `logged in as user ${userId}`} (CDP port ${port})`);
		process.exit(0);
	}
	case "stop": {
		await stopInstance();
		console.log(`Stopped instance ${instance}`);
		break;
	}
	case "eval": {
		const result = await evalInPage(arg);
		console.log(result.value === undefined ? (result.description ?? result.type) : JSON.stringify(result.value, null, 2));
		break;
	}
	case "screenshot": {
		const { data } = await evaluate("Page.captureScreenshot", { format: "png" });
		await writeFile(arg, Buffer.from(data, "base64"));
		console.log(`Saved ${arg}`);
		break;
	}
}
