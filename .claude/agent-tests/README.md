# Agent tests

Checks that need a running TIDAL and can't be unit tests: whether Luna still finds TIDAL's internals after a TIDAL update, whether the core plugins load, whether `@luna/lib` still reads real TIDAL data. A Claude agent ([Claude Code](https://code.claude.com) in print mode) drives a TIDAL test instance through `.claude/skills/tidal-test-instance/tidal.mjs` and reports `RESULT: PASS` or `RESULT: FAIL`.

Each `*.md` here (other than this README) is one scenario: what to check and what counts as a pass.

## Run

They cost money and need a TIDAL test instance, so they run only by hand, never on push or PR.

- Locally: `pnpm run build`, have a test instance set up (`tidal.mjs setup`, see the skill), then `node .claude/agent-tests/run.mjs [scenario ...]` (no names = all). Needs the `claude` CLI signed in or `ANTHROPIC_API_KEY`.
- GitHub: Actions → "Agent tests" → Run workflow. Runs on a self-hosted runner labelled `tidal` that has TIDAL installed and a test instance set up (GitHub-hosted runners have no TIDAL). Needs the `ANTHROPIC_API_KEY` secret.

Options: `--model <id>` (default `claude-sonnet-5-5`), `--budget <usd>` (most a scenario may spend, default 1.5), `--instance <n>` (default 1), `--timeout <minutes>` (most a scenario may run, default 15; a run that hits it counts as ERROR and the instance is stopped). Results, with each run's cost, go to `.tidal-test/agent-tests/<timestamp>/`. The workflow uploads only this run's `summary.json` (verdicts and costs; `run.mjs` names its folder in `$GITHUB_OUTPUT`), since artifacts of a public repo are public; the replies stay on the runner.

## Cost

Billed per token at API prices. Sonnet 5.5 is $2 input / $10 output per million tokens (cache reads $0.10); Opus 5.5 is $4 / $20. A scenario is typically 10–30 tool calls; most input is cached context, so expect roughly **$0.20–1 per scenario on Sonnet 5.5** and about twice that on Opus 5.5, so **about $2–6 for the full set** on Sonnet. `--budget` caps a runaway scenario; the cost of each run is printed and saved in `summary.json`. Run them before a release, after a TIDAL update, or when a change touches `exposeTidalInternals*`, `tidalPatches` or `@luna/lib`, not on every change.

## Rules the agent gets

Logged-out scenarios don't need an account. Logged-in ones use the account copied by `tidal.mjs start`. The agent must not start playback (it would pause the user's daily client), move or resize the window, install plugins from the internet, or change files in the repo. It may only run `tidal.mjs` commands and read files, and keeps account details (names, emails, ids, tokens, library titles) out of its reply.

## Writing a scenario

Say what to check, how (which `eval`/`native` expressions or UI steps), and the exact pass condition. Keep it to one area so a failure says what broke. Scenarios that need login say so in a `Requires: login` line.
