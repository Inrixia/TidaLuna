import React from "react";

import { type PluginPackage } from "@luna/core";

import Grid from "@mui/material/Grid";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { LunaTrashButton, SpinningButton } from "../../components";
import { LunaPluginHeader } from "../PluginsTab/LunaPluginHeader";
import { LunaStorePlugin } from "./LunaStorePlugin";
import type { RegistryStore } from "./registry";

interface StorePackage extends PluginPackage {
	plugins: string[];
}

interface LunaStoreProps {
	url: string;
	onRemove: () => void;
	searchQuery: string;
	/** Registry metadata, undefined for stores the user added themselves */
	entry?: RegistryStore;
}

export const LunaStore = React.memo(({ url, onRemove, searchQuery, entry }: LunaStoreProps) => {
	const [loading, setLoading] = React.useState(false);
	const [loadError, setLoadError] = React.useState<string | undefined>(undefined);
	const [pkg, setPackage] = React.useState<StorePackage | undefined>(undefined);

	const disabled = loading; // Disable controls while loading

	const fetchPackage = React.useCallback(async () => {
		setLoading(true);
		setLoadError(undefined);
		try {
			const response = await fetch(`${url}/store.json`);
			if (!response.ok) throw new Error(`Failed to fetch package: ${response.statusText}`);
			const data = await response.json();
			setPackage(data);
		} catch (error: any) {
			console.error("Error fetching package:", error);
			setLoadError(error.message || "Unknown error occurred");
			setPackage(undefined); // Clear package on error
		} finally {
			setLoading(false);
		}
	}, [url]);

	React.useEffect(() => {
		fetchPackage();
	}, [fetchPackage]); // Depend on the memoized fetch function

	const isLocalDevStore = url === "http://127.0.0.1:3000";

	if (pkg === undefined && !loading && !loadError) return null; // Don't render anything until initial load attempt
	if (!isLocalDevStore && loading && !pkg) return <Typography>Loading store {url}...</Typography>; // Show loading indicator if still loading initially

	// The registry knows the name even when the store itself is unreachable
	let name = pkg?.name ?? entry?.name ?? "Unknown Store";
	if (isLocalDevStore) name = `${name} [DEV]`;

	const author = pkg?.author;
	const desc = pkg?.description;

	const link = pkg?.homepage ?? pkg?.repository?.url ?? url;

	// Don't show error for local dev store
	if (loadError && isLocalDevStore) return null;

	// Stores are third party json, a malformed plugins array must not take the whole settings page down
	const plugins = Array.isArray(pkg?.plugins) ? pkg.plugins.filter((plugin) => typeof plugin === "string") : undefined;
	const query = searchQuery.toLowerCase();
	const filteredPlugins = query ? plugins?.filter((plugin) => plugin.toLowerCase().includes(query)) : plugins;
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
						<SpinningButton title="Reload store" spin={loading} disabled={disabled} onClick={fetchPackage} />
						<LunaTrashButton disabled={isLocalDevStore} title="Remove store" onClick={onRemove} />
					</>
				}
			/>
			<Grid columns={2} spacing={2} container>
				{filteredPlugins?.map((plugin) => (
					<Grid size={1} children={<LunaStorePlugin url={`${url}/${isLocalDevStore ? plugin : plugin.replaceAll(" ", ".")}`} key={plugin} />} />
				))}
			</Grid>
		</Stack>
	);
});
