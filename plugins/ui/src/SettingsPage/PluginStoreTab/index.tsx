import React, { useCallback, useEffect, useState } from "react";

import { store as obyStore } from "oby";

import { ReactiveStore } from "@luna/core";

import Stack from "@mui/material/Stack";

import { InstallFromUrl } from "./InstallFromUrl";
import { LunaStore } from "./LunaStore";

const pluginStores = ReactiveStore.getStore("@luna/pluginStores");
export const storeUrls = await pluginStores.getReactive<string[]>("storeUrls", []);
export const addToStores = (url: string) => {
	if (url.endsWith("/store.json")) url = url.slice(0, -11);
	if (storeUrls.includes(url)) return false;
	return storeUrls.push(url);
};

// Devs! Add your stores here <3
// TODO: Abstract this to a git repo with versioned stores
addToStores("https://github.com/Inrixia/neptune-plugins/releases/download/dev/store.json");

export const PluginStoreTab = React.memo(() => {
	const [_storeUrls, setPluginStores] = useState<string[]>(obyStore.unwrap(storeUrls));

	useEffect(() => obyStore.on(storeUrls, () => setPluginStores([...obyStore.unwrap(storeUrls)])), []);
	const onRemove = useCallback((storeUrl: string) => {
		const index = storeUrls.indexOf(storeUrl);
		if (index > -1) storeUrls.splice(index, 1);
	}, []);

	return (
		<Stack spacing={2}>
			<InstallFromUrl />
			<LunaStore url={"http://127.0.0.1:3000"} onRemove={() => {}} />
			{_storeUrls.map((store) => (
				<LunaStore key={store} url={store} onRemove={() => onRemove(store)} />
			))}
		</Stack>
	);
});
