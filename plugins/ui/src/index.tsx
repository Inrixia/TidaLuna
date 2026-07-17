import { ThemeProvider } from "@mui/material/styles";
import { ConfirmProvider } from "material-ui-confirm";
import React from "react";
import semverGt from "semver/functions/gt";
import semverRcompare from "semver/functions/rcompare";

import { ContextMenu, ipcRenderer } from "@luna/lib";

import { Page } from "./classes/Page";

import { confirm } from "./helpers/confirm";
import { lunaMuiTheme } from "./lunaTheme";
import { currentSettingsTab, LunaPage } from "./SettingsPage";
import { storeUrls } from "./SettingsPage/PluginStoreTab";
import { fetchReleases } from "./SettingsPage/SettingsTab/LunaClientUpdate";

import { pkg } from "plugins/lib.native/src/index.native";
import { unloads } from "./index.safe";

export * from "./classes";
export * from "./components";
export * from "./helpers";

export { lunaMuiTheme, unloads };

const settingsPage = Page.register(
	"LunaSettings",
	unloads,
	<ThemeProvider theme={lunaMuiTheme}>
		<ConfirmProvider>
			<LunaPage />
		</ConfirmProvider>
	</ThemeProvider>,
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

ipcRenderer.onOpenUrl(unloads, (reqUrl) => {
	const url = URL.parse(reqUrl.toLowerCase());
	if (url?.protocol !== "tidaluna:") return;
	switch (url.pathname) {
		case "//settings/store":
			currentSettingsTab._ = "Plugin Store";
			const newStoreUrl = url.searchParams.get("installfromurl");
			if (newStoreUrl !== null && !storeUrls.includes(newStoreUrl)) storeUrls.push(newStoreUrl);
			break;
		case "//settings/plugins":
			currentSettingsTab._ = "Plugins";
			break;
	}
	if (url.pathname.startsWith("//settings")) settingsPage.open();
});

setTimeout(async () => {
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
