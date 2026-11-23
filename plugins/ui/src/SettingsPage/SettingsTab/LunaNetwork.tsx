import React from "react";

import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { LunaButton, LunaSetting, LunaSettings } from "../../components";

import type { CorePluginInfo } from "../../../../../native/core/registry";
import type { NetLogEntry } from "../../../../../native/core/net";

const time = (ms: number) => new Date(ms).toLocaleTimeString();

/** Plugins' network hosts as accepted with their versions, and the requests they made through luna.fetch (native/core/net.ts) */
export const LunaNetwork = React.memo(() => {
	const [plugins, setPlugins] = React.useState<CorePluginInfo[]>([]);
	const [log, setLog] = React.useState<NetLogEntry[]>([]);
	const refresh = React.useCallback(async () => {
		const [list, entries] = await Promise.all([__LunaCore.list(), __LunaCore.networkLog()]);
		setPlugins(list);
		setLog(entries);
	}, []);
	React.useEffect(() => void refresh(), [refresh]);
	const names = new Map(plugins.map((plugin) => [plugin.url, plugin.name]));
	return (
		<LunaSettings
			title="Network"
			desc="The hosts each plugin lists in its package, accepted with its version, and the requests plugins made through luna.fetch. A plugin that lists no hosts runs in compatibility mode: it may reach any public host, and its requests are marked. Requests plugins make with the page's own fetch aren't shown here"
		>
			{[...plugins]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((plugin) => (
					<LunaSetting
						key={plugin.url}
						title={plugin.name}
						desc={
							plugin.hosts === undefined
								? "Lists no hosts: compatibility mode, any public host"
								: plugin.hosts.length === 0
									? "No network"
									: plugin.hosts.join(", ")
						}
					>
						<Typography variant="body2" sx={{ color: plugin.hosts === undefined ? "warning.main" : "text.primary", whiteSpace: "nowrap" }}>
							{plugin.hosts === undefined ? "Not listed" : plugin.enabled ? "Listed" : "Listed (disabled)"}
						</Typography>
					</LunaSetting>
				))}
			<LunaSetting
				title="Requests"
				desc="luna.fetch requests since TIDAL started, the newest first: the last 100 of each plugin, and of callers that name no enabled plugin (origin and path, without the query). Kept until TIDAL restarts"
			>
				<Stack direction="row" spacing={1}>
					<LunaButton onClick={refresh}>Refresh</LunaButton>
				</Stack>
			</LunaSetting>
			{log.length === 0 ? (
				<Typography variant="body2">No requests yet</Typography>
			) : (
				<Stack spacing={0.5}>
					{[...log].reverse().map((entry, index) => (
						<Typography
							key={`${entry.time}-${index}`}
							variant="body2"
							sx={{
								fontFamily: "monospace",
								color: !entry.allowed ? "error.main" : entry.compat ? "warning.main" : "text.primary",
								wordBreak: "break-all",
							}}
						>
							{time(entry.time)} {names.get(entry.plugin) ?? entry.plugin} ({entry.via}) {entry.method} {entry.target}{" "}
							{!entry.allowed ? `refused: ${entry.error ?? ""}` : (entry.status ?? entry.error ?? "…")}
							{entry.allowed && entry.compat ? " [compatibility mode]" : ""}
						</Typography>
					))}
				</Stack>
			)}
		</LunaSettings>
	);
});
