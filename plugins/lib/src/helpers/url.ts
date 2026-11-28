/**
 * The parts of a url that get read without needing a git host: its name, its host, its extension.
 *
 * Kept here rather than on whichever class happened to need one first: a theme, a plugin package and a font url all ask the
 * same three questions about a url, and answering them in three places is how the answers drift apart.
 */

/** The hostname of a url, or undefined when it cannot be parsed */
export const urlHost = (url: string): string | undefined => {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
};

/**
 * The last path segment of a url, decoded, which is the part that names the file.
 *
 * Undefined for a host root (`https://themes.example.com/`), where there is no file to name.
 */
export const urlFileName = (url: string): string | undefined => {
	try {
		const segments = new URL(url).pathname.split("/").filter(Boolean);
		const last = segments[segments.length - 1];
		return last === undefined ? undefined : decodeURIComponent(last);
	} catch {
		return undefined;
	}
};

/**
 * The lowercased extension of a path, url or file name, `""` when it has none.
 *
 * Query and fragment are stripped first, because `theme.css?v=2` is still a stylesheet and the extension is what callers
 * judge a file by.
 */
export const fileExtension = (path: string): string => {
	const withoutQuery = path.split("?")[0].split("#")[0];
	const last = withoutQuery.split("/").pop() ?? "";
	const dot = last.lastIndexOf(".");
	return dot === -1 ? "" : last.slice(dot).toLowerCase();
};
