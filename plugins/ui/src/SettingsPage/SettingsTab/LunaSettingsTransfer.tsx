import React from "react";
import { useConfirm } from "material-ui-confirm";

import Stack from "@mui/material/Stack";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import FileUploadIcon from "@mui/icons-material/FileUpload";

import { Messager, SettingsTransfer, type ExportData } from "@luna/core";
import { downloadObject, redux, Tidal } from "@luna/lib";
import { relaunch } from "plugins/lib.native/src/index.native";

import { LunaButton, LunaSettings, LunaSwitchSetting } from "../../components";

export const LunaSettingsTransfer = React.memo(() =>
{
	const confirm = useConfirm();
	const fileInputRef = React.useRef<HTMLInputElement>(null);
	const [busy, setBusy] = React.useState(false);
	const [stripCode, setStripCode] = React.useState(true);

	const onExport = React.useCallback(async () =>
	{
		setBusy(true);
		try
		{
			//feature flags
			const tidalFlags = Tidal.featureFlags;
			const featureFlags: Record<string, boolean> = {};
			for (const [name, flag] of Object.entries(tidalFlags))
				featureFlags[name] = flag.value;

			const data = await SettingsTransfer.dump(stripCode, Object.keys(featureFlags).length > 0 ? featureFlags : null);

			const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			downloadObject(JSON.stringify(data), `tidaluna-settings-${dateStr}.json`, "application/json");
		}
		catch (err: any)
		{
			Messager.Error("Failed to export settings: ", err.message);
		}
		finally
		{
			setBusy(false);
		}
	}, [stripCode]);

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
			const data: ExportData = JSON.parse(text);

			if (!SettingsTransfer.validate(data))
			{
				Messager.Error("Invalid settings file format");
				return;
			}

			const result = await confirm({
				title: "Import Settings",
				description: `Import settings exported on ${new Date(data.timestamp).toLocaleString()}? Existing settings will be cleared and replaced, then the app will restart.`,
				confirmationText: "Import & Restart",
			});
			if (!result.confirmed)
				return;

			setBusy(true);

			//stores
			await SettingsTransfer.restore(data);

			//feature flags
			if (data.featureFlags != null)
			{
				const currentFlags = Tidal.featureFlags;
				for (const [name, value] of Object.entries(data.featureFlags))
					if (name in currentFlags && currentFlags[name].value !== value)
						redux.actions["featureFlags/TOGGLE_USER_OVERRIDE"]({ ...currentFlags[name], value });
			}

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
		<LunaSettings title="Settings Transfer" desc="Exports installed plugins, plugin settings, themes, store URLs and feature flag overrides. Import clears existing settings, restores them and restarts the app.">
			<Stack direction="row" spacing={2}>
				<LunaButton disabled={busy} onClick={onExport} startIcon={<FileDownloadIcon />} children="Export Settings" />
				<LunaButton disabled={busy} onClick={onImportClick} startIcon={<FileUploadIcon />} children="Import Settings" />
				<input ref={fileInputRef} type="file" accept=".json" style={{ display: "none" }} onChange={onFileSelected} />
			</Stack>
			<LunaSwitchSetting
				title="Include plugin source code"
				desc="Including plugin source code will increase the size of the exported file. This is only useful for exporting dev or unreleased plugins."
				checked={!stripCode}
				onClick={() => setStripCode(!stripCode)}
			/>
		</LunaSettings>
	);
});