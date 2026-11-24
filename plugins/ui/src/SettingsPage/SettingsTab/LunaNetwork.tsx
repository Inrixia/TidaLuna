import React from "react";

import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { cspReports } from "@luna/core";

import { LunaButton, LunaSetting, LunaSettings, LunaSwitchSetting } from "../../components";

import type { CorePluginInfo, NetMode } from "../../../../../native/core/registry";
import type { NetLogEntry } from "../../../../../native/core/net";

const time = (ms: number) => new Date(ms).toLocaleTimeString();

const modeText: Record<NetMode, string> = {
	declared: "Its own list",
	derived: "From luna-registry",
	legacy: "Reviewed, compatibility",
	unlisted: "No list: asks",
};
const modeDesc = (plugin: CorePluginInfo) => {
	const hosts = (plugin.hosts ?? []).join(", ");
	switch (plugin.netMode) {
		case "declared":
			return hosts === "" ? "Lists no network" : `Lists: ${hosts}`;
		case "derived":
			return hosts === "" ? "luna-registry found no network in its code" : `luna-registry found in its code: ${hosts}`;
		case "legacy":
			return "Reviewed by hand before hosts were checked: may reach any public host until it updates";
		default:
			return "Lists no hosts, and luna-registry has none for this version: every host is asked when the plugin first uses it";
	}
};

/**
 * Plugins' network: the hosts accepted with their versions, the user's answers to runtime prompts, what the page's CSP
 * blocked and the requests plugins made through luna.fetch (native/core/net.ts)
 */
export const LunaNetwork = React.memo(() => {
	const [plugins, setPlugins] = React.useState<CorePluginInfo[]>([]);
	const [log, setLog] = React.useState<NetLogEntry[]>([]);
	const [strictMedia, setStrictMedia] = React.useState(false);
	const [blocked, setBlocked] = React.useState([...cspReports.values()].filter((report) => report.enforced));
	const refresh = React.useCallback(async () => {
		const [list, entries, settings] = await Promise.all([__LunaCore.list(), __LunaCore.networkLog(), __LunaCore.netSettings()]);
		setPlugins(list);
		setLog(entries);
		setStrictMedia(settings.strictMedia);
		setBlocked([...cspReports.values()].filter((report) => report.enforced));
	}, []);
	React.useEffect(() => void refresh(), [refresh]);
	const names = new Map(plugins.map((plugin) => [plugin.url, plugin.name]));
	const forget = async (url: string, entry: string) => {
		await __LunaCore.forgetGrant(url, entry);
		await refresh();
	};
	const toggleMedia = async () => {
		await __LunaCore.setStrictMedia(!strictMedia).catch(() => false);
		await refresh();
	};
	return (
		<LunaSettings
			title="Network"
			desc="Plugins reach only the hosts accepted for them: the ones they list, or the ones luna-registry found in their code. Any other host is asked about when the plugin uses it (only now, always, deny). TIDAL's own hosts are always allowed"
		>
			<LunaSwitchSetting
				title="Strict images and media"
				desc="Images, audio and video load only from TIDAL and the plugins' accepted hosts, not from any https host. Applies from the next reload (Ctrl+R)"
				checked={strictMedia}
				onClick={toggleMedia}
			/>
			{[...plugins]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((plugin) => (
					<LunaSetting key={plugin.url} title={plugin.name} desc={modeDesc(plugin)}>
						<Stack spacing={0.5} sx={{ alignItems: "flex-end" }}>
							<Typography
								variant="body2"
								sx={{ color: plugin.netMode === "unlisted" || plugin.netMode === "legacy" ? "warning.main" : "text.primary", whiteSpace: "nowrap" }}
							>
								{plugin.netMode !== undefined ? modeText[plugin.netMode] : "-"}
								{plugin.enabled ? "" : " (disabled)"}
							</Typography>
							{Object.entries(plugin.grants ?? {}).map(([entry, grant]) => (
								<Stack key={entry} direction="row" spacing={1} sx={{ alignItems: "center" }}>
									<Typography variant="body2" sx={{ fontFamily: "monospace", color: grant === "deny" ? "error.main" : "success.main" }}>
										{grant === "deny" ? "denied" : "allowed"} {entry}
									</Typography>
									<LunaButton onClick={() => forget(plugin.url, entry)}>Forget</LunaButton>
								</Stack>
							))}
						</Stack>
					</LunaSetting>
				))}
			<LunaSetting
				title="Blocked in the page"
				desc="What the page's network policy blocked since it loaded: page code (TIDAL or a plugin) reaching a host none of the above allows. A TIDAL host here is a Luna bug, please report it"
			>
				<LunaButton onClick={refresh}>Refresh</LunaButton>
			</LunaSetting>
			{blocked.length === 0 ? (
				<Typography variant="body2">Nothing blocked</Typography>
			) : (
				<Stack spacing={0.5}>
					{blocked.map((report) => (
						<Typography
							key={`${report.directive} ${report.blocked} ${report.sourceFile}`}
							variant="body2"
							sx={{ fontFamily: "monospace", color: "error.main", wordBreak: "break-all" }}
						>
							{report.directive} {report.blocked} (from {report.sourceFile}) ×{report.count}
						</Typography>
					))}
				</Stack>
			)}
			<LunaSetting
				title="Requests"
				desc="luna.fetch requests since TIDAL started, the newest first: the last 100 of each plugin, and of callers that name no enabled plugin (origin and path, without the query). Kept until TIDAL restarts"
			>
				<LunaButton onClick={refresh}>Refresh</LunaButton>
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
								color: !entry.allowed ? "error.main" : entry.compat || entry.asked !== undefined ? "warning.main" : "text.primary",
								wordBreak: "break-all",
							}}
						>
							{time(entry.time)} {names.get(entry.plugin) ?? entry.plugin} ({entry.via}) {entry.method} {entry.target}{" "}
							{!entry.allowed ? `refused: ${entry.error ?? ""}` : (entry.status ?? entry.error ?? "…")}
							{entry.allowed && entry.compat ? " [reviewed, compatibility]" : ""}
							{entry.asked !== undefined ? ` [asked: ${entry.asked}]` : ""}
						</Typography>
					))}
				</Stack>
			)}
		</LunaSettings>
	);
});
