// Byte ranges of a value that is partly there, e.g. audio arriving out of order. Kept sorted and merged, ends exclusive
export type Range = [start: number, end: number];

/** Adds [start, end) to `ranges`, merged with those it touches */
export const addRange = (ranges: Range[], start: number, end: number) => {
	let i = 0;
	while (i < ranges.length && ranges[i][1] < start) i++;
	let j = i;
	for (; j < ranges.length && ranges[j][0] <= end; j++) {
		start = Math.min(start, ranges[j][0]);
		end = Math.max(end, ranges[j][1]);
	}
	ranges.splice(i, j - i, [start, end]);
};

/** Where the bytes from `pos` stop being there, `pos` itself if its byte isn't */
export const filledUntil = (ranges: Range[], pos: number) => {
	for (const [start, end] of ranges) if (start <= pos && pos < end) return end;
	return pos;
};

/** The first missing range from `pos` before `limit`, then from the start of what follows. `undefined` if all of it is there */
export const gapFrom = (ranges: Range[], pos: number, limit: number): Range | undefined => {
	for (const [start, end] of ranges) {
		if (end <= pos) continue;
		if (start > pos) return pos < limit ? [pos, Math.min(start, limit)] : undefined;
		pos = end;
	}
	return pos < limit ? [pos, limit] : undefined;
};

/** Bytes there */
export const filledBytes = (ranges: Range[]) => {
	let bytes = 0;
	for (const [start, end] of ranges) bytes += end - start;
	return bytes;
};
