import { memoize } from "@inrixia/helpers";

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
 * Everything here is pure, so the rules can be tested directly.
 */

/** What a theme file is, as shown on its row */
export type ThemeKind = "Base" | "Colorway" | "Fonts" | "Theme";
/**
 * A github url taken apart.
 *
 * Themes are shared as files in a repo, and github writes the same file three ways (`/<owner>/<repo>/blob/<ref>/<path>`,
 * `.../raw/<ref>/<path>` and `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`). This is the one place a github url
 * is taken apart, so the conversions and the author lookup cannot disagree about what the owner and the path are.
 */
export type GithubPath = {
	host: "github.com" | "raw.githubusercontent.com";
	owner: string;
	repo: string;
	/** The path after the repo: `["blob", "main", "dir", "theme.css"]` on a page url, `["main", "dir", "theme.css"]` on a raw one */
	rest: string[];
};

export class ThemeManifest {
	/** What the row's title says: the manifest's name, or the file name made readable */
	public readonly name: string;
	/** Who made it: the manifest's author, otherwise the owner of the repository it is served from */
	public readonly author?: string;
	/** What it says about itself, as written, or nothing rather than a substitute */
	public readonly description?: string;
	/** `tidaluna.dev/nightwave.css`: enough to recognise the theme without the ref and folder noise */
	public readonly source: string;
	/** The readable page for the file on github, when there is one */
	public readonly codeUrl?: string;

	/**
	 * Everything a row shows for a theme, parsed once.
	 *
	 * @param url The url the theme is fetched from, which is what the name and source fall back to
	 * @param css The theme's css, when it has been loaded
	 */
	static of(url: string, css?: string): ThemeManifest {
		const declared = ThemeManifest.parse(css);
		return new ThemeManifest(
			ThemeManifest.present(declared?.name) ?? ThemeManifest.nameOf(url),
			ThemeManifest.sourceOf(url),
			ThemeManifest.codeUrlOf(url),
			ThemeManifest.present(declared?.author) ?? ThemeManifest.repoOwnerOf(url),
			ThemeManifest.present(declared?.description),
		);
	}

	/** A manifest is only ever read for display, so it is a plain value the caller cannot get half of */
	private constructor(name: string, source: string, codeUrl?: string, author?: string, description?: string) {
		this.name = name;
		this.source = source;
		this.codeUrl = codeUrl;
		this.author = author;
		this.description = description;
	}

	/** A blank string is a manifest that was written but says nothing, which is the same as missing */
	private static present(value?: string): string | undefined {
		return typeof value === "string" && value.trim() !== "" ? value : undefined;
	}

	/**
	 * The manifest in the css's first comment, or undefined when there is none.
	 *
	 * A manifest that still will not parse is treated as missing rather than thrown: a theme with a broken comment still
	 * styles the page, and refusing to name it would hide the fact that it installed.
	 */
	static parse(css?: string): { name?: string; author?: string; description?: string } | undefined {
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

	/** Words that make a filename readable: "base-windows.css" -> "Base Windows" */
	static readable(text: string): string {
		return text
			.replace(/\.[a-z0-9]+$/i, "")
			.replace(/[-_+]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.replace(/\b[a-z]/g, (char) => char.toUpperCase());
	}

	/**
	 * A name for a theme with no manifest: its file name, made readable.
	 *
	 * Falls back to the host when the url has no file name (`https://themes.example.com/`), and to the url itself only when
	 * it cannot be parsed at all.
	 */
	static nameOf(url: string): string {
		try {
			const parsed = new URL(url);
			const file = parsed.pathname.split("/").filter(Boolean).pop();
			if (file !== undefined && file !== "") {
				// Decode %20 and friends: pride%20collection/sourrainbowstrips.css is a real theme url
				const name = ThemeManifest.readable(decodeURIComponent(file));
				if (name !== "") return name;
			}
			return parsed.hostname;
		} catch {
			return url;
		}
	}

	/**
	 * Where a theme comes from, in the form a row shows: `tidaluna.dev/nightwave.css`.
	 *
	 * A row used to print the whole url, which is long enough to read as the inside of a page rather than as something you
	 * installed. Host plus file name identifies the theme without the ref and folder noise.
	 */
	static sourceOf(url: string): string {
		try {
			const parsed = new URL(url);
			const file = parsed.pathname.split("/").filter(Boolean).pop();
			const name = file === undefined ? "" : decodeURIComponent(file);
			return name === "" ? parsed.hostname : `${parsed.hostname}/${name}`;
		} catch {
			return url;
		}
	}

	/** The host a theme came from, which is the provenance worth showing when it has no manifest */
	static hostOf(url: string): string | undefined {
		try {
			return new URL(url).hostname;
		} catch {
			return undefined;
		}
	}

	/**
	 * The owner of the repository a theme is hosted in, which is the author when the theme does not name one.
	 *
	 * Only github is read, because that is the one case where a path segment is reliably the owner; anywhere else this
	 * returns undefined rather than guessing.
	 */
	static repoOwnerOf(url: string): string | undefined {
		const path = ThemeManifest.githubPath(url);
		if (path === undefined) return undefined;
		return path.owner === "" ? undefined : path.owner;
	}

	/**
	 * The page someone can read a theme's source on, or undefined when that cannot be worked out.
	 *
	 * A theme is stored by its raw url, because that is what fetch needs. The raw url is not somewhere to send a person: it
	 * serves the file as plain text with no syntax highlighting and no history. On github the readable page is
	 * `/<owner>/<repo>/blob/<ref>/<path>`, which is the conversion here.
	 *
	 * A raw url writes the ref two ways: `/refs/heads/main/…`, and `/main/…`. Only the first is unambiguous, because a
	 * branch name can contain slashes; where the second is used the first path segment after the repo is taken as the ref.
	 */
	static codeUrlOf(url: string): string | undefined {
		const path = ThemeManifest.githubPath(url);
		if (path === undefined) return undefined;
		const [owner, repo] = [path.owner, path.repo];
		if (owner === "" || repo === "") return undefined;

		// Already the page
		if (path.host === "github.com") return path.rest[0] === "blob" ? url : undefined;

		// `/refs/heads/<ref>/<path>` and `/<ref>/<path>` both leave `<ref>/<path>`
		const rest = path.rest[0] === "refs" && path.rest[1] === "heads" ? path.rest.slice(2) : path.rest;
		if (rest.length < 2) return undefined;
		return `https://github.com/${owner}/${repo}/blob/${rest.join("/")}`;
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
	static kindOf(css?: string): ThemeKind {
		if (css === undefined) return "Theme";
		if (/@font-face/i.test(css)) return "Fonts";
		const blocks = (css.match(/\{/g) ?? []).length;
		// A colorway is a palette: variables dominate and there are barely any rules
		if (blocks <= 40) return "Colorway";
		return "Base";
	}

	/**
	 * A github url taken apart, or undefined when the url is not github's or has no owner and repo.
	 *
	 * Memoized because a row asks for it more than once: once for the raw file, once for the source page and once for the
	 * author, and a tab full of themes would otherwise parse the same url several times.
	 */
	static githubPath = memoize((url: string): GithubPath | undefined => {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return undefined;
		}
		const host = parsed.hostname;
		if (host !== "github.com" && host !== "raw.githubusercontent.com") return undefined;
		const segments = parsed.pathname.split("/").filter(Boolean);
		const [owner, repo, ...rest] = segments;
		if (owner === undefined || repo === undefined) return undefined;
		return { host, owner: decodeURIComponent(owner), repo: decodeURIComponent(repo), rest };
	});
}
