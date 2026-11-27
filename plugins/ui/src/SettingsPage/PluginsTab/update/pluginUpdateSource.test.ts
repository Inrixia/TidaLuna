import { expect, test } from "vitest";

import { pluginUpdateSource } from "./pluginUpdateSource";

const RELEASE = "https://github.com/Inrixia/luna-plugins/releases/download/latest/@inrixia.VolumeScroll";

test("the release the code downloads from wins over the repository the package claims", () => {
	const { git, releaseTag } = pluginUpdateSource(RELEASE, { repository: { url: "https://github.com/x/benign" } }, {});
	expect(git?.repoUrl).toBe("https://github.com/Inrixia/luna-plugins");
	expect(releaseTag).toBe("latest");
});

test("the installed version's repository wins over the update's", () => {
	const { git, releaseTag } = pluginUpdateSource(
		"https://x.example/P",
		{ repository: { url: "git+https://git.cafe/me/p.git" } },
		{ repository: { url: "https://evil.example/x/y" } },
	);
	expect(git?.repoUrl).toBe("https://git.cafe/me/p");
	expect(releaseTag).toBe(undefined);
	expect(pluginUpdateSource("https://x.example/P", {}, { repository: "o/r" }).git?.repoUrl).toBe("https://github.com/o/r");
});

test("no repository for a store url without a declared one, or a non-http repository", () => {
	expect(pluginUpdateSource("https://x.example/P", {}, {}).git).toBe(undefined);
	expect(pluginUpdateSource("https://x.example/P", { repository: { url: "javascript:alert(1)//a/b" } }, {}).git).toBe(undefined);
});
