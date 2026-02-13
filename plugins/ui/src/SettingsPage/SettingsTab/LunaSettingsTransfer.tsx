import React from "react";
import { useConfirm } from "material-ui-confirm";

import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import FileUploadIcon from "@mui/icons-material/FileUpload";

import { LunaPlugin, Messager, ReactiveStore } from "@luna/core";
import { redux, Tidal } from "@luna/lib";
import { relaunch } from "plugins/lib.native/src/index.native";

import { LunaButton, LunaSettings } from "../../components";

interface ExportData
{
	version: 1; //future proofing -> if anything changes we want the ability to load old exports correctly
	timestamp: string;
	pluginSettings: Record<string, unknown>; //@luna/pluginStorage
	installedPlugins: Record<string, unknown>; //@luna/plugins
	themes: unknown; //@luna/storage themes key
	featureFlags: Record<string, boolean> | null; //Tidal.featureFlags (name -> value map)
}

const pluginSettingsStore = ReactiveStore.getStore("@luna/pluginStorage");
const lunaStorage = ReactiveStore.getStore("@luna/storage");

const readAllFromStore = async (store: ReactiveStore): Promise<Record<string, unknown>> =>
{
	const keys = await store.keys();
	const data: Record<string, unknown> = {};
	for (const key of keys)
		data[key] = await store.get(key);

	return data;
};

const exportSettings = async (): Promise<ExportData> =>
{
	//plugin settings
	const pluginSettings = await readAllFromStore(pluginSettingsStore);

	//installed plugins
	const allPlugins = await readAllFromStore(LunaPlugin.pluginStorage);
	const installedPlugins: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(allPlugins))
		if (value && typeof value === "object" && (value as any).installed === true)
			installedPlugins[key] = value;

	//themes
	let themes: unknown = null;
	try
	{
		themes = await lunaStorage.get("themes");
	}
	catch (err)
	{
		console.warn("[SettingsTransfer] Could not read themes from @luna/storage: ", err);
	}

	//feature flags
	const tidalFlags = Tidal.featureFlags;
	const featureFlags: Record<string, boolean> = {};
	for (const [name, flag] of Object.entries(tidalFlags))
		featureFlags[name] = flag.value;

	return {
		version: 1,
		timestamp: new Date().toISOString(),
		pluginSettings,
		installedPlugins,
		themes,
		featureFlags,
	};
};

const downloadJson = (data: ExportData) =>
{
	const json = JSON.stringify(data, null, 2);
	const blob = new Blob([json], { type: "application/json" });
	const url = URL.createObjectURL(blob);

	const a = document.createElement("a");

	const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

	a.href = url;
	a.download = `tidaluna-settings-${dateStr}.json`;

	a.click();

	URL.revokeObjectURL(url);
};

const importSettings = async (data: ExportData) =>
{
	//plugin settings
	if (data.pluginSettings)
		for (const [key, value] of Object.entries(data.pluginSettings))
			await pluginSettingsStore.set(key, value);

	//installed plugins
	if (data.installedPlugins)
		for (const [key, value] of Object.entries(data.installedPlugins))
			await LunaPlugin.pluginStorage.set(key, value);

	//themes
	if (data.themes != null)
	{
		try
		{
			await lunaStorage.set("themes", data.themes);
		}
		catch (err)
		{
			console.error("[SettingsTransfer] Failed to import themes: ", err);
		}
	}

	//feature flags
	if (data.featureFlags != null)
	{
		const currentFlags = Tidal.featureFlags;
		for (const [name, value] of Object.entries(data.featureFlags))
			if (name in currentFlags && currentFlags[name].value !== value)
				redux.actions["featureFlags/TOGGLE_USER_OVERRIDE"]({ ...currentFlags[name], value });
	}
};

const validateImport = (data: unknown): data is ExportData =>
{
	if (typeof data !== "object" || data === null)
		return false;

	const obj = data as Record<string, unknown>;
	if (obj.version !== 1)
		return false;

	if (typeof obj.pluginSettings !== "object" && typeof obj.installedPlugins !== "object" && obj.featureFlags === undefined)
		return false;

	return true;
};

export const LunaSettingsTransfer = React.memo(() =>
{
	const confirm = useConfirm();
	const fileInputRef = React.useRef<HTMLInputElement>(null);
	const [busy, setBusy] = React.useState(false);

	const onExport = React.useCallback(async () =>
	{
		setBusy(true);
		try
		{
			const data = await exportSettings();

			downloadJson(data);

			const pluginCount = Object.keys(data.pluginSettings).length;
			const installedCount = Object.keys(data.installedPlugins).length;
			const themeCount = data.themes && typeof data.themes === "object" ? Object.keys(data.themes).length : 0;
			const hasFlags = data.featureFlags != null;
			Messager.Info(`Exported ${installedCount} installed plugins, ${pluginCount} plugin settings, ${themeCount} themes${hasFlags ? " and feature flags" : ""}`);
		}
		catch (err: any)
		{
			Messager.Error("Failed to export settings: ", err.message);
		}
		finally
		{
			setBusy(false);
		}
	}, []);

	const onImportClick = React.useCallback(() =>
	{
		fileInputRef.current?.click();
	}, []);

	const onFileSelected = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) =>
	{
		const file = event.target.files?.[0];
		if (!file)
			return;

		event.target.value = "";

		try
		{
			const text = await file.text();
			const data = JSON.parse(text);

			if (!validateImport(data))
			{
				Messager.Error("Invalid settings file format");
				return;
			}

			const result = await confirm({
				title: "Import Settings",
				description: `Import settings exported on ${new Date(data.timestamp).toLocaleString()}? Existing settings will be overwritten and the app will restart.`,
				confirmationText: "Import & Restart",
			});
			if (!result.confirmed)
				return;

			setBusy(true);

			await importSettings(data);

			Messager.Info("Settings imported successfully, restarting...");

			await new Promise((resolve) => setTimeout(resolve, 1000));
			await relaunch();
		}
		catch (err: any)
		{
			Messager.Error("Failed to import settings: ", err.message);
		}
		finally
		{
			setBusy(false);
		}
	}, []);

	return (
		<LunaSettings title="Settings Transfer" desc="Export or import TIDALuna settings">
			<Stack direction="row" spacing={2}>
				<LunaButton disabled={busy} onClick={onExport} startIcon={<FileDownloadIcon />} children="Export Settings" />
				<LunaButton disabled={busy} onClick={onImportClick} startIcon={<FileUploadIcon />} children="Import Settings" />
				<input ref={fileInputRef} type="file" accept=".json" style={{ display: "none" }} onChange={onFileSelected} />
			</Stack>
			<Typography variant="subtitle2" sx={{ mt: 1, opacity: 0.6 }}>
				Exports installed plugins, plugin settings and feature flags. Import restores them and restarts the app.
			</Typography>
		</LunaSettings>
	);
});