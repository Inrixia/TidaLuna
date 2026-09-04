import React from "react";
import { useConfirm } from "material-ui-confirm";

import Stack from "@mui/material/Stack";

import { Messager, SettingsTransfer, type ExportData } from "@luna/core";
import { downloadObject, redux, Tidal } from "@luna/lib";
import { relaunch } from "plugins/lib.native/src/index.native";

import Button from "@mui/material/Button";

import { LunaIcon, flipVertical, icons } from "../../components/LunaIcon";
import { LunaSwitch } from "../../components";
import { LunaGroup, LunaRow, LunaSection } from "../../components/LunaList";
import { buttonSx } from "../../tidalTokens";

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
			const featureFlags = redux.store.getState().featureFlags.userOverrides as Record<string, boolean>;;

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
				{
					if (name in currentFlags && currentFlags[name].value !== value)
						redux.actions["featureFlags/TOGGLE_USER_OVERRIDE"]({ ...currentFlags[name], value });
				}
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
		<LunaSection title="Settings transfer" desc="Plugins, their settings, themes, store urls and feature flag overrides.">
			<LunaGroup>
				<LunaRow
					title="Export to a file"
					desc="Writes everything above into a single json file."
					trailing={
						<Button disableRipple disabled={busy} onClick={onExport} startIcon={<LunaIcon name={icons.upload} size={15} sx={flipVertical} />} sx={buttonSx} children="Export" />
					}
				/>
				<LunaRow
					title="Import from a file"
					desc="Clears the current settings, restores the file, then restarts the app."
					trailing={
						<>
							<Button disableRipple disabled={busy} onClick={onImportClick} startIcon={<LunaIcon name={icons.upload} size={15} />} sx={buttonSx} children="Import" />
							<input ref={fileInputRef} type="file" accept=".json" style={{ display: "none" }} onChange={onFileSelected} />
						</>
					}
				/>
				<LunaRow
					title="Include plugin source code"
					desc="Makes the export larger. Only useful for dev or unreleased plugins."
					trailing={<LunaSwitch checked={!stripCode} onClick={() => setStripCode(!stripCode)} />}
				/>
			</LunaGroup>
		</LunaSection>
	);
});