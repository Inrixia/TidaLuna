// Builds store/registry.json from store/stores.json.
// Adds stars, per plugin download counts and repo health so the client gets all of it
// in a single raw.githubusercontent.com fetch instead of hammering the GitHub API itself.
// Run by .github/workflows/registry.yml, or locally with GITHUB_TOKEN set.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dirname, "..");
const token = process.env.GITHUB_TOKEN;
if (!token) console.warn("No GITHUB_TOKEN set, running against the 60 per hour anonymous limit");

const api = async (path) => {
	const res = await fetch(`https://api.github.com${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	});
	if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
	return res.json();
};

// store.json lists "Song Downloader.mjs", the release asset is called "Song.Downloader.mjs"
const assetName = (plugin) => plugin.replaceAll(" ", ".");
const tagOf = (url) => url.split("/releases/download/")[1]?.split("/")[0];

const stores = JSON.parse(readFileSync(join(root, "store/stores.json"), "utf8"));
const out = [];
let warnings = 0;

for (const store of stores.stores) {
	if ((store.status ?? "active") === "removed") {
		out.push({ name: store.name, repo: store.repo, url: store.url, status: "removed", reason: store.reason });
		continue;
	}

	const entry = { ...store, status: "active", health: "ok" };

	try {
		// Follows renames, so a repo that moved still resolves and reports its current slug
		const repo = await api(`/repos/${store.repo}`);
		entry.stars = repo.stargazers_count;
		entry.pushedAt = repo.pushed_at;
		if (repo.archived) entry.health = "archived";
		if (repo.full_name !== store.repo) {
			console.warn(`${store.repo} is now ${repo.full_name}, update store/stores.json`);
			entry.repo = repo.full_name;
			warnings++;
		}
	} catch (err) {
		console.warn(`${store.repo} repo lookup failed: ${err.message}`);
		entry.health = "unreachable";
		warnings++;
	}

	try {
		const storeJson = await fetch(store.url).then((res) => {
			if (!res.ok) throw new Error(`store.json returned HTTP ${res.status}`);
			return res.json();
		});
		const plugins = storeJson.plugins ?? [];
		entry.pluginCount = plugins.length;

		const release = await api(`/repos/${entry.repo}/releases/tags/${tagOf(store.url)}`);
		const counts = new Map(release.assets.map((asset) => [asset.name, asset.download_count]));
		// Oldest asset creation date, the counters reset whenever a release is recreated
		const created = release.assets.map((asset) => asset.created_at).sort();
		if (created.length > 0) entry.assetsSince = created[0];

		const downloads = {};
		for (const plugin of plugins) {
			const count = counts.get(assetName(plugin));
			if (count !== undefined) downloads[plugin] = count;
		}
		if (Object.keys(downloads).length > 0) entry.downloads = downloads;
	} catch (err) {
		console.warn(`${store.repo} release lookup failed: ${err.message}`);
		if (entry.health === "ok") entry.health = "unreachable";
		warnings++;
	}

	out.push(entry);
}

const registry = {
	version: 1,
	generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
	stores: out,
};
writeFileSync(join(root, "store/registry.json"), JSON.stringify(registry) + "\n");

const active = out.filter((store) => store.status === "active");
console.log(
	`Wrote ${out.length} stores (${active.length} active, ${active.reduce((n, store) => n + (store.pluginCount ?? 0), 0)} plugins), ${warnings} warnings`,
);
