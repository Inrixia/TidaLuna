import React, { type PropsWithChildren } from "react";

import Container from "@mui/material/Container";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";

import ExtensionIcon from "@mui/icons-material/Extension";
import FavoriteIcon from "@mui/icons-material/Favorite";
import PaletteIcon from "@mui/icons-material/Palette";
import SettingsIcon from "@mui/icons-material/Settings";
import StorefrontIcon from "@mui/icons-material/Storefront";

import { Signal } from "@inrixia/helpers";
import { PluginsTab } from "./PluginsTab";
import { PluginStoreTab } from "./PluginStoreTab";
import { SettingsTab } from "./SettingsTab";
import { SupportersTab } from "./SupportersTab";
import { ThemesTab } from "./ThemesTab";

type LunaSettingsTab = "Plugins" | "Plugin Store" | "Settings" | "Themes" | "Supporters";

const LunaTabPage = React.memo(({ tab, currentTab, children }: { tab: LunaSettingsTab; currentTab: LunaSettingsTab } & PropsWithChildren) => {
	if (tab !== currentTab) return null;
	return <Container sx={{ marginTop: 3, marginLeft: -3 }} children={children} />;
});

export const currentSettingsTab = new Signal<LunaSettingsTab>("Plugins");
export const LunaPage = React.memo(() => {
	const [currentTab, setCurrentTab] = React.useState(currentSettingsTab._);
	React.useEffect(() => {
		const unload = currentSettingsTab.onValue((tab) => setCurrentTab(tab));
		return () => {
			unload();
		};
	}, []);
	return (
		<Container maxWidth="md" sx={{ padding: 0, marginBottom: 10, flexGrow: 1 }}>
			<Tabs value={currentTab} onChange={(_, tab) => (currentSettingsTab._ = tab)}>
				<Tab iconPosition="start" icon={<ExtensionIcon />} value={"Plugins"} label={"Plugins"} />
				<Tab iconPosition="start" icon={<StorefrontIcon />} value={"Plugin Store"} label={"Plugin Store"} />
				<Tab iconPosition="start" icon={<PaletteIcon />} value={"Themes"} label={"Themes"} />
				<Tab iconPosition="start" icon={<SettingsIcon />} value={"Settings"} label={"Settings"} />
				<Tab iconPosition="start" icon={<FavoriteIcon />} value={"Supporters"} label={"Supporters"} />
			</Tabs>
			<LunaTabPage tab={"Plugins"} currentTab={currentTab} children={<PluginsTab />} />
			<LunaTabPage tab={"Settings"} currentTab={currentTab} children={<SettingsTab />} />
			<LunaTabPage tab={"Plugin Store"} currentTab={currentTab} children={<PluginStoreTab />} />
			<LunaTabPage tab={"Themes"} currentTab={currentTab} children={<ThemesTab />} />
			<LunaTabPage tab={"Supporters"} currentTab={currentTab} children={<SupportersTab />} />
		</Container>
	);
});
