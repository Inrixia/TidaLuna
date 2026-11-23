import { ipcRenderer } from "@luna/lib";
import React from "react";

import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { LunaSetting, LunaSettings, LunaTrashButton } from "../../components";

import type { NativePermissionEntry } from "../../../../../native/NativeModule/trust";

const answerText = {
	allow: "Allowed for this version",
	allowUpdates: "Allowed for all versions",
	deny: "Denied",
} as const;

const answerColor = {
	allow: "text.primary",
	allowUpdates: "warning.main",
	deny: "error.main",
} as const;

export const LunaNativePermissions = React.memo(() => {
	const [entries, setEntries] = React.useState<NativePermissionEntry[]>([]);
	const refresh = React.useCallback(async () => setEntries(await ipcRenderer.invoke("__Luna.nativePermissions.list")), []);
	React.useEffect(() => void refresh(), [refresh]);

	const revoke = React.useCallback(
		async (key: string) => {
			await ipcRenderer.invoke("__Luna.nativePermissions.revoke", key);
			await refresh();
		},
		[refresh],
	);

	if (entries.length === 0) return null;
	return (
		<LunaSettings
			title="Native permissions"
			desc="Whether plugins' native code may run in TIDAL's main process, as you answered when it asked. Revoke an answer to be asked again the next time the plugin loads"
		>
			{[...entries]
				.sort((a, b) => a.fileName.localeCompare(b.fileName))
				.map(({ key, fileName, url, claimedUrl, answer, modules }) => (
					<LunaSetting
						key={key}
						title={fileName}
						desc={
							<>
								{url ?? `${claimedUrl ?? "Unknown source"} (not checked: the answer holds for this version only)`}
								{modules.length > 0 && (
									<>
										<br />
										Its code named: {modules.join(", ")} (for information, not a limit)
									</>
								)}
							</>
						}
					>
						<Stack direction="row" spacing={1} sx={{ flexGrow: 1, alignItems: "center", justifyContent: "flex-end" }}>
							<Typography variant="body2" sx={{ color: answerColor[answer], whiteSpace: "nowrap" }}>
								{answerText[answer]}
							</Typography>
							<LunaTrashButton title="Revoke" onClick={() => revoke(key)} />
						</Stack>
					</LunaSetting>
				))}
		</LunaSettings>
	);
});
