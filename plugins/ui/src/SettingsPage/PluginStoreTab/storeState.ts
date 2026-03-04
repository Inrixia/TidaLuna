import { ReactiveStore } from "@luna/core";

const pluginStores = ReactiveStore.getStore("@luna/pluginStores");
export const storeUrls = await pluginStores.getReactive<string[]>("storeUrls", []);

export const addToStores = (url: string) => {
	if (url.endsWith("/store.json")) url = url.slice(0, -11);
	if (storeUrls.includes(url)) return false;
	return storeUrls.push(url);
};
