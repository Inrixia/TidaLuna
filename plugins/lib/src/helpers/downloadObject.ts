/**
 * Download content as a file
 */
export const downloadObject = (content: string, filename: string, type: string) =>
{
	const blob = new Blob([content], { type });
	const url = URL.createObjectURL(blob);

	const a = document.createElement("a");
	a.href = url;
	a.download = filename;

	a.click();

	URL.revokeObjectURL(url);
};
