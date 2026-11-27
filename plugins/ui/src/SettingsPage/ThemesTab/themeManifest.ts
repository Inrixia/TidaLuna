/**
 * What a theme card shows for a theme's name, author and description.
 *
 * A theme may open with a JSON manifest in a comment. Most do not: cotton-candy-colorways ships one on its base and none
 * on its colorways, and cottoncandynights ships none on its font packs. Those used to fall back to the url itself, which
 * put a 90-character github link where the name belongs and repeated it in the link underneath.
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
 */

export type ThemeManifest = { name?: string; author?: string; description?: string };

/** Words that make a filename readable: "base-windows" -> "Base Windows" */
const readable = (text: string) =>
	text
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[-_+]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b[a-z]/g, (char) => char.toUpperCase());

/**
 * The manifest from the css's first comment, or undefined.
 *
 * Only ever used for display, so a manifest that still will not parse falls back to the url-derived name rather than
 * breaking the card.
 */
export const parseThemeManifest = (css?: string): ThemeManifest | undefined => {
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
};

/**
 * A name for a theme with no manifest: its file name, made readable.
 *
 * Falls back to the host when the url has no file name (`https://themes.example.com/`), and to the url itself only when
 * it cannot be parsed at all.
 */
export const themeNameFromUrl = (url: string): string => {
	try {
		const parsed = new URL(url);
		const file = parsed.pathname.split("/").filter(Boolean).pop();
		if (file !== undefined && file !== "") {
			// Decode %20 and friends: pride%20collection/sourrainbowstrips.css is a real theme url
			const decoded = decodeURIComponent(file);
			const name = readable(decoded);
			if (name !== "") return name;
		}
		return parsed.hostname;
	} catch {
		return url;
	}
};

/** The host a theme came from, which is the provenance worth showing when it has no manifest */
export const themeHost = (url: string): string | undefined => {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
};

/**
 * The owner of the repository a theme is hosted in, which is the author when the theme does not name one.
 *
 * Themes are shared as files in a repo: `aya-zzz-zzz/cotton-candy-colorways` serves both the base and every colorway, so
 * the owner identifies who made it even when the css has no manifest. Only github hosts are read, because that is the
 * one case where a path segment is reliably the owner; anywhere else this returns undefined rather than guessing.
 */
export const themeRepoOwner = (url: string): string | undefined => {
	try {
		const parsed = new URL(url);
		const isGithub = parsed.hostname === "github.com" || parsed.hostname.endsWith(".githubusercontent.com");
		if (!isGithub) return undefined;
		const [owner] = parsed.pathname.split("/").filter(Boolean);
		return owner === undefined || owner === "" ? undefined : decodeURIComponent(owner);
	} catch {
		return undefined;
	}
};

export type ThemeDisplay = { name: string; author: string | undefined; description: string | undefined; source: string };

/**
 * Where a theme comes from, in the form a row shows: `tidaluna.dev/nightwave.css`.
 *
 * A row used to print the whole url, which is long enough to read as the inside of a page rather than as something you
 * installed. Host plus file name identifies the theme without the ref and folder noise.
 */
export const themeSource = (url: string): string => {
	try {
		const parsed = new URL(url);
		const file = parsed.pathname.split("/").filter(Boolean).pop();
		const name = file === undefined ? "" : decodeURIComponent(file);
		return name === "" ? parsed.hostname : `${parsed.hostname}/${name}`;
	} catch {
		return url;
	}
};

/**
 * What to show on a theme's row.
 *
 * The name comes from the manifest when there is one and from the file name otherwise, and the source is always carried
 * separately so a row says where the theme came from either way. The manifest's description is shown as written; without
 * one there is no description rather than a substitute, because the source line underneath already says where it is from.
 */
export const themeDisplay = (url: string, manifest?: ThemeManifest): ThemeDisplay => {
	const present = (value?: string) => (typeof value === "string" && value.trim() !== "" ? value : undefined);
	return {
		name: present(manifest?.name) ?? themeNameFromUrl(url),
		// A theme that does not name an author is attributed to the owner of the repo it is served from
		author: present(manifest?.author) ?? themeRepoOwner(url),
		description: present(manifest?.description),
		source: themeSource(url),
	};
};

/** What a theme file is, as shown on its row */
export type ThemeKind = "Base" | "Colorway" | "Fonts" | "Theme";

/**
 * What a theme file is, judged from what it contains.
 *
 * A theme is usually several files: one base that reworks the layout, one colorway per palette, and sometimes a font
 * pack. The tab listed them all the same, and the base showed the manifest's name - "cotton candy" - which is the name of
 * the whole theme, shared by every colorway, so the base read as if it were the colour file.
 *
 * The files separate cleanly by content:
 *
 *   techroundpack.css       13 @font-face, 102 blocks      -> Fonts
 *   base-windows.css         0 @font-face, 937 blocks      -> Base     (reworks layout: many rules)
 *   cottoncandy.css          0 @font-face,  14 blocks      -> Colorway (mostly :root variables)
 *   sourrainbowstrips.css    0 @font-face,  10 blocks      -> Colorway
 */
export const themeKind = (css?: string): ThemeKind => {
	if (css === undefined) return "Theme";
	if (/@font-face/i.test(css)) return "Fonts";
	const blocks = (css.match(/\{/g) ?? []).length;
	// A colorway is a palette: variables dominate and there are barely any rules
	if (blocks <= 40) return "Colorway";
	return "Base";
};

/**
 * The page someone can read a theme's source on, or undefined when that cannot be worked out.
 *
 * A theme is stored by its raw url, because that is what fetch needs. The raw url is not somewhere to send a person: it
 * serves the file as plain text with no syntax highlighting and no history. On github the readable page is
 * `/<owner>/<repo>/blob/<ref>/<path>`, which is the conversion here.
 *
 * A raw url writes the ref two ways: `/refs/heads/main/…`, and `/main/…`. Only the first is unambiguous, because a branch
 * name can contain slashes; where the second is used the first path segment after the repo is taken as the ref.
 */
export const themeCodeUrl = (url: string): string | undefined => {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}

	// Already a page
	if (parsed.hostname === "github.com") {
		const segments = parsed.pathname.split("/").filter(Boolean);
		return segments[2] === "blob" ? parsed.href : undefined;
	}

	if (parsed.hostname !== "raw.githubusercontent.com") return undefined;
	const segments = parsed.pathname.split("/").filter(Boolean);
	const [owner, repo] = segments;
	if (owner === undefined || repo === undefined) return undefined;

	let rest: string[];
	if (segments[2] === "refs" && segments[3] === "heads") rest = segments.slice(4);
	else rest = segments.slice(2);
	if (rest.length < 2) return undefined;

	return `https://github.com/${owner}/${repo}/blob/${rest.join("/")}`;
};
