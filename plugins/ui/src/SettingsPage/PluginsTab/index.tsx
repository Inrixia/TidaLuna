import React from "react";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";

import { LunaPlugin } from "@luna/core";
import { LunaPluginSettings } from "./LunaPluginSettings";
import { ReloadAllPlugins } from "./ReloadAllPlugins";
import { installedPlugins, matchingPluginNames, watchInstalledPlugins } from "./installedPlugins";

export const PluginsTab = React.memo(() => {
	const [query, setQuery] = React.useState("");
	const [descending, setDescending] = React.useState(false);
	const readInstalled = () => installedPlugins(Object.values(LunaPlugin.plugins), descending);
	const [eligible, setEligible] = React.useState(readInstalled);
	React.useEffect(() => watchInstalledPlugins(LunaPlugin.plugins, descending, setEligible), [descending]);
	if (!eligible.length) return "You have no plugins installed!";
	const visible = matchingPluginNames(eligible, query);
	return (
		<Stack spacing={2}>
			<ReloadAllPlugins />
			<Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ width: "100%", alignItems: { sm: "center" } }}>
				<TextField
					fullWidth
					type="search"
					placeholder="Search installed plugins"
					slotProps={{ htmlInput: { "aria-label": "Search installed plugins" } }}
					sx={{ flex: { sm: "1 1 0" }, minWidth: 0 }}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<TextField
					select
					size="small"
					label="Sort by name"
					value={descending ? "desc" : "asc"}
					sx={{ minWidth: 140, "& .MuiSelect-icon": { color: "text.secondary" } }}
					onChange={(event) => setDescending(event.target.value === "desc")}
				>
					<MenuItem value="asc">A–Z</MenuItem>
					<MenuItem value="desc">Z–A</MenuItem>
				</TextField>
			</Stack>
			{!visible.size && <span role="status">No installed plugins match your search.</span>}
			{eligible.map((plugin) => (
				<div key={plugin.url} hidden={!visible.has(plugin)}>
					<LunaPluginSettings plugin={plugin} />
				</div>
			))}
		</Stack>
	);
});
