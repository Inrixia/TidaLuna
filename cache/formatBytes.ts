const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;
/** `bytes` in GB, MB below 1 GB, or KB below 1 MB */
export const formatBytes = (bytes: number) => {
	if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
	if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
	return `${(bytes / KB).toFixed(bytes > 0 && bytes < 10 * KB ? 1 : 0)} KB`;
};
