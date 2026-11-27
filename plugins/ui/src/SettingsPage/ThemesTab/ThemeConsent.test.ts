import { describe, expect, test } from "vitest";

import { themeConsent } from "./ThemeConsent";
import { ThemeResources } from "./ThemeResources";

const consentOf = (css: string, name = "Pack", baseUrl?: string) => themeConsent(ThemeResources.from(css, baseUrl), name);

describe("themeConsent", () => {
	// The font pack is the case this exists for: 13 binaries from one host, installed by pasting one url
	const fontPack = Array.from({ length: 13 }, (_, i) => `@font-face { src: url(https://github.com/o/r/raw/main/fonts/Tech${i}.woff2); }`).join(
		"\n",
	);

	test("asks before downloading a font pack and names every file", () => {
		const consent = consentOf(fontPack, "Techroundpack");
		expect(consent.required).toBe(true);
		expect(consent.title).toBe("This theme downloads files");
		expect(consent.description).toBe(
			"Techroundpack downloads 13 files from github.com (13 fonts). Anything it downloads can change later without asking again.",
		);
		expect(consent.confirmationText).toBe("Install theme");
		// Every file is named, and grouped under the host it comes from
		expect(consent.hosts).toHaveLength(1);
		expect(consent.hosts[0].host).toBe("github.com");
		expect(consent.hosts[0].files).toHaveLength(12);
		expect(consent.hosts[0].hidden).toBe(1);
		expect(consent.hosts[0].files[0].label).toBe("Tech0.woff2");
	});

	test("lists a file once even when several @font-face rules name it", () => {
		// The real font pack names BOXRounded-Bold.ttf four times
		const css = Array.from({ length: 4 }, () => "@font-face { src: url(https://github.com/o/r/raw/main/f/Bold.ttf); }").join("\n");
		const consent = consentOf(css);
		expect(consent.hosts[0].files).toHaveLength(1);
		expect(consent.hosts[0].hidden).toBe(0);
		// The count still reports what the css asks for, since that is what the browser will request
		expect(consent.description).toContain("4 files from github.com");
		expect(consent.hosts[0].files[0].url).toContain("github.com");
	});

	test("does not ask for a theme that loads nothing", () => {
		expect(consentOf(":root { --a: 1; }", "Cottoncandy")).toEqual({
			required: false,
			title: "",
			description: "",
			hosts: [],
			confirmationText: "",
		});
	});

	test("does not count a data url, which is inside the css already", () => {
		expect(consentOf(".a{background:url(data:image/png;base64,AAAA)}").required).toBe(false);
	});

	test("groups by host in the order the css names them, with the file name as the label", () => {
		const css = `
			@import url(https://cdn.example.com/deep/path/extra.css);
			.a { background: url(https://img.example.com/bg.png); }
			@font-face { src: url(https://fonts.example.com/x.woff2); }
		`;
		const consent = consentOf(css, "Multi", "https://a.test/t.css");
		expect(consent.description).toContain("3 files from cdn.example.com, img.example.com, fonts.example.com");
		expect(consent.hosts.map((host) => host.host)).toEqual(["cdn.example.com", "img.example.com", "fonts.example.com"]);
		// The label is the file, not the url's folders
		expect(consent.hosts[0].files[0].label).toBe("extra.css");
	});

	test("lists at most 12 files in total and counts the rest as hidden", () => {
		const many = Array.from({ length: 5 }, (_, i) => `@font-face { src: url(https://a.test/f${i}.woff2); }`).join("\n");
		const alsoMany = Array.from({ length: 10 }, (_, i) => `@font-face { src: url(https://b.test/g${i}.woff2); }`).join("\n");
		const consent = consentOf(many + alsoMany, "Many");
		const listed = consent.hosts.reduce((total, host) => total + host.files.length, 0);
		const hidden = consent.hosts.reduce((total, host) => total + host.hidden, 0);
		expect(listed).toBe(12);
		expect(hidden).toBe(3);
		// The budget runs out in css order, so the second host is the one that is cut short
		expect(consent.hosts[0].hidden).toBe(0);
		expect(consent.hosts[1].hidden).toBe(3);
	});

	test("says file and font in the singular for one", () => {
		const css = "@font-face { src: url(https://fonts.example.com/x.woff2); }";
		expect(consentOf(css, "One").description).toBe(
			"One downloads 1 file from fonts.example.com (1 font). Anything it downloads can change later without asking again.",
		);
	});

	test("counts an image in the description", () => {
		const css = ".a{background:url(https://img.example.com/a.png)}";
		expect(consentOf(css, "Pic").description).toBe(
			"Pic downloads 1 file from img.example.com (1 image). Anything it downloads can change later without asking again.",
		);
	});
});
