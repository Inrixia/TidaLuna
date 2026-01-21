const toString = (arg?: any): string | undefined => {
	if (arg === undefined) return;
	if (arg instanceof Error) return arg.message;
	if (typeof arg === "object") {
		try {
			return JSON.stringify(arg);
		} catch {}
	}
	return String(arg);
};
export const sanitizeData = (...data: any[]): string | undefined => {
	if (data.length === 0) return;
	if (data.length === 1) return toString(data[0]);
	return data.map(toString).join(" ");
};
