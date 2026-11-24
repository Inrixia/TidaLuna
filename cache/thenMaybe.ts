import type { MaybePromise } from "@inrixia/helpers";

/**
 * `onValue(value)`, at once if `value` isn't a promise, otherwise once it resolves. Lets code over sync and async backends be written once
 * and stay synchronous over sync ones, so a memory cache's reads return values rather than promises
 */
export const thenMaybe = <T, R>(value: MaybePromise<T>, onValue: (value: T) => MaybePromise<R>): MaybePromise<R> =>
	value instanceof Promise ? value.then(onValue) : onValue(value);
