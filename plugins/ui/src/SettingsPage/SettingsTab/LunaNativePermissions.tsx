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
		async (key: string, category?: string) => {
			await ipcRenderer.invoke("__Luna.nativePermissions.revoke", key, category);
			await refresh();
		},
		[refresh],
	);

	if (entries.length === 0) return null;
	return (
		<LunaSettings
			title="Native permissions"
			desc="What plugins' native code may do, as you answered when it asked. Revoke an answer to be asked again the next time the plugin uses it (or loads, for running in the main process)"
		>
			{[...entries]
				.sort((a, b) => a.fileName.localeCompare(b.fileName))
				.map(({ key, fileName, url, claimedUrl, categories }) => (
					<Stack key={key} spacing={0.5}>
						<LunaSetting title={fileName} desc={url ?? `${claimedUrl ?? "Unknown source"} (not checked: answers hold for this version only)`}>
							<Stack direction="row" sx={{ flexGrow: 1, justifyContent: "flex-end" }}>
								<LunaTrashButton title="Revoke all answers of this file" onClick={() => revoke(key)} />
							</Stack>
						</LunaSetting>
						{[...categories]
							.sort((a, b) => a.label.localeCompare(b.label))
							.map(({ category, label, answer, modules, onlyModules }) => (
								<LunaSetting
									key={category}
									sx={{ paddingLeft: 3 }}
									title={label}
									desc={onlyModules ? `Only ${modules.join(", ")} (answered before permissions had categories)` : modules.join(", ")}
								>
									<Stack direction="row" spacing={1} sx={{ flexGrow: 1, alignItems: "center", justifyContent: "flex-end" }}>
										<Typography variant="body2" sx={{ color: answerColor[answer] }}>
											{answerText[answer]}
										</Typography>
										<LunaTrashButton title="Revoke" onClick={() => revoke(key, category)} />
									</Stack>
								</LunaSetting>
							))}
					</Stack>
				))}
		</LunaSettings>
	);
});
