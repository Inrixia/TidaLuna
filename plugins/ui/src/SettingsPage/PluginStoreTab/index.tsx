import React, { useCallback, useEffect, useState } from "react";

import { store as obyStore } from "oby";

import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";

import { InstallFromUrl } from "./InstallFromUrl";
import { LunaStore } from "./LunaStore";
import { addToStores, storeUrls } from "./storeState";

export { addToStores, storeUrls } from "./storeState";

// Devs! Add your stores here <3
// TODO: Abstract this to a git repo
addToStores("https://github.com/SuperslowJelly/TIDAL-Clear-Coat/releases/download/latest/store.json");
addToStores("https://github.com/meowarex/TidalLuna-Plugins/releases/download/latest/store.json");
addToStores("https://github.com/wont-stream/lunar/releases/download/dev/store.json");
addToStores("https://github.com/jxnxsdev/luna-plugins/releases/download/latest/store.json");
addToStores("https://github.com/espeon/luna-plugins/releases/download/latest/store.json");
addToStores("https://github.com/Inrixia/luna-plugins/releases/download/dev/store.json");
addToStores("https://github.com/Aztup/luna-plugins/releases/download/latest/store.json");
addToStores("https://github.com/vMohammad24/luna-plugins/releases/download/latest/store.json");
addToStores("https://github.com/MathDesigns/luna-plugins/releases/download/latest/store.json");
addToStores("https://github.com/otomir23/luna-plugins/releases/download/latest/store.json");
addToStores("https://github.com/dantraynor/lunaplugins/releases/download/latest/store.json");
addToStores("https://github.com/Akasiek/tidaluna-plugins/releases/download/latest/store.json");
addToStores("https://github.com/Foukapik/TidaLuna-Plugins/releases/download/latest/store.json");
addToStores("https://github.com/Renskursa/tidaluna-plugins/releases/download/latest/store.json");
addToStores("https://github.com/Henr1ES/TidalLunaPlugins/releases/download/latest/store.json");
addToStores("https://github.com/DevonCasey/tidaluna-plugins/releases/download/latest/store.json");
addToStores("https://github.com/SinnerK0N/tidaluna-plugins/releases/download/latest/store.json");
addToStores("https://github.com/squadgazzz/luna-plugins/releases/download/latest/store.json");

export const PluginStoreTab = React.memo(() => {
	const [_storeUrls, setPluginStores] = useState<string[]>(obyStore.unwrap(storeUrls));
	const [searchQuery, setSearchQuery] = useState("");

	useEffect(() => obyStore.on(storeUrls, () => setPluginStores([...obyStore.unwrap(storeUrls)])), []);
	const onRemove = useCallback((storeUrl: string) => {
		const index = storeUrls.indexOf(storeUrl);
		if (index > -1) storeUrls.splice(index, 1);
	}, []);

	return (
		<Stack spacing={2}>
			<Stack direction="row" spacing={2}>
				<InstallFromUrl />
				<TextField
					fullWidth
					size="small"
					placeholder="Search plugins..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
				/>
			</Stack>
			<LunaStore url={"http://127.0.0.1:3000"} onRemove={() => {}} searchQuery={searchQuery} />
			{_storeUrls.map((store) => (
				<LunaStore key={store} url={store} onRemove={() => onRemove(store)} searchQuery={searchQuery} />
			))}
		</Stack>
	);
});
