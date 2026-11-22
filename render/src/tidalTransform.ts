// Luna's changes to each TIDAL module's source. Pure and deterministic, it runs in the main process for native module loading
// (native/tidalModules.ts, where the same output lets V8 reuse its code cache) and in the page for the quartz fallback.
import { findCreateActionFunction } from "./helpers/findCreateAction";
import { applyTidalPatches } from "./tidalPatches";

// Lookbehind, not a leading ([\w$]+) which retries at every position of a multi MB bundle (~30ms each vs ~1ms)
const createRootExport = /(?<=[\w$])\.createRoot\s*=(?!=)/;

export const transformTidalModule = (code: string) => {
	// Tidal react-dom/client
	code = code.replace(createRootExport, ".createRoot=globalThis.__lunaCreateRoot=");
	code = applyTidalPatches(code);

	const actionData = findCreateActionFunction(code);
	if (actionData) {
		const { fnName, startIdx } = actionData;
		const funcPrefix = "__LunaUnpatched_";
		const renamedFn = funcPrefix + fnName;

		// Rename the original function declaration by adding a prefix
		// Example: `prepareAction` becomes `__LunaUnpatched_prepareAction`
		code = code.slice(0, startIdx) + funcPrefix + code.slice(startIdx);

		// Assuming the declaration starts 9 characters before the function name
		// (e.g., accounting for "const " or "function ")
		const declarationStartIdx = startIdx - 9;
		const patchedDeclaration = `const ${fnName} = patchAction({ _: ${renamedFn} })._;`;

		// Insert the new patched declaration before the original (now renamed) one
		code = code.slice(0, declarationStartIdx) + patchedDeclaration + code.slice(declarationStartIdx);
	}

	return code;
};
