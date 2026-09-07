import Stack from "@mui/material/Stack";
import React, { useCallback, useState } from "react";

import { LunaPlugin } from "@luna/core";

import { LunaGroup, LunaSection } from "../../components/LunaList";
import { metrics, wave } from "../../tidalTokens";
import { LunaPluginSettings } from "../PluginsTab/LunaPluginSettings";
import { LunaFeatureFlags } from "./LunaFeatureFlags";
import { LunaSettingsTransfer } from "./LunaSettingsTransfer";
import { LunaVersionInfo } from "./LunaVersionInfo";

export const SettingsTab = React.memo(() => {
	// Core plugins share the single open accordion behaviour of the Plugins tab
	const [openId, setOpenId] = useState<string | undefined>(undefined);
	const toggle = useCallback((url: string) => setOpenId((prev) => (prev === url ? undefined : url)), []);

	const corePlugins = Object.values(LunaPlugin.plugins)
		.filter((plugin) => LunaPlugin.corePlugins.has(plugin.name))
		.sort((a, b) => a.name.localeCompare(b.name));

	return (
		<Stack spacing={3} sx={{ fontFamily: wave.font, maxWidth: metrics.maxTextW }}>
			<LunaVersionInfo />
			<LunaSettingsTransfer />
			<LunaFeatureFlags />
			<LunaSection title="Luna core plugins" desc="Plugins providing core Luna functionality">
				<LunaGroup>
					{corePlugins.map((plugin) => (
						<LunaPluginSettings key={plugin.store.url} plugin={plugin} open={openId === plugin.store.url} onToggle={() => toggle(plugin.store.url)} />
					))}
				</LunaGroup>
			</LunaSection>
		</Stack>
	);
});
