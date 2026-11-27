/**
 * What a theme's row says about the theme: its name, who made it, what it does, where it came from and the page its
 * source can be read on.
 *
 * A theme may open with a JSON manifest in a comment. Most do not: cotton-candy-colorways ships one on its base and none
 * on its colorways, and cottoncandynights ships none on its font packs. Those fall back to the url, which used to print a
 * 90-character github link where the name belongs and repeat it in the link underneath.
 *
 * Manifests are hand-written, so they are rarely strict JSON. The shape that actually ships is:
 *
 *     /* { * *
 *      "name": "cotton candy",
 *      "author": "Aya, ...",
 *      "description": "colorful light theme for tidaluna"     <- no trailing comma
 *      "license": "MIT License"
 *      * } *\/
 *
 * The braces are decorated with `*` and a comma is missing. Neither is something JSON.parse accepts, and rejecting the
 * whole manifest meant the theme showed its url instead of its name.
 *
 * Everything a theme says about itself is read once, when the manifest is created: a row, a toast and a refresh all ask
 * the same questions, and answering them again per caller is how the answers drift apart.
 */

import { GitUrl, humanizeFileName, stringNotEmpty, urlFileName, urlHost } from "@luna/lib";

/** What a theme file is, as shown on its row */
export type ThemeKind = "Base" | "Colorway" | "Fonts" | "Theme";

/** What a css manifest declares, when it has one */
type Declared = { name?: string; author?: string; description?: string };

/**
 * The owner of a repository, decoded.
 *
 * GitUrl keeps a path segment exactly as the url wrote it, and an owner is shown to a person, who reads `some user` rather
 * than `some%20user`.
 */
const decodedOwner = (owner: string | undefined): string | undefined => {
	if (owner === undefined) return undefined;
	try {
		return decodeURIComponent(owner);
	} catch {
		return owner;
	}
};

/** A name for a theme that declares none: its file name made readable, its host, or the url itself */
const nameOf = (file: string | undefined, host: string | undefined, url: string): string => {
	const readable = file === undefined ? "" : humanizeFileName(file);
	if (readable !== "") return readable;
	return host ?? url;
};

/** Where a theme came from, in the form a row shows it: `tidaluna.dev/nightwave.css` */
const sourceOf = (file: string | undefined, host: string | undefined, url: string): string => {
	if (host === undefined) return url;
	return file === undefined ? host : `${host}/${file}`;
};

export class ThemeManifest {
	/**
	 * Read once per url, replaced when the css behind it changes.
	 *
	 * Keyed by url rather than by the css: the manifest a theme shows is the one for its current file, and keying on the css
	 * kept every earlier version alive for the life of the page while making each lookup compare a full stylesheet.
	 */
	private static readonly created = new Map<string, { css?: string; manifest: ThemeManifest }>();

	/** What the row's title says: the manifest's name, or the file name made readable */
	public readonly name: string;
	/** Who made it: the manifest's author, otherwise the owner of the repository it is served from */
	public readonly author?: string;
	/** What it says about itself, as written, or nothing rather than a substitute */
	public readonly description?: string;
	/** `tidaluna.dev/nightwave.css`: enough to recognise the theme without the ref and folder noise */
	public readonly source: string;
	/** The readable page for the file, when there is one */
	public readonly codeUrl?: string;
	/** The url as a file in a git repository, when that is what it is */
	public readonly git?: GitUrl;

	/** The css it was read from, which decides {@link kind} */
	private readonly css?: string;
	private kindOfCss?: ThemeKind;

	/**
	 * Everything a row shows for a theme, parsed once.
	 *
	 * @param url The url the theme is fetched from, which is what the name and source fall back to
	 * @param css The theme's css, when it has been loaded
	 */
	static from(url: string, css?: string): ThemeManifest {
		const known = ThemeManifest.created.get(url);
		if (known !== undefined && known.css === css) return known.manifest;
		const manifest = new ThemeManifest(url, css);
		ThemeManifest.created.set(url, { css, manifest });
		return manifest;
	}

