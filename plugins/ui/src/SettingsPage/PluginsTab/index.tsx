import React from "react";

import Stack from "@mui/material/Stack";

import { LunaPlugin } from "@luna/core";
import { LunaPluginSettings } from "./LunaPluginSettings";
import { PluginSearchBar } from "./PluginSearchBar";

export const PluginsTab = React.memo(() => {
	const [searchTerm, setSearchTerm] = React.useState("");

	const allPlugins: LunaPlugin[] = [];
	for (const pluginName in LunaPlugin.plugins) {
		if (LunaPlugin.corePlugins.has(pluginName)) continue;
		allPlugins.push(LunaPlugin.plugins[pluginName]);
	}

	// Filter plugins based on search term
	const filteredPlugins = React.useMemo(() => {
		if (!searchTerm.trim()) return allPlugins;

		const lowerSearch = searchTerm.toLowerCase();
		return allPlugins.filter((plugin) => {
			const name = plugin.name?.toLowerCase() || "";
			const desc = plugin.package?.description?.toString().toLowerCase() || "";
			const author = typeof plugin.package?.author === "string"
				? plugin.package.author.toLowerCase()
				: plugin.package?.author?.name?.toLowerCase() || "";

			return name.includes(lowerSearch) || desc.includes(lowerSearch) || author.includes(lowerSearch);
		});
	}, [searchTerm, allPlugins.length]);

	if (allPlugins.length === 0) return "You have no plugins installed!";

	return (
		<Stack spacing={2}>
			<PluginSearchBar
				searchTerm={searchTerm}
				onSearchChange={setSearchTerm}
				totalCount={allPlugins.length}
				filteredCount={filteredPlugins.length}
			/>
			{filteredPlugins.length === 0 ? (
				<div style={{ textAlign: "center", padding: "2rem", opacity: 0.6 }}>
					No plugins found matching "{searchTerm}"
				</div>
			) : (
				filteredPlugins.map((plugin) => <LunaPluginSettings key={plugin.name} plugin={plugin} />)
			)}
		</Stack>
	);
});
