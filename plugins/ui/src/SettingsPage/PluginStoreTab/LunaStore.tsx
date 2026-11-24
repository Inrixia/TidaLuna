import React from "react";

import { LunaPlugin, type PluginPackage } from "@luna/core";

import { hostAllowed } from "../../../../../native/core/hosts";

import Grid from "@mui/material/Grid";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import Button from "@mui/material/Button";

import { LunaTrashButton, SpinningButton } from "../../components";
import { allowSource, reloadToRead } from "../allowSource";
import { LunaPluginHeader } from "../PluginsTab/LunaPluginHeader";
import { LunaStorePlugin } from "./LunaStorePlugin";

interface StorePackage extends PluginPackage {
	plugins: string[];
}

export const LunaStore = React.memo(({ url, onRemove, searchQuery }: { url: string; onRemove: () => void; searchQuery: string }) => {
	const [loading, setLoading] = React.useState(false);
	const [loadError, setLoadError] = React.useState<string | undefined>(undefined);
	const [pkg, setPackage] = React.useState<StorePackage | undefined>(undefined);

	const disabled = loading; // Disable controls while loading
	// The page can't read the store's origin yet (strict network): the user may allow it
	const [blocked, setBlocked] = React.useState(false);

	const fetchPackage = React.useCallback(async () => {
		setLoading(true);
		setLoadError(undefined);
		setBlocked(false);
		try {
			const response = await fetch(`${url}/store.json`);
			if (!response.ok) throw new Error(`Failed to fetch package: ${response.statusText}`);
			const data = await response.json();
			setPackage(data);
		} catch (error: any) {
			// The local dev store is only up while developing plugins
			if (url !== "http://127.0.0.1:3000") console.error("Error fetching package:", error);
			setLoadError(error.message || "Unknown error occurred");
			// A network error, not an answer: maybe the page's connect-src doesn't list the store. GitHub and the other
			// baseline hosts are in it without being a store origin: for them it's the network
			if (error instanceof TypeError)
				Promise.all([__LunaCore.pageStores(), __LunaCore.pageConnect()]).then(([origins, connect]) => {
					const at = new URL(url);
					setBlocked(!origins.includes(at.origin) && !hostAllowed(connect, at));
				}, () => {});
			setPackage(undefined); // Clear package on error
		} finally {
			setLoading(false);
		}
	}, [url]);

	React.useEffect(() => {
		fetchPackage();
	}, [fetchPackage]); // Depend on the memoized fetch function

	const allow = React.useCallback(async () => {
		const access = await allowSource(`${url}/store.json`);
		if (access === "denied") return;
		setBlocked(false);
		// "ready": the page can read it now (GitHub, or allowed earlier), so read it
		if (access === "reload") setLoadError(reloadToRead(url));
		else fetchPackage();
	}, [url, fetchPackage]);

	const isLocalDevStore = url === "http://127.0.0.1:3000";

	if (pkg === undefined && !loading && !loadError) return null; // Don't render anything until initial load attempt
	if (!isLocalDevStore && loading && !pkg) return <Typography>Loading store {url}...</Typography>; // Show loading indicator if still loading initially

	let name = pkg?.name ?? "Unknown Store";
	if (isLocalDevStore) name = `${name} [DEV]`;

	const author = pkg?.author;
	const desc = pkg?.description;

	const link = pkg?.homepage ?? pkg?.repository?.url ?? url;

	// Don't show error for local dev store
	if (loadError && isLocalDevStore) return null;

	const query = searchQuery.toLowerCase();
	const filteredPlugins = query ? pkg?.plugins.filter((plugin) => plugin.toLowerCase().includes(query)) : pkg?.plugins;
	if (query && (!filteredPlugins || filteredPlugins.length === 0)) return null;

	return (
		<Stack
			spacing={1}
			sx={{
				borderRadius: 3,
				backgroundColor: "rgba(0, 0, 0, 0.10)",
				boxShadow: loadError ? "0 0 10px rgba(255, 0, 0, 0.70)" : "none",
				padding: 2,
			}}
		>
			<LunaPluginHeader
				name={name}
				link={link}
				loadError={loadError}
				author={author}
				desc={desc}
				children={
					<>
						{blocked && <Button size="small" variant="outlined" onClick={allow} children="Allow store" />}
						<SpinningButton title="Reload store" spin={loading} disabled={disabled} onClick={fetchPackage} />
						<LunaTrashButton disabled={isLocalDevStore} title="Remove store" onClick={onRemove} />
					</>
				}
			/>
			<Grid columns={2} spacing={2} container>
				{filteredPlugins?.map((plugin) => (
					<Grid size={1} children={<LunaStorePlugin url={LunaPlugin.storePluginUrl(url, plugin)} key={plugin} />} />
				))}
			</Grid>
		</Stack>
	);
});
