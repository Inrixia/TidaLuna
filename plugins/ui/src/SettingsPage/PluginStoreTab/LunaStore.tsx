import React from "react";

import { type PluginPackage } from "@luna/core";

import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { RefreshIcon } from "../../components/LunaDrawnIcons";
import { LunaIcon, icons } from "../../components/LunaIcon";
import { LunaBadge, LunaGroup, LunaRow, LunaSection } from "../../components/LunaList";
import { iconBtnSx, metaSx, oneLineSx, sectionSx, wave } from "../../tidalTokens";
import { LunaStorePlugin } from "./LunaStorePlugin";
import { DEV_STORE_URL } from "./index";
import { metricsAreFresh, type RegistryStore } from "./registry";

interface StorePackage extends PluginPackage {
	plugins: string[];
	/** Store wide download opt in, set once in the store repo's package.json */
	showDownloads?: boolean;
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
	// Incremented on an explicit reload so the cards refetch their own metadata too
	const [refreshToken, setRefreshToken] = React.useState(0);

	const fetchPackage = React.useCallback(async () => {
		setLoading(true);
		setLoadError(undefined);
		try {
			const response = await fetch(`${url}/store.json`);
			if (!response.ok) throw new Error(`Failed to fetch package: ${response.statusText}`);
			setPackage(await response.json());
		} catch (error: any) {
			// The local dev store is absent unless someone is building a plugin, so its failure is
			// expected and must not spam the console on every start
			if (url !== DEV_STORE_URL) console.error(`[PluginStore] Could not load ${url}:`, error);
			setLoadError(error.message || "Unknown error occurred");
			setPackage(undefined);
		} finally {
			setLoading(false);
		}
	}, [url]);

	React.useEffect(() => {
		fetchPackage();
	}, [fetchPackage]);

	const isLocalDevStore = url === DEV_STORE_URL;

	if (pkg === undefined && !loading && !loadError) return null;
	// The local dev store is absent for everyone who is not building a plugin, never shout about it
	if (isLocalDevStore && (loadError || (!pkg && !loading))) return null;

	// The registry knows the name even when the store itself is unreachable
	const name = `${pkg?.name ?? entry?.name ?? "Unknown Store"}${isLocalDevStore ? " [DEV]" : ""}`;
	const link = pkg?.homepage ?? pkg?.repository?.url ?? url;

	// A stale registry means wrong numbers, and a wrong number is worse than none
	const metrics = metricsAreFresh() ? entry : undefined;

	// Stores are third party json, a malformed plugins array must not take the whole settings page down
	const plugins = Array.isArray(pkg?.plugins) ? pkg.plugins.filter((plugin) => typeof plugin === "string") : undefined;
	const query = searchQuery.trim().toLowerCase();
	const filtered = query ? plugins?.filter((plugin) => plugin.toLowerCase().includes(query)) : plugins;
	if (query && !filtered?.length) return null;

	return (
		<LunaSection
			title={
				<Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
					<Tooltip title={url} placement="top-start">
						<Typography
							component="a"
							href={link}
							target="_blank"
							rel="noreferrer"
							sx={{ ...sectionSx, ...oneLineSx, minWidth: 0, textDecoration: "none", "&:hover": { color: wave.accent } }}
							children={name}
						/>
					</Tooltip>
					{metrics?.stars ? (
						<Typography
							title={`Stars of ${metrics.repo}, shared by all plugins in this store`}
							sx={{ ...metaSx, flex: "0 0 auto" }}
							children={`${metrics.stars.toLocaleString()} stars`}
						/>
					) : null}
					{metrics?.health === "archived" && <LunaBadge tone="warning" children="Archived" />}
					{metrics?.health === "unreachable" && <LunaBadge tone="warning" children="Unreachable" />}
					{filtered !== undefined && (
						<Typography sx={{ ...metaSx, flex: "0 0 auto" }} children={`${filtered.length} plugin${filtered.length === 1 ? "" : "s"}`} />
					)}
				</Stack>
			}
			desc={pkg?.description ?? undefined}
			trailing={
				<Stack direction="row" spacing={0.5} sx={{ alignItems: "center", flexShrink: 0 }}>
					<Tooltip title="Reload store">
						<span>
							<IconButton
									disableRipple
									disabled={loading}
									onClick={() => {
										setRefreshToken((n) => n + 1);
										fetchPackage();
									}}
									sx={iconBtnSx}
									children={<RefreshIcon size={18} />}
								/>
						</span>
					</Tooltip>
					<Tooltip title="Remove store">
						<span>
							<IconButton
								disableRipple
								disabled={isLocalDevStore}
								onClick={onRemove}
								sx={{ ...iconBtnSx, "&:hover": { color: wave.danger, backgroundColor: wave.line } }}
								children={<LunaIcon name={icons.trash} size={18} />}
							/>
						</span>
					</Tooltip>
				</Stack>
			}
		>
			{loadError ? (
				<LunaGroup>
					<LunaRow
						lead={<LunaIcon name={icons.alert} size={16} sx={{ color: wave.danger }} />}
						title="This store could not be loaded"
						desc={<Typography title={`${loadError} - ${url}`} sx={{ ...metaSx, ...oneLineSx, color: wave.danger }} children={`${loadError} - ${url}`} />}
					/>
				</LunaGroup>
			) : (
				<Box
					sx={{
						display: "grid",
						// Cards side by side, wrapping to as many columns as the width allows
						gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
						gap: 1.5,
						// start, not stretch: one card with a preview would otherwise stretch every
						// other card in its row and leave them with dead space
						alignItems: "start",
					}}
				>
					{filtered?.map((plugin) => (
						<LunaStorePlugin
							key={plugin}
							url={`${url}/${isLocalDevStore ? plugin : plugin.replaceAll(" ", ".")}`}
							downloads={metrics?.downloads?.[plugin]}
							storeShowDownloads={pkg?.showDownloads}
							refreshToken={refreshToken}
						/>
					))}
				</Box>
			)}
		</LunaSection>
	);
});
