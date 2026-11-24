# Redux action types match TIDAL

Requires: none

`plugins/lib/src/redux/types` lists TIDAL's Redux action types with typed payloads. Plugins call `redux.actions[type]` and `redux.intercept(type, ...)` with them; a type TIDAL removed or renamed fails only at runtime.

1. `start`.
2. Collect the action type names from `plugins/lib/src/redux/types` (read the files; types are keys like `"playbackControls/PLAY"`).
3. `eval 'Object.keys(luna.core.buildActions)'` and compare.
4. Grep `plugins/` and `render/src` for action types the code actually uses (`actions["..."]`, `intercept("...")`, `interceptActionResp`), and check each exists in `buildActions`.

Pass when every type used in code exists in TIDAL. Report, separately, typed names missing from TIDAL and TIDAL types missing from the typings (count, plus up to 20 examples each); those are drift notes, not a fail.
