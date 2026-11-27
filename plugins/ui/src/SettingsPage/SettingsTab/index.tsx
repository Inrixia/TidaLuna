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
		if (!plugin.isCore) continue;
		corePlugins.push(<LunaPluginSettings key={plugin.url} plugin={plugin} />);
	}
	return (
		<Stack spacing={4}>
			<LunaVersionInfo />
			<LunaSettingsTransfer />
			<LunaCacheSettings />
			<LunaShortcuts />
			<LunaNativePermissions />
			<LunaFeatureFlags />
			<LunaSettings title="Luna core plugins" desc="Plugins providing core luna functionality">
				{corePlugins}
			</LunaSettings>
		</Stack>
	);
});
