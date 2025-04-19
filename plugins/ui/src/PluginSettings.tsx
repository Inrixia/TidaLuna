import React from "react";

import Stack from "@mui/material/Stack";

import { LunaPlugin } from "@luna/core";
import { LunaPluginSettings } from "./components";

export const PluginSettings = React.memo(() => {
	const plugins = [];
	for (const pluginName in LunaPlugin.plugins) {
		if (LunaPlugin.lunaPlugins.includes(pluginName)) continue;
		plugins.push(<LunaPluginSettings key={pluginName} plugin={LunaPlugin.plugins[pluginName]} />);
	}
	return <Stack spacing={2}>{plugins}</Stack>;
});
