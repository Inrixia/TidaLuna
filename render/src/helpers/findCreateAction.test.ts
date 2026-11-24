import { describe, expect, test } from "vitest";

import { findCreateActionFunction } from "./findCreateAction";

/**
 * Redux Toolkit's `createAction` is recognised by the `.{...}"meta"in ` spread a minified action creator returns.
 * The extractor then reads the name off the function definition around it, so the fixtures below are shaped like
 * bundler output: a `{function` block, with the call's opening parenthesis (and the name) before it.
 */
const bundle = (quote: string) =>
	`var build = wrap createAction({function actionCreator(payload){return{payload:payload.payload,...${quote}meta${quote}in payload?{meta:payload.meta}:{}}}});`;

describe("findCreateActionFunction", () => {
	test("finds the function name and the index it starts at", () => {
		const code = bundle('"');
		const result = findCreateActionFunction(code);

		expect(result).toEqual({ fnName: "createAction", startIdx: code.indexOf("createAction") });
		// The index is the start of the function name, so code from it parses as the call that builds the action
		expect(code.startsWith("createAction({function", result!.startIdx)).toBe(true);
	});

	test.each(['"', "'", "`"])("accepts %s as the quote around meta", (quote) => {
		const code = bundle(quote);

		expect(findCreateActionFunction(code)).toEqual({ fnName: "createAction", startIdx: code.indexOf("createAction") });
	});

	test("uses the function definition closest to the action shape", () => {
		const code =
			'var first = one({function alpha(x){return{payload:x,..."meta"in x?{meta:x.meta}:{}}}});' +
			'var second = two({function beta(y){return{payload:y.payload,..."meta"in y?{meta:y.meta}:{}}}});';

		const result = findCreateActionFunction(code);

		// The last `{function` before the shape is the one whose enclosing call is read
		expect(result).toEqual({ fnName: "two", startIdx: code.lastIndexOf("two") });
	});

	test("is null when the action shape is not there", () => {
		expect(findCreateActionFunction("function createAction(type){return {type};}")).toBeNull();
	});

	test("is null for an action shape without a spread", () => {
		expect(findCreateActionFunction("return { payload: args[0], meta: args[1] };")).toBeNull();
	});

	test("is null when no function definition precedes the action shape", () => {
		const code = 'var action = {payload:value.payload,..."meta"in value?{meta:value.meta}:{}};';

		expect(findCreateActionFunction(code)).toBeNull();
	});

	test("is null when there is no opening parenthesis before the function definition", () => {
		const code = 'var action == createAction{function creator(x){return{payload:x.payload,..."meta"in x?{meta:x.meta}:{}}}};';

		expect(findCreateActionFunction(code)).toBeNull();
	});

	test("is null when the function name would be empty", () => {
		// The only parenthesis before the definition is the one before it, so there is no name between them
		const code = 'q = build ({function creator(x){return{payload:x.payload,..."meta"in x?{meta:x.meta}:{}}}});';

		expect(findCreateActionFunction(code)).toBeNull();
	});

	test("is null for the meta pattern with no space after in", () => {
		expect(findCreateActionFunction(bundle('"').replace("in payload?", "in(payload)?"))).toBeNull();
	});
});
