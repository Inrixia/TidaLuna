import { rejectNotOk, toJson, toText } from "@inrixia/helpers";

export const json = <T>(...args: Parameters<typeof fetch>) =>
	fetch(...args)
		.then(rejectNotOk)
		.then(toJson<T>);

export const text = (...args: Parameters<typeof fetch>) =>
	fetch(...args)
		.then(rejectNotOk)
		.then(toText);
