# Test instances: extra TIDAL clients for Luna / plugin development

Run one or more separate TIDAL clients next to your daily one, each with its own profile, its own Luna build and
its own DevTools port. Useful for testing a dev Luna build or a plugin without touching your daily client, for
comparing builds side by side, or for driving the client from scripts over CDP.

Written for Windows (tested with TIDAL 2.48). The flags are standard Electron/Chromium flags, but the paths and
the login workaround below have only been tested on Windows.

## How it works

- TIDAL's single-instance lock is per profile (`--user-data-dir`), so a client started with its own
  `--user-data-dir` runs next to the daily client and next to other test instances.
- Each instance runs from its **own copy** of the TIDAL install, so a dev Luna build installed into the copy does
  not affect the daily client.
- Each instance gets its own `--remote-debugging-port` (renderer DevTools / CDP) and, if you need the main process,
  its own `--inspect` port.

## 1. Copy the install

```bat
robocopy "%LOCALAPPDATA%\TIDAL\app-2.48.0" "C:\tidal-test\1\app" /E
```

Use your installed version (`app-x.xx.x`). Copy it while it is still vanilla (`resources\app.asar`, no
`resources\app` folder); if your daily client already runs Luna, copy `resources\original.asar` to
`resources\app.asar` in the copy and delete `resources\app` there.

The copy is not updated with your daily client; copy the new version again when TIDAL updates.

## 2. Install Luna into the copy

Same as the _Manual Install_ in the [README](../README.md), but inside the copy:

```bat
cd /d C:\tidal-test\1\app\resources
ren app.asar original.asar
mklink /D app C:\path\to\TidaLuna\dist
```

The symlink to `dist` (with `pnpm run watch` running) is handy for client development; copy `dist` or a
release `luna.zip` there instead if you want the instance to keep a fixed build.

## 3. Start it

```bat
C:\tidal-test\1\app\TIDAL.exe ^
  --user-data-dir=C:\tidal-test\1\profile ^
  --remote-debugging-port=9231 ^
  --inspect=127.0.0.1:9331 ^
  --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding
```

- `--user-data-dir`: the profile (login, Luna settings and installed plugins). Use one folder per instance.
- `--remote-debugging-port`: DevTools / CDP for the page. Open `chrome://inspect` in Chrome or Edge, add
  `127.0.0.1:9231` under _Configure…_, or connect from a script via `http://127.0.0.1:9231/json`.
- `--inspect`: Node inspector for Electron's main process (Luna's native side). Only needed for the login
  workaround below or for debugging native code. Pick ports that are free; 9229 is Node's default and often taken.
- The three `--disable-*` flags stop Chromium from throttling the page when the window is hidden behind other
  windows or minimized, so timers, rendering and CDP screenshots keep working while you use the daily client.

For a second instance use another folder and other ports (`C:\tidal-test\2\…`, 9232, 9332, …).

A brand-new profile sometimes opens `renderer_crash.html` on its very first start; reload or restart it once.

## 4. Log in

### Copy the daily client's login

TIDAL keeps its login only in the profile's `Local Storage` (`AuthDB/<storageKey>…` entries, encrypted with a key
derived from the storage key, not with anything tied to the machine or profile). It picks the entry belonging to its
`clientUniqueKey`, which it keeps in IndexedDB (localforage, key `_TIDAL_clientUniqueKey`).

So, with the test instance stopped, copy `%APPDATA%\TIDAL\Local Storage` over the instance's
`profile\Local Storage` (skip the `LOCK` file; the daily client can keep running), start it, set its
`_TIDAL_clientUniqueKey` to the daily client's and reload. Don't copy `IndexedDB`: it also holds Luna's plugins and
settings. The [test instance skill](../.claude/skills/tidal-test-instance/tidal.mjs) does all this on `start` when the
instance is logged out (`copyDailyLogin`, `useCopiedLogin`).

Sharing the login is safe for the daily client: TIDAL doesn't rotate refresh tokens (a refresh returns no new
`refresh_token`), so a refresh in either client doesn't invalidate the other's.

### Log in in the test instance

Use this to log in with another account. Clicking _Log in_ in a test instance opens login.tidal.com in your system browser, and the browser hands the result
(`tidal://login/auth?code=…`) to the TIDAL that is registered for `tidal://` — your daily client, never the test
instance. The test instance stays logged out.

Workaround: make the test instance open the login page in a window of its own and catch the `tidal://` redirect
there. Start the instance with `--inspect` (see above), open `chrome://inspect`, add `127.0.0.1:9331` under
_Configure…_, click _inspect_ on the Node target and run this in its console:

```js
(() => {
	const { app, shell, BrowserWindow } = process.getBuiltinModule("module").createRequire(process.execPath)("electron");
	const openExternal = shell.openExternal;
	shell.openExternal = async (url, opts) => {
		if (!String(url).startsWith("https://login.tidal.com/")) return openExternal.call(shell, url, opts);
		// webPreferences is required by Luna's BrowserWindow wrapper
		const win = new BrowserWindow({ width: 520, height: 760, title: "TIDAL login (test instance)", webPreferences: {} });
		const onTidalUrl = (e, target) => {
			if (!String(target).startsWith("tidal:")) return;
			e.preventDefault();
			setImmediate(() => win.destroy());
			shell.openExternal = openExternal;
			// what TIDAL does when the OS hands it a tidal:// link
			app.emit("second-instance", {}, [process.execPath, String(target)], process.cwd());
		};
		win.webContents.on("will-navigate", onTidalUrl);
		win.webContents.on("will-redirect", onTidalUrl);
		win.loadURL(url);
	};
	return "login hook installed";
})();
```

Then click _Log in_ in the test instance and log in in the window that opens. The session is stored in that
instance's profile only, so this is needed once per profile. Public pages (albums, playlists) also work without
logging in.

## Gotchas

- **Some state is shared with the daily client.** TIDAL keeps a few files outside `--user-data-dir`:
  `%APPDATA%\TIDAL\settings` (window position and size, among others) and `%APPDATA%\TIDAL\Logs\app.log`.
  Don't move or resize test windows: the last position saved wins, and your daily client may then open where the
  test window was, possibly off-screen. Expect log lines from all instances in the same `app.log`.
- **One device plays at a time per account.** Starting playback in a test instance logged in with your account
  pauses the daily client (and the other way round). Use a second account, or avoid playback while listening.
- **"Plugin Permission Request" window.** The first time a plugin's native code (`*.native.ts`) requires modules
  such as `fs`, `http`, `electron` or `child_process`, Luna asks once per native file in a window of its own,
  listing what the file wants by category (Network Access, Filesystem, …). The plugin waits for the answer, so keep
  the instance's windows visible while installing or enabling such plugins. A rebuilt plugin asks again only for
  categories allowed for "This version"; "All versions" (confirmed in a second step) keeps the answer for later
  builds from the same url.
  A module first used after the file has loaded is still asked in a modal message box, which blocks the main
  process (CDP calls time out) until it is answered. Answers are listed, and can be revoked, in Luna Settings.
- **TIDAL Connect** uses fixed local ports, so only one instance (daily or test) can offer it at a time.
- **Stopping an instance.** Quit it normally, or kill its processes by path. `taskkill /IM TIDAL.exe` kills every
  TIDAL, including the daily client:
  ```powershell
  Get-Process TIDAL, TIDALPlayer -ErrorAction SilentlyContinue | ? Path -like 'C:\tidal-test\1\app\*' | Stop-Process
  ```
