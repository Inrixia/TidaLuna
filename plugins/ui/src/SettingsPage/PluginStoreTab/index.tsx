import React, { useCallback, useEffect, useState } from "react";

import { store as obyStore } from "oby";

import { unloadSet } from "@luna/core";

import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { InstallFromUrl } from "./InstallFromUrl";
import { LunaStore } from "./LunaStore";
import { hiddenStoreUrls, refreshRegistry, registryStores, removeStore, userStoreUrls, visibleStores, type StoreEntry } from "./registry";

export * from "./registry";

const DEV_STORE_URL = "http://127.0.0.1:3000";

export const PluginStoreTab = React.memo(() => {
	const [stores, setStores] = useState<StoreEntry[]>(visibleStores);
	const [searchQuery, setSearchQuery] = useState("");

	useEffect(() => {
		const update = () => setStores(visibleStores());
		// Any of the three can change the visible list, the registry from a fetch and the other two from the user
		const unloads = new Set([obyStore.on(registryStores, update), obyStore.on(userStoreUrls, update), obyStore.on(hiddenStoreUrls, update)]);
		refreshRegistry().catch((err) => console.error("[PluginStore] Failed to refresh registry:", err));
		// Block body on purpose, unloadSet is async and React rejects a Promise as cleanup
		return () => {
			unloadSet(unloads);
		};
	}, []);

	const onRemove = useCallback((storeUrl: string) => removeStore(storeUrl), []);

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
			<LunaStore url={DEV_STORE_URL} onRemove={() => {}} searchQuery={searchQuery} />
			{stores.map((store) => (
				<LunaStore key={store.url} url={store.url} entry={store.entry} onRemove={() => onRemove(store.url)} searchQuery={searchQuery} />
			))}
			{stores.length === 0 && (
				<Typography variant="subtitle2" sx={{ opacity: 0.7 }}>
					No plugin stores yet. They load from the registry, check your connection or add one above.
				</Typography>
			)}
		</Stack>
	);
});
