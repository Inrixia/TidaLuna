# Core plugins load

Requires: none (logged out is fine)

Check that Luna and every core plugin load in TIDAL without errors.

1. `start` the instance (it waits for Luna).
2. Core plugins load after `start` returns (`render/src/index.ts` loads them one by one in a `setTimeout`, `@luna/dev` last), so poll up to 20 s until every expected one has loaded or failed, then list them:
   `eval '(async () => { const expected = ["@luna/lib.native", "@luna/lib", "@luna/ui", "@luna/dev", ...(__platform === "linux" ? ["@luna/linux"] : [])]; const settled = (name) => Object.values(luna.core.LunaPlugin.plugins).some((p) => p.name === name && (luna.core.modules[name] !== undefined || p.loadError._ !== undefined)); let waitedMs = 0; while (!expected.every(settled) && waitedMs < 20000) { await new Promise((resolve) => setTimeout(resolve, 250)); waitedMs += 250; } return { waitedMs, missing: expected.filter((name) => !settled(name)), plugins: Object.values(luna.core.LunaPlugin.plugins).map((p) => ({ name: p.name, enabled: p.enabled, loaded: luna.core.modules[p.name] !== undefined, loadError: p.loadError._ })) }; })()'`
3. `logs` and look for uncaught exceptions or `[@luna/` errors logged during load.

Pass when `missing` is empty and `@luna/lib`, `@luna/lib.native`, `@luna/ui` and `@luna/dev` (and `@luna/linux` on Linux) are listed, enabled, loaded, with no `loadError`, and the logs show no uncaught exception from Luna or a core plugin. List any warning you saw even on a pass.
