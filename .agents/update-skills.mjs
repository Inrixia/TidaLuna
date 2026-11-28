import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Lives at .agents/update-skills.mjs. Vendors shared agent skills into .agents/skills/.
// Config: `agentSkills` in package.json, else .agents/skills.json (non-Node repos).
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const pkgConfig = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")).agentSkills : undefined;
const { source, ref, skills } = pkgConfig ?? JSON.parse(readFileSync(join(root, ".agents", "skills.json"), "utf8"));

if (typeof source !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
	throw new Error(`Invalid agentSkills.source: ${source}`);
}
if (typeof ref !== "string" || !/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith("-")) {
	throw new Error(`Invalid agentSkills.ref: ${ref}`);
}
if (!Array.isArray(skills) || skills.some((s) => typeof s !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(s))) {
	throw new Error("Invalid agentSkills.skills");
}

const destRoot = join(root, ".agents", "skills");
mkdirSync(destRoot, { recursive: true });
const wanted = new Set(skills);

if (skills.length > 0) {
	const tmp = mkdtempSync(join(tmpdir(), "agent-skills-"));
	try {
		execFileSync("git", ["clone", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", ref, `https://github.com/${source}.git`, tmp]);
		execFileSync("git", ["-C", tmp, "sparse-checkout", "set", ...skills.map((s) => `skills/${s}`)]);

		for (const name of skills) {
			const src = join(tmp, "skills", name);
			if (!existsSync(join(src, "SKILL.md"))) throw new Error(`Missing SKILL.md for ${name} in ${source}@${ref}`);
			const dest = join(destRoot, name);
			rmSync(dest, { recursive: true, force: true });
			cpSync(src, dest, { recursive: true, dereference: true });
			writeFileSync(join(dest, ".vendored"), "");
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// Drop vendored skills no longer listed; repo-owned skills (no .vendored marker) are never touched.
for (const entry of readdirSync(destRoot, { withFileTypes: true })) {
	if (!entry.isDirectory() || wanted.has(entry.name)) continue;
	const dir = join(destRoot, entry.name);
	if (existsSync(join(dir, ".vendored"))) rmSync(dir, { recursive: true, force: true });
}
