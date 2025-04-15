import quartz, { type QuartzPlugin } from "@uwu/quartz";
import { resolveAbsolutePath } from "./helpers/resolvePath.js";
import wObj from "./window.luna.js";

const fetchText = (path) => fetch(path).then((res) => res.text());

const dynamicResolve: QuartzPlugin["dynamicResolve"] = async ({ name, moduleId, config }) => {
	const path = resolveAbsolutePath(moduleId, name);
	if (wObj.moduleCache[path]) return wObj.moduleCache[path];

	const data = await fetchText(path);

	wObj.moduleCache[path] = await quartz(data, config, path);
	return wObj.moduleCache[path];
};

/**
 * Finds the name of the getStore redux function based on it throwing `Error("No global store set")`
 */
const findStoreFunctionName = (bundleCode) => {
	// Find index of store error typically seen inside getStore func
	const errorMessageIndex = bundleCode.indexOf('Error("No global store set")');
	if (errorMessageIndex === -1) return null;

	// Walk back to the function declaration
	for (let charIdx = errorMessageIndex - 1; charIdx > 0; charIdx--) {
		// If we arent at the func declaration continue to walk back
		if (bundleCode[charIdx] + bundleCode[charIdx + 1] != "()") continue;

		let strBuf = [];
		for (let nameIdx = charIdx - 1; nameIdx > 0; nameIdx--) {
			const char = bundleCode[nameIdx];

			// If we have the full name return the name
			if (char == " ") return strBuf.reverse().join("");
			strBuf.push(char);
		}
	}
	return null;
};

/**
 * Finds the name and index of the Redux action handler? Based on the existance of `.payload,..."meta"in `
 */
function findPrepareActionNameAndIdx(bundleCode) {
	const searchIdx = bundleCode.indexOf(`.payload,..."meta"in `);
	if (searchIdx === -1) return null;

	const sliced = bundleCode.slice(0, searchIdx);
	const funcIndex = sliced.lastIndexOf("{function");

	let strBuf = [];
	for (let nameIdx = bundleCode.slice(0, funcIndex).lastIndexOf("(") - 1; nameIdx > 0; nameIdx--) {
		const char = bundleCode[nameIdx];
		if (char == " ")
			return {
				name: strBuf.reverse().join(""),
				idx: nameIdx + 1,
			};

		strBuf.push(char);
	}
	return null;
}

setTimeout(() => {
	// Use .forEach to execute in parallell using async
	document.querySelectorAll<HTMLScriptElement>(`script[type="luna/quartz"]`).forEach(async (script) => {
		const scriptPath = new URL(script.src).pathname;

		const scriptContent = await fetchText(scriptPath);

		// Fetch, transform execute and store the module in moduleCache
		// Hijack the Redux store & inject interceptors
		wObj.moduleCache[scriptPath] = await quartz(
			scriptContent,
			{
				plugins: [
					{
						// Quarts runs transform > dynamicResolve > resolve
						transform({ code }) {
							const getStoreFuncName = findStoreFunctionName(code);

							if (getStoreFuncName) code += `; export { ${getStoreFuncName} as hijackedGetStore };`;
							const actionData = findPrepareActionNameAndIdx(code);

							if (actionData) {
								const { name: prepareActionName, idx: prepareActionIdx } = actionData;

								const funcPrefix = "__LunaUnpatched_";

								// rename function declaration
								code = code.slice(0, prepareActionIdx) + funcPrefix + code.slice(prepareActionIdx);

								code =
									code.slice(0, prepareActionIdx - 9) +
									`const ${prepareActionName} = luna.patchAction({ _: ${funcPrefix}${prepareActionName} })._;` +
									code.slice(prepareActionIdx - 9);
							}

							return code;
						},
						dynamicResolve,
						async resolve({ name, moduleId, config, accessor, store }) {
							(store as any).exports = await dynamicResolve({ name, moduleId, config });
							return `${accessor}.exports`;
						},
					},
				],
			},
			scriptPath,
		);

		for (const module of Object.values(wObj.moduleCache)) {
			const { hijackedGetStore } = module;
			if (!hijackedGetStore) continue;
			wObj.store = hijackedGetStore();
			break;
		}
	});
});