	private constructor(url: string, css?: string) {
		this.css = css;

		// A theme is a file in a repository, so its file name, host and source page are GitUrl's to read. Only a file url
		// counts: a repository or folder url names no file, and a plain host is not a forge
		const git = GitUrl.from(url);
		this.git = git !== undefined && (git.kind === "blob" || git.kind === "raw") ? git : undefined;

		const declared = ThemeManifest.parse(css);
		const file = this.git?.fileName ?? urlFileName(url);
		// The host the theme is fetched from, which is where a row says it came from: GitUrl reports the repository's host,
		// and `raw.githubusercontent.com` is the repository's host only in the sense that the file lives on github
		const host = urlHost(url);

		this.name = stringNotEmpty(declared?.name) ? declared.name : nameOf(file, host, url);
		this.author = stringNotEmpty(declared?.author) ? declared.author : decodedOwner(this.git?.owner);
		this.description = stringNotEmpty(declared?.description) ? declared.description : undefined;
		this.source = sourceOf(file, host, url);
		this.codeUrl = this.git?.browseUrl;
	}

	/**
	 * What a theme file is, judged from what it contains.
	 *
	 * A theme is usually several files: one base that reworks the layout, one colorway per palette, and sometimes a font
	 * pack. The tab listed them all the same, and the base showed the manifest's name - "cotton candy" - which is the name
	 * of the whole theme, shared by every colorway, so the base read as if it were the colour file.
	 *
	 * The files separate cleanly by content:
	 *
	 *   techroundpack.css       13 @font-face, 102 blocks      -> Fonts
	 *   base-windows.css         0 @font-face, 937 blocks      -> Base     (reworks layout: many rules)
	 *   cottoncandy.css          0 @font-face,  14 blocks      -> Colorway (mostly :root variables)
	 *   sourrainbowstrips.css    0 @font-face,  10 blocks      -> Colorway
	 */
	public get kind(): ThemeKind {
		if (this.kindOfCss !== undefined) return this.kindOfCss;
		const css = this.css;
		if (css === undefined) return (this.kindOfCss = "Theme");
		if (/@font-face/i.test(css)) return (this.kindOfCss = "Fonts");
		// A colorway is a palette: variables dominate and there are barely any rules
		return (this.kindOfCss = (css.match(/\{/g) ?? []).length <= 40 ? "Colorway" : "Base");
	}

	/**
	 * The manifest in the css's first comment, or undefined when there is none.
	 *
	 * Only ever read while one is being created, which is why this is private.
	 *
	 * A manifest that still will not parse is treated as missing rather than thrown: a theme with a broken comment still
	 * styles the page, and refusing to name it would hide the fact that it installed.
	 */
	private static parse(css?: string): Declared | undefined {
		if (css === undefined) return undefined;
		const start = css.indexOf("/*");
		const end = css.indexOf("*/");
		if (start === -1 || end === -1 || end < start) return undefined;

		let text = css.slice(start + 2, end);
		// `{ * *` and `* } ` decoration around the braces
		text = text.replace(/^\s*\{\s*(?:\*\s*)+/, "{").replace(/(?:\s*\*)+\s*\}\s*$/, "}");
		if (!text.trimStart().startsWith("{")) return undefined;
		// A missing comma between a string value and the next key
		text = text.replace(/(:\s*"(?:[^"\\]|\\.)*")\s*\n(\s*")/g, "$1,\n$2");
		// A trailing comma before the closing brace is also common, and also invalid JSON
		text = text.replace(/,\s*\}\s*$/, "}");

		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
			const manifest = parsed as Record<string, unknown>;
			// Coerce to strings: a manifest with {"name": {"x": 1}} used to throw while rendering the card
			const value = (key: string) => (typeof manifest[key] === "string" ? (manifest[key] as string) : undefined);
			return { name: value("name"), author: value("author"), description: value("description") };
		} catch {
			return undefined;
		}
	}
}
