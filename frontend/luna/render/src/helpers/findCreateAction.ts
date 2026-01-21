/**
 * Finds the name and index of https://redux-toolkit.js.org/api/createAction
 * based on the presence of (`.payload,..."meta"in `) commonly found in Redux Toolkit's `createAction`.
 */
export function findCreateActionFunction(code: string): { fnName: string; startIdx: number } | null {
	// Search for the specific pattern indicating a prepare callback structure.
	const payloadMetaIndex = code.indexOf(`.payload,..."meta"in `);
	if (payloadMetaIndex === -1) return null;

	// Find the start of the function definition preceding the pattern.
	const codeBeforePattern = code.slice(0, payloadMetaIndex);
	const functionStartIndex = codeBeforePattern.lastIndexOf("{function");
	if (functionStartIndex === -1) return null;

	// Find the opening parenthesis before the function definition, which usually precedes the function name.
	const codeBeforeFunction = code.slice(0, functionStartIndex);
	const openParenIndex = codeBeforeFunction.lastIndexOf("(");
	if (openParenIndex === -1) return null;

	// Find the space before the function name.
	const codeBeforeParen = code.slice(0, openParenIndex);
	const spaceIndex = codeBeforeParen.lastIndexOf(" ");

	// Extract the function name. The index needs to account for the space.
	const startIdx = spaceIndex + 1;
	const fnName = code.substring(startIdx, openParenIndex).trim();

	if (!fnName) return null;

	return {
		fnName,
		startIdx,
	};
}
