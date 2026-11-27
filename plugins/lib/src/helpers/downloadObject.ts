/**
 * How long the object URL is kept after the click. Revoking it in the same task can cancel the download before the
 * browser has started reading the blob (Chromium aborts it), and the blob is already held by `content`, so holding the
 * URL a little longer costs nothing. 40s is what FileSaver.js settled on for the same reason.
 */
const revokeAfterMs = 40_000;

/**
 * Download content as a file
 */
export const downloadObject = (content: string, filename: string, type: string) => {
	const blob = new Blob([content], { type });
	const url = URL.createObjectURL(blob);

	const a = document.createElement("a");
	a.href = url;
	a.download = filename;

	a.click();

	setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
};
