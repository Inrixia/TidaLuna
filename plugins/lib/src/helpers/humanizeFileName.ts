/**
 * A file name as a title: `base-windows.css` reads `Base Windows`.
 *
 * Themes and plugins are shared as files, and a file name is the only thing some of them offer as a name. Hyphens,
 * underscores and pluses separate words in a file name and spaces separate them in a title, so those become spaces and each
 * word is capitalised.
 */
export const humanizeFileName = (fileName: string): string =>
	fileName
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[-_+]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b[a-z]/g, (char) => char.toUpperCase());
