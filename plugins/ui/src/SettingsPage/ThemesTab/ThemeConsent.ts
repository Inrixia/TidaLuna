/**
 * The prompt shown before a theme that loads files of its own is installed.
 *
 * A theme is css, but it can name anything to fetch: the font pack installs thirteen binaries from github.com. Installing it
 * is the moment the user is still deciding, so the files and their hosts are put in front of them first, rather than a log
 * line they will never read.
 *
 * The prompt is built from a theme's resources and used by `LunaTheme.install`, which is the only place a theme is still a
 * decision.
 */

import { urlFileName } from "@luna/lib";

import type { ThemeResources } from "./ThemeResources";

/** One file a theme would download, named the way a person reads it */
export type ThemeConsentFile = { label: string; url: string };

/** The files a theme downloads from one host */
export type ThemeConsentHost = { host: string; files: ThemeConsentFile[]; hidden: number };

/** What to ask before a theme that pulls in other files is installed */
export type ThemeConsent = {
	required: boolean;
	title: string;
	/** The one-line summary: how many, of what kind, from where */
	description: string;
	/** The files themselves, grouped by the host they come from, so the prompt names them rather than counting them */
	hosts: ThemeConsentHost[];
	confirmationText: string;
};

/** How many files a prompt lists before it says "and N more": a wall of 40 urls is not a decision anyone makes */
const maxListedFiles = 12;

/** What to ask about a theme's files, or nothing to ask when it loads none */
export const themeConsent = (resources: ThemeResources, name: string): ThemeConsent => {
	const remote = resources.remote;
	if (remote.length === 0) return { required: false, title: "", description: "", hosts: [], confirmationText: "" };

	const fonts = remote.filter((resource) => resource.kind === "font").length;
	const images = remote.filter((resource) => resource.kind === "image").length;
	const imported = remote.filter((resource) => resource.imported).length;

	// Group by host: where a file comes from is the thing being agreed to, and the files are what it is. Kept in the order
	// the css names them, so the prompt reads in the order the theme was written
	const byHost = new Map<string, string[]>();
	for (const resource of remote) {
		const url = resource.absolute!;
		const host = new URL(url).hostname;
		const urls = byHost.get(host);
		if (urls === undefined) byHost.set(host, [url]);
		else urls.push(url);
	}

	// A font pack can name the same file from several @font-face rules (four use BOXRounded-Bold.ttf here). It downloads
	// once, so list it once: repeating it three times reads like three files. Listing stops once the prompt has enough file
	// names to be a decision.
	const hosts: ThemeConsentHost[] = [];
	let remaining = maxListedFiles;
	for (const [host, urls] of byHost) {
		const files: ThemeConsentFile[] = [];
		let hidden = 0;
		const seen = new Set<string>();
		for (const url of urls) {
			if (seen.has(url)) continue;
			seen.add(url);
			if (remaining === 0) {
				hidden++;
				continue;
			}
			remaining--;
			files.push({ label: urlFileName(url) ?? url, url });
		}
		hosts.push({ host, files, hidden });
	}

	const files = `${remote.length} file${remote.length === 1 ? "" : "s"}`;
	const what = [
		fonts > 0 ? `${fonts} font${fonts === 1 ? "" : "s"}` : undefined,
		images > 0 ? `${images} image${images === 1 ? "" : "s"}` : undefined,
		imported > 0 ? `${imported} imported stylesheet${imported === 1 ? "" : "s"}` : undefined,
	].filter(Boolean);

	return {
		required: true,
		title: "This theme downloads files",
		description:
			`${name} downloads ${files} from ${[...byHost.keys()].join(", ")}` +
			(what.length > 0 ? ` (${what.join(", ")})` : "") +
			". Anything it downloads can change later without asking again.",
		hosts,
		confirmationText: "Install theme",
	};
};
