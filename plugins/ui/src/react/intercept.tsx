import React from "react";

import type { UnknownRecord } from "@inrixia/helpers";
import type { LunaUnload, LunaUnloads } from "@luna/core";
import jsxRuntime, { type JSX } from "react/jsx-runtime";
import { unloads } from "../index.safe";

export const renderJSX = jsxRuntime.jsx;
export const renderJSXS = jsxRuntime.jsxs;
unloads.add(() => {
	jsxRuntime.jsx = renderJSX;
	jsxRuntime.jsxs = renderJSXS;
});

export type RenderJSX = typeof renderJSX;
export type RenderJSXS = typeof renderJSXS;
export type JSXProps<P = UnknownRecord> = P & { children?: React.ReactNode };
export type JSXSProps<P = UnknownRecord> = P & { children?: React.ReactNode[] };
export type JSXElementType = keyof JSX.IntrinsicElements;

type JSXRenderArgs =
	| [isJSXS: true, elementType: JSXElementType, props: JSXSProps, key?: React.Key]
	| [isJSXS: false, elementType: JSXElementType, props: JSXProps, key?: React.Key];
/**
 * @param elementType The React HTMLElementType
 * @param props The React element props
 * @param key The React element key
 * @param isJSXS Indicates if calling render was from JSXS or JSX. JSXS children is an array, JSXS is not
 * @returns `undefined` to continue, `ReactElement` to render returned element immediately or `null` to cancel.
 */
export type JSXRender = (...args: JSXRenderArgs) => undefined | React.ReactElement | null;
export const renderInterceptors: Partial<Record<JSXElementType, Set<JSXRender>>> = {};

jsxRuntime.jsx = function (type, props, key) {
	if (typeof type === "string") return interceptJSX(false, type, props, key)!;
	return renderJSX(type, props, key);
};
jsxRuntime.jsxs = function (type, props, key) {
	if (typeof type === "string") return interceptJSX(true, type, props, key)!;
	return renderJSXS(type, props, key);
};
const interceptJSX = (isJSXS: boolean, type: JSXElementType, props: any, key?: React.Key) => {
	if (type in renderInterceptors) {
		// Run interceptors for JSXElementType
		for (const interceptor of renderInterceptors[type]!) {
			const res = interceptor(isJSXS, type, props, key);
			// If res is null or ReactElement immediately return it.
			if (res !== undefined) return res;
		}
	}
};

interceptRender("div", unloads, (isJSXS, elementType, props, key?) => {
	if (props["data-test"] !== "footer-player") return;

	const children = isJSXS ? (props.children ?? []) : [props.children];
	children.push(<>Hello Inside</>);
	props.children = children;

	return (
		<>
			<span>Hello Above</span>
			{renderJSXS(elementType, props, key)}
		</>
	);
});

/**
 * Intercept a React Componoent Render based on its `ElementType`
 *
 * **WARNING!** `cb` is called on every render for `ElementType`, only use this if you know what you are doing. This is performance critical code.
 * @param elementType The React HTMLElementType to intercept
 * @param cb Called when render is intercepted with props, if returning false element is not rendered
 * @param unloads Set of unload functions to add this to, can be nullish but only if you know what your doing
 * @param once If set true only intercepts once
 * @returns Function to call to unload/cancel the intercept
 */
export function interceptRender(elementType: React.HTMLElementType, unloads: LunaUnloads, cb: JSXRender, once?: boolean): LunaUnload {
	// If once is true then call unIntercept immediately to only run once
	if (once)
		cb = (isJSXS, type, props: any, key?) => {
			unIntercept();
			return cb(isJSXS, type, props, key);
		};

	// Wrap removing the callback from the interceptors in a unload function and return it
	const unIntercept = () => {
		// ?. so that it doesn't throw if the interceptor was already removed
		renderInterceptors[elementType]?.delete(cb);
		if (renderInterceptors[elementType]?.size === 0) delete renderInterceptors[elementType];
	};
	unIntercept.source = `intercept::${elementType}`;

	renderInterceptors[elementType] ??= new Set<JSXRender>();
	renderInterceptors[elementType].add(cb);

	unloads?.add(unIntercept);
	return unIntercept;
}
