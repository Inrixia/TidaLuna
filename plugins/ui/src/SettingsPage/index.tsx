import React from "react";

import Container from "@mui/material/Container";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";

import ExtensionIcon from "@mui/icons-material/Extension";
import FavoriteIcon from "@mui/icons-material/Favorite";
import PaletteIcon from "@mui/icons-material/Palette";
import SettingsIcon from "@mui/icons-material/Settings";
import StorefrontIcon from "@mui/icons-material/Storefront";

import { PluginsTab } from "./PluginsTab";
import { PluginStoreTab } from "./PluginStoreTab";
import { SettingsTab } from "./SettingsTab";
import { SupportersTab } from "./SupportersTab";
import { addBuiltInSettingsTab, currentSettingsTab, SettingsTabs, type SettingsTab as SettingsTabDef } from "./tabs";
import { ThemesTab } from "./ThemesTab";

export { currentSettingsTab, SettingsTabs } from "./tabs";
export type { SettingsTab as SettingsTabDefinition, SettingsTabContent, SettingsTabOverride, SettingsTabProps } from "./tabs";

addBuiltInSettingsTab({ id: "Plugins", label: "Plugins", icon: <ExtensionIcon />, order: 100, content: <PluginsTab /> });
addBuiltInSettingsTab({ id: "Plugin Store", label: "Plugin Store", icon: <StorefrontIcon />, order: 200, content: <PluginStoreTab /> });
addBuiltInSettingsTab({ id: "Themes", label: "Themes", icon: <PaletteIcon />, order: 300, content: <ThemesTab /> });
addBuiltInSettingsTab({ id: "Settings", label: "Settings", icon: <SettingsIcon />, order: 400, content: <SettingsTab /> });
addBuiltInSettingsTab({ id: "Supporters", label: "Supporters", icon: <FavoriteIcon />, order: 500, content: <SupportersTab /> });

// Content is either a node or a component, components can be objects too (React.memo, forwardRef)
const isComponent = (content: SettingsTabDef["content"]): content is React.ComponentType<{ active: boolean }> =>
	typeof content === "function" || (typeof content === "object" && content !== null && !React.isValidElement(content) && "$$typeof" in content);
const renderContent = (tab: SettingsTabDef, active: boolean): React.ReactNode =>
	isComponent(tab.content) ? React.createElement(tab.content, { active }) : tab.content;

const LunaTabPage = React.memo(({ tab, active }: { tab: SettingsTabDef; active: boolean }) => {
	const [visited, setVisited] = React.useState(active);
	React.useEffect(() => {
		if (active && !visited) setVisited(true);
	}, [active, visited]);

	if (!active && !(tab.keepAlive && visited)) return null;
	return (
		<Container sx={{ marginTop: 3, marginLeft: -3 }} hidden={!active} data-luna-settings-tab-page={tab.id}>
			{renderContent(tab, active)}
		</Container>
	);
});

export const LunaPage = React.memo(() => {
	const [currentTab, setCurrentTab] = React.useState(currentSettingsTab._);
	React.useEffect(() => currentSettingsTab.onValue((tab) => setCurrentTab(tab)), []);
	const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
	React.useEffect(() => SettingsTabs.onUpdate(forceUpdate), []);

	const tabs = SettingsTabs.list().filter((tab) => !tab.hidden);
	// If the selected tab was removed or hidden fall back to the first tab
	const selected = tabs.some((tab) => tab.id === currentTab) ? currentTab : tabs[0]?.id;

	return (
		<Container maxWidth="md" sx={{ padding: 0, marginBottom: 10, flexGrow: 1 }} data-luna-settings-root>
			<Tabs value={selected ?? false} onChange={(_, tab) => (currentSettingsTab._ = tab)}>
				{tabs.map((tab) => (
					<Tab key={tab.id} iconPosition="start" icon={tab.icon} value={tab.id} label={tab.label} data-luna-settings-tab={tab.id} />
				))}
			</Tabs>
			{tabs.map((tab) => (
				<LunaTabPage key={tab.id} tab={tab} active={tab.id === selected} />
			))}
		</Container>
	);
});
