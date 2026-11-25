# Smoke checks

Deterministic checks for the things that need a running TIDAL: whether Luna still finds TIDAL's internals after a TIDAL
update, whether the core plugins load, whether `@luna/lib` still reads real data, whether the native bridge still works.
The unit tests can't reach these, and they can't be judged by reading a log either.

Three parts:

|                           | What                                                                                       | Needs TIDAL | Runs                                   |
| ------------------------- | ------------------------------------------------------------------------------------------ | ----------- | -------------------------------------- |
| `pnpm test`               | `tidalPatches.test.ts`, `reduxActionTypes.test.ts`, `smokeChecks.test.ts`, `smoke.test.ts` | no          | every PR                               |
| `scripts/checkPatches.ts` | every `tidalPatches` entry against a `tidal.mjs dump`                                      | a dump      | when you have one                      |
| `scripts/smoke.ts`        | the probes, end to end                                                                     | yes         | before a release, after a TIDAL update |

## Why not an agent

`tidal.mjs eval` prints `JSON.stringify(result.value)`, so every probe already returns data. A verdict read out of a
model's prose is non-deterministic, can't gate a PR, costs money per run, and cannot be reviewed, because the assertion
is English. Worse, a scenario that says "adapt to the class's current methods" derives the expected behaviour from the
code under test, so a broken contract gets adopted as the expected answer. Everything here is a comparison.

## How a verdict is decided

`smokeChecks.ts` takes observations and returns `pass` / `warn` / `fail` per check. It touches no TIDAL, so it is covered
by unit tests on every PR - including the cases it exists to catch, because a checker that cannot fail is worthless.

`smoke.ts` is the thin layer that fills the observations in, and it has two modes:

```bash
pnpm exec tsx scripts/smoke.ts                  # drive a live instance (needs .tidal-test/1)
pnpm exec tsx scripts/smoke.ts --from obs.json  # replay a saved run, no TIDAL needed
pnpm exec tsx scripts/smoke.ts --keep           # leave the instance running
```

A live run saves what it observed to `.tidal-test/smoke/observations.json`, so a failure can be replayed and debugged
without starting TIDAL again. Replaying the same observations always gives the same output; that is asserted in
`smoke.test.ts`.

A probe that throws, prints nothing or prints something unparseable is recorded as missing, and a missing observation is
a **failure**, not a pass. A skipped probe must never look like a healthy app.

## What each check means

| Check                             | Fails when                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| core plugins load                 | one is not registered, not enabled, not loaded, or has a `loadError`                                                          |
| TIDAL internals captured          | fewer than 100 modules or action creators, or a store with no keys - the numbers are effectively zero when the capture breaks |
| TIDAL patches still apply         | a patch's marker is present but its pattern no longer matches (`stale`), so its fix is silently missing                       |
| interceptors run on TIDAL actions | no `router/NAVIGATED` reached an interceptor within 5s                                                                        |
| native bridge round-trips         | the page and the main process disagree, or a non-cloneable argument neither rejected nor errored                              |
| StyleTag applies and unloads      | the style did not apply, or `unloadSet` did not remove it                                                                     |
| TIDAL action types still exist    | a type this repo names is gone from TIDAL's action creators                                                                   |
| action types match the snapshot   | only a warning: TIDAL added or removed types, so `actionTypes.ts` wants regenerating                                          |
| `@luna/lib` reads real media data | a call threw, or returned nothing where TIDAL has the data (skipped without a login)                                          |

## The offline half

`plugins/lib/src/redux/types/actions/actionTypes.ts` is a copy of `Object.keys(luna.core.buildActions)` taken from TIDAL.
Every action type this repo refers to is a string literal, so `reduxActionTypes.test.ts` checks the whole namespace
against that copy on every PR, with no instance: a type TIDAL removed that this repo still names would otherwise fail
only at runtime, when `redux.actions["..."]` turns out to be `undefined`.

`checkPatches.ts` does the same for the patch list:

```bash
node .claude/skills/tidal-test-instance/tidal.mjs dump
pnpm exec tsx scripts/checkPatches.ts            # or pass a dump dir
```

It prints `applied` / `stale` / `noop` / `absent` per patch and exits 1 if a patch that should apply no longer does.
`absent` is a warning rather than a failure: a dump only contains the pages that were opened.

## Rules for a live run

The probes read state; they do not start playback, move the window, install plugins or write to the repo. The
login-dependent check does not put account data in its output - it reports counts and verdicts, not titles or ids.

## Running it on a runner (`.github/workflows/smoke.yml`)

Manual (`workflow_dispatch`) only, for release prep and after a TIDAL update. It is not on push or PR because it needs a
real client, and that is the whole reason the offline half exists to carry the every-PR load.

What the runner has to provide, none of which a GitHub-hosted runner has:

|                                                              | Why                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| label `tidal` (configurable)                                 | the workflow targets `runs-on: <runner>`                                                                                                                     |
| TIDAL installed (Windows) or tidal-hifi at `/opt/tidal-hifi` | `setup` copies the installed app; it cannot download one                                                                                                     |
| a desktop session                                            | `start` launches the real Electron app, and there is no headless mode                                                                                        |
| a logged-in daily profile                                    | the instance copies `%APPDATA%\TIDAL` / `~/.config/tidal-hifi` to be logged in. Logged out, the media check reports `skipped` and everything else still runs |
| macOS? no                                                    | `tidal.mjs` only knows `win32` and `linux`                                                                                                                   |

The first run copies a few hundred MB into `.tidal-test/<n>/app` (hence `clean: false`, which keeps it), so it is a
one-off cost per runner. The checks themselves take seconds.

Only `summary.json` is uploaded: a Markdown table of check, verdict and reason. `observations.json` stays on the runner,
because a logged-in run holds library titles and filesystem paths and this repository's artifacts are public. For the
same reason the details themselves carry counts, names and shapes - never a title, an id or an account.
