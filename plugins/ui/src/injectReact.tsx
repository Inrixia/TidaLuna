import React from "react";

import jsxRuntime from "react/jsx-runtime";
import { unloads } from "./index.safe";

const _jsx = jsxRuntime.jsx;
const _jsxs = jsxRuntime.jsxs;
unloads.add(() => {
	jsxRuntime.jsx = _jsx;
	jsxRuntime.jsxs = _jsxs;
});

// type ReactMatch = Partial<Record<React.HTMLElementType, Record<string, any>>>;
const matchers: Record<any, any> = {
	div: [
		(type: React.ElementType, props: any, key?: React.Key) => {
			if (props?.["data-test"] === "footer-player") {
				props.children = Array.isArray(props.children) ? props.children : [props.children];
				props.children.push(<>Hello Inside</>);
				return (
					<div>
						<span>Hello Above</span>
						<div>{_jsxs(type, props, key)}</div>
					</div>
				);
			}
		},
	],
};

jsxRuntime.jsx = function (type, props, key) {
	return interceptJSX(type, props, key) ?? _jsx(type, props, key);
};
jsxRuntime.jsxs = function (type, props, key) {
	return interceptJSX(type, props, key) ?? _jsxs(type, props, key);
};
const interceptJSX = (type: any, props: any, key?: React.Key) => {
	if (type in matchers) {
		for (const matcher of matchers[type]) {
			return matcher(type, props, key);
		}
	}
	return undefined;
};
