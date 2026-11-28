# Live checks for tidal.mjs

`lib.test.ts` covers parsing and the host API. These cover what needs a real TIDAL. Run them after changing `tidal.mjs`, ideally by two agents at once (each step in its own instance) to also check isolation. `T` below is `node .agents/skills/tidal-test-instance/tidal.mjs`.

1. `pnpm run build`, then `T start`: prints a new random instance name and its debugging urls within ~60s. No console window appears and the TIDAL window opens behind the focused one, never taking the focus.
2. One repl batch, every line answers and an error doesn't stop the rest:

   ```bash
   T repl --instance <name> <<'EOF'
   Object.keys(luna.core.modules).length
   :native process.pid
   :native require("electron").BrowserWindow.getAllWindows().map((win) => [win.isVisible(), win.isFocused()])
   :reload
   :wait 10 !document.querySelector('#wimp > #app-loader')
   luna.lib.redux.actions["router/PUSH"]({ pathname: "/my-collection/albums", replace: true })
   :wait 10 location.pathname.includes("albums")
   :screenshot shot.png
   console.log("marker")
   :logs
   nope(
   :cdp Runtime.evaluate {"expression":"1+1"}
   :unknown
   EOF
   ```

   Expect: a module count, a pid, `[[true, ...]]` (visible; the second value is Electron's own focus, `true` was seen while another app's window stayed in the foreground: check the foreground window is yours, not this value), `Reloaded instance <name>, Luna loaded`, `true`s, `Saved shot.png`, `marker` among the logs, a `SyntaxError` line, a `Runtime.evaluate` result of 2, and `Unknown :unknown`.

3. `shot.png` shows the Albums page, not a stale frame.
4. `T list` shows the instance as running (and the other agent's, if two run).
5. `T logs --instance <name>` shows only this instance's console.
6. `T stop --instance <name>`: `T list` shows it stopped, and no TIDAL or host process with its profile path is left (`Get-CimInstance Win32_Process | ? CommandLine -like '*<name>*'` on Windows, `pgrep -af <name>` on Linux).
7. `T start --instance <name>` twice at once (two shells): both print the same running instance, `T stop --instance <name>` afterwards leaves nothing running. `host.json` is still there while it runs.
8. `T start --no-login` prints `logged out` and no `Logged out, copying` line. `T remove --instance <name>` stops it and the folder is gone from `T list` and `.tidal-test/`.
9. `T stop --all` stops every running instance of this worktree and lists them.
10. `T stop` and `T stop --all` while another `start` of that instance waits (hold `.tidal-test/.<name>.instance.lock` with a live pid, run `T start --instance <name> --no-login`, run `T stop --all`, delete the lock): the start ends with "was stopped by a stop command" and no TIDAL runs.
11. An old `.tidal-test/.app` without `.copied` (hard links, a junction `resources/app` to `dist/` and one to a scratch folder): the next `T start` replaces it by a copy, `dist/` and the scratch folder keep their files.
