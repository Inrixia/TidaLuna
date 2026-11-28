import { ConfirmProvider } from "material-ui-confirm";
import React from "react";
import semverGt from "semver/functions/gt";
import semverRcompare from "semver/functions/rcompare";

import { ContextMenu, ipcRenderer, safeTimeout } from "@luna/lib";

import { Page } from "./classes/Page";

import { confirm } from "./helpers/confirm";
import { MuiTheme, lunaMuiTheme, LunaMuiThemeProvider } from "./lunaTheme";
export type { MuiThemeOverride } from "./lunaTheme";
import { currentSettingsTab, LunaPage } from "./SettingsPage";
export { currentSettingsTab, SettingsTabs } from "./SettingsPage";
export type { SettingsTabContent, SettingsTabDefinition, SettingsTabOverride, SettingsTabProps } from "./SettingsPage";
import { addToStores, normalizeStoreUrl, storeUrls } from "./SettingsPage/PluginStoreTab";
import { fetchReleases } from "./SettingsPage/SettingsTab/LunaClientUpdate";

import { pkg } from "../../lib.native/src/index.native";
import { unloads } from "./index.safe";
import "./logoutConfirm";

export * from "./classes";
export * from "./components";
export * from "./helpers";
export * from "./react";

export { MuiTheme, lunaMuiTheme, LunaMuiThemeProvider, unloads };

/** The Luna Settings page, plugins can restyle it via settingsPage.pageStyles */
export const settingsPage = Page.register(
	"LunaSettings",
	unloads,
	<LunaMuiThemeProvider>
		<ConfirmProvider>
			<LunaPage />
		</ConfirmProvider>
	</LunaMuiThemeProvider>,
);
// thx @n1ckoates re CoverTheme <3
settingsPage.pageStyles.background = `
radial-gradient(ellipse at top left, rgba(88, 10, 82, 0.5), transparent 70%),
radial-gradient(ellipse at center left, rgba(18, 234, 246, 0.5), transparent 70%),
radial-gradient(ellipse at bottom left, rgba(205, 172, 191, 0.5), transparent 70%),
radial-gradient(ellipse at top right, rgba(139, 203, 235, 0.5), transparent 70%),
radial-gradient(ellipse at center right, rgba(98, 103, 145, 0.5), transparent 70%),
radial-gradient(ellipse at bottom right, rgba(47, 48, 78, 0.5), transparent 70%)`;

const SettingsButton = ContextMenu.addButton(unloads);
SettingsButton.text = "Luna Settings";
SettingsButton.onClick(() => settingsPage.open());
ContextMenu.onOpen(unloads, async ({ event, contextMenu }) => {
	if (event.type === "USER_PROFILE") {
		const elem = await SettingsButton.show(contextMenu);
		if (elem) elem.style.color = "#31d8ff";
	}
});

ipcRenderer.onOpenUrl(unloads, async (reqUrl) => {
	const url = URL.parse(reqUrl);
	if (url?.protocol !== "tidaluna:") return;
	// Newer Chromium parses tidaluna://settings/store as host "settings" + path "/store", older as path "//settings/store"
	// Only the route is case-insensitive, store urls keep their case
	const route = (url.host + url.pathname).replace(/^\/+|\/+$/g, "").toLowerCase();
	switch (route) {
		case "settings/store":
			currentSettingsTab._ = "Plugin Store";
			settingsPage.open();
			for (const [key, value] of url.searchParams) {
				if (key.toLowerCase() !== "installfromurl" || storeUrls.includes(normalizeStoreUrl(value))) continue;
				// Any web page can open this link, so ask before adding a store
				const res = await confirm({
					title: "Add plugin store?",
					description: value,
					confirmationText: "Add store",
					cancellationText: "Cancel",
				});
				if (res.confirmed) addToStores(value);
			}
			return;
		case "settings/plugins":
			currentSettingsTab._ = "Plugins";
			break;
	}
	if (route.startsWith("settings")) settingsPage.open();
});

safeTimeout(unloads, async () => {
	const latestReleaseTag = (await fetchReleases())
		.filter((release) => !release.prerelease)
		.map((rel) => rel.tag_name)
		.sort(semverRcompare)[0];
	if (semverGt(latestReleaseTag, (await pkg()).version!, true)) {
		const res = await confirm({
			title: (
				<>
					New version available! <b>{latestReleaseTag}</b>
				</>
			),
			description: "There is a new TidaLuna client version available. Open settings to update?",
			confirmationText: "Open Settings",
			cancellationText: "Close",
		});
		if (!res.confirmed) return;
		currentSettingsTab._ = "Settings";
		settingsPage.open();
	}
});
