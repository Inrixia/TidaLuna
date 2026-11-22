import Stack from "@mui/material/Stack";
import React from "react";

import { LunaSettings } from "../../components";

import { LunaPlugin } from "@luna/core";
import { LunaPluginSettings } from "../PluginsTab/LunaPluginSettings";
import { LunaCacheSettings } from "./LunaCacheSettings";
import { LunaFeatureFlags } from "./LunaFeatureFlags";
import { LunaNativePermissions } from "./LunaNativePermissions";
import { LunaSettingsTransfer } from "./LunaSettingsTransfer";
import { LunaShortcuts } from "./LunaShortcuts";
import { LunaVersionInfo } from "./LunaVersionInfo";

export const SettingsTab = React.memo(() => {
	const corePlugins = [];
	for (const plugin of Object.values(LunaPlugin.plugins)) {
		if (!LunaPlugin.corePlugins.has(plugin.name)) continue;
		corePlugins.push(<LunaPluginSettings key={plugin.url} plugin={plugin} />);
	}
	return (
		<Stack spacing={4}>
			<LunaVersionInfo />
			<LunaSettingsTransfer />
			<LunaShortcuts />
			<LunaNativePermissions />
			<LunaFeatureFlags />
			<LunaCacheSettings />
			<LunaSettings title="Luna core plugins" desc="Plugins providing core luna functionality">
				{corePlugins}
			</LunaSettings>
		</Stack>
	);
});
