export const parseDate = (date: string | Date | null | undefined): Date | undefined => {
	if (date === null || date === undefined) return undefined;
	if (typeof date === "string") date = new Date(date);
	if (isNaN(date.getTime())) return undefined;
	return date;
};
