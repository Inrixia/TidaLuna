// Runs agent test scenarios (.claude/agent-tests/*.md) with the Claude Code CLI against a TIDAL test instance.
// Usage: node .claude/agent-tests/run.mjs [--model <id>] [--budget <usd>] [--instance <n>] [--timeout <minutes>] [scenario ...]
// See README.md here. Costs money: runs only when asked.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const tidal = "node .claude/skills/tidal-test-instance/tidal.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return fallback;
	const [, value] = args.splice(i, 2);
	if (value === undefined) throw new Error(`--${name} needs a value`);
	return value;
};
const model = option("model", "claude-sonnet-5-5");
const budget = option("budget", "1.5");
const instance = option("instance", "1");
const timeoutMinutes = option("timeout", "15");
if (!/^\d+$/.test(instance)) throw new Error("--instance must be a number");
if (!/^[1-9]\d*$/.test(timeoutMinutes)) throw new Error("--timeout must be a whole number of minutes");
// These go through cmd on Windows, so allow only plain values
if (!/^[\w.-]+$/.test(model)) throw new Error("--model must be a model id");
if (!/^\d+(\.\d+)?$/.test(budget)) throw new Error("--budget must be a number of USD");

const all = readdirSync(here)
	.filter((file) => file.endsWith(".md") && file !== "README.md")
	.map((file) => basename(file, ".md"));
const wanted = args.length ? args : all;
for (const name of wanted) if (!all.includes(name)) throw new Error(`No scenario ${name}. Have: ${all.join(", ")}`);

const rules = `You are running one Luna agent test against TIDAL test instance ${instance}.
Read .claude/skills/tidal-test-instance/SKILL.md first. Drive TIDAL only with \`${tidal} --instance ${instance} <command>\`.
Rules: never start playback, never move or resize the window, never run \`setup\`, never install plugins from the internet, never edit or create files in the repo outside \`.tidal-test/\` (ignored by git; \`dump\` writes there; put screenshots in the system temp dir). Your reply is saved and may be shared: keep account names, emails, user ids, tokens and the titles in the account's library out of it, give counts and types instead. If the instance is frozen or a Security Warning dialog is open, stop and report FAIL with that reason.
When done, \`stop\` the instance, then end your reply with a line \`RESULT: PASS\` or \`RESULT: FAIL\`, followed by a short reason and what you saw.

Scenario:
`;

const outDir = join(repo, ".tidal-test", "agent-tests", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });
// In GitHub Actions: tell the workflow which run is this one, earlier ones stay in .tidal-test/agent-tests/
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `dir=${outDir}\n`);

const stopInstance = () => spawnSync(`${tidal} --instance ${instance} stop`, { cwd: repo, shell: true, stdio: "ignore" });
// Every scenario starts a fresh TIDAL: stop one left running from before
stopInstance();
const results = [];
for (const name of wanted) {
	process.stdout.write(`${name}: running... `);
	const prompt = rules + readFileSync(join(here, `${name}.md`), "utf8");
	const cliArgs = ["-p", "--model", model, "--max-budget-usd", budget, "--output-format", "json"];
	cliArgs.push("--allowedTools", `Bash(${tidal} *)`, "Read", "Grep", "Glob");
	// On Windows an npm-installed claude is a .cmd, which needs a shell: quote every argument for it
	const shell = process.platform === "win32";
	const run = spawnSync("claude", shell ? cliArgs.map((arg) => `"${arg}"`) : cliArgs, {
		cwd: repo,
		input: prompt,
		encoding: "utf8",
		shell,
		maxBuffer: 64 * 1024 * 1024,
		// A stuck run counts as ERROR. (On Windows this kills the shell, which can leave claude itself running)
		timeout: Number(timeoutMinutes) * 60 * 1000,
	});
	const timedOut = run.error?.code === "ETIMEDOUT";
	// Always stop the instance (again), so the next scenario starts a fresh TIDAL even if this agent ran out of budget, crashed or timed out
	stopInstance();
	let reply = run.stdout;
	let cost;
	try {
		const json = JSON.parse(run.stdout);
		reply = json.result ?? "";
		cost = json.total_cost_usd;
	} catch {}
	// The last one: the reply may quote the rules' `RESULT: PASS` before giving its own verdict
	const verdict = timedOut ? "ERROR" : ([...(reply ?? "").matchAll(/RESULT:\s*(PASS|FAIL)/g)].at(-1)?.[1] ?? "ERROR");
	writeFileSync(join(outDir, `${name}.txt`), `${reply}\n\n--- stderr ---\n${run.stderr ?? ""}`);
	results.push({ name, verdict, cost, ...(timedOut && { timedOut: true }) });
	console.log(`${verdict}${timedOut ? ` (timed out after ${timeoutMinutes} min)` : ""}${cost === undefined ? "" : ` ($${cost.toFixed(2)})`}`);
}

const total = results.reduce((sum, { cost }) => sum + (cost ?? 0), 0);
writeFileSync(join(outDir, "summary.json"), JSON.stringify({ model, results, totalCostUsd: total }, null, "\t"));
console.log(`Total $${total.toFixed(2)}. Replies in ${outDir}`);
process.exitCode = results.every(({ verdict }) => verdict === "PASS") ? 0 : 1;
