import React, { useCallback, useEffect, useState } from "react";

import { store as obyStore } from "oby";

import { unloadSet } from "@luna/core";

import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { LunaGroup, LunaRow, LunaSection } from "../../components/LunaList";
import { LunaIcon, icons } from "../../components/LunaIcon";
import { LunaSearch } from "../../components/LunaSearch";
import { descSx, glassSx, iconBtnSx, metrics, searchStickyTop, wave } from "../../tidalTokens";
import { InstallFromUrl } from "../Storage";
import { LunaStore } from "./LunaStore";
import { hiddenStoreUrls, refreshRegistry, registryStores, removeStore, userStoreUrls, visibleStores, type StoreEntry } from "./registry";

export * from "./registry";

export const DEV_STORE_URL = "http://127.0.0.1:3000";

export const PluginStoreTab = React.memo(() => {
	const [stores, setStores] = useState<StoreEntry[]>(visibleStores);
	const [searchQuery, setSearchQuery] = useState("");
	const [addOpen, setAddOpen] = useState(false);

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
		<Stack spacing={3} sx={{ fontFamily: wave.font, maxWidth: metrics.maxTextW }}>
			{/* Sticky at Tidal's search-bar height so filtering a long list never means scrolling up */}
			<Box sx={{ position: "sticky", top: searchStickyTop, zIndex: 3 }}>
				<Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
					<Box sx={{ flex: 1, minWidth: 0 }}>
						<LunaSearch value={searchQuery} onChange={setSearchQuery} placeholder="Search plugins" />
					</Box>
					{/* Adding a store is rare next to searching, so it is one button here rather than a
					    whole section competing for the top of the page. The plus turns into a cross while
					    the field is open, which is the same glyph rotated and says what the click undoes. */}
					<Tooltip title={addOpen ? "Close" : "Add a store, plugin or theme"}>
						<IconButton
							disableRipple
							aria-expanded={addOpen}
							onClick={() => setAddOpen((open) => !open)}
							sx={{
								...iconBtnSx,
								width: 36,
								height: 36,
								flexShrink: 0,
								...glassSx,
								color: addOpen ? wave.text : wave.textSecondary,
								"& svg": { transition: "transform 220ms cubic-bezier(0.2, 0, 0, 1)", transform: addOpen ? "rotate(45deg)" : "rotate(0deg)" },
								"&:hover": { color: wave.text },
								"@media (prefers-reduced-motion: reduce)": { "& svg": { transition: "none" } },
							}}
							children={<LunaIcon name={icons.add} size={18} />}
						/>
					</Tooltip>
				</Stack>
			</Box>

			{addOpen && (
				<LunaSection title="Add a store or plugin" desc="Paste a link to a store.json, a plugin, or a .css theme.">
					<InstallFromUrl />
				</LunaSection>
			)}

			<LunaStore url={DEV_STORE_URL} onRemove={() => {}} searchQuery={searchQuery} />
			{stores.map((store) => (
				<LunaStore key={store.url} url={store.url} entry={store.entry} onRemove={() => onRemove(store.url)} searchQuery={searchQuery} />
			))}

			{stores.length === 0 && (
				<LunaGroup>
					<LunaRow
						title="No plugin stores yet"
						desc="They load from the registry. Check your connection, or add one below."
					/>
				</LunaGroup>
			)}

			<Typography sx={{ ...descSx, color: wave.textTertiary }}>
				Being listed is not a security review. Plugins run with full access to your machine.
			</Typography>
		</Stack>
	);
});
