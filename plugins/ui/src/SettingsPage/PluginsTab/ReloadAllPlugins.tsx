import React from "react";

import { LunaPlugin, Tracer } from "@luna/core";

import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import CachedIcon from "@mui/icons-material/Cached";

const { trace } = Tracer("[@luna/ui]", null);

/** Installed and enabled plugins that are not core plugins */
const reloadablePlugins = () =>
	Object.values(LunaPlugin.plugins).filter((plugin) => plugin.installed && plugin.enabled && !LunaPlugin.corePlugins.has(plugin.name));

/**
 * Reload every enabled plugin, one at a time.
 * A plugin that depends on another plugin in the list is skipped, reloading that plugin reloads its dependants.
 * Returns the names of plugins that failed to reload.
 */
export const reloadAllPlugins = async (): Promise<string[]> => {
	const plugins = reloadablePlugins();
	const failed: string[] = [];
	for (const plugin of plugins) {
		if (plugins.some((other) => other !== plugin && other.dependants.has(plugin))) continue;
		try {
			await plugin.reload();
		} catch {
			// The plugin already reports its own error and shows it on its card
			failed.push(plugin.name);
		}
	}
	return failed;
};

export const ReloadAllPlugins = React.memo(() => {
	const [reloading, setReloading] = React.useState(false);

	const onClick = React.useCallback(async () => {
		setReloading(true);
		try {
			const failed = await reloadAllPlugins();
			if (failed.length === 0) trace.msg.log("Reloaded all plugins");
			else trace.msg.warn(`Reloaded plugins, ${failed.length} failed: ${failed.join(", ")}`);
		} finally {
			setReloading(false);
		}
	}, []);

	return (
		<Tooltip title="Reload every enabled plugin">
			<span style={{ alignSelf: "flex-end" }}>
				<Button
					size="small"
					color="warning"
					variant="outlined"
					disabled={reloading}
					onClick={onClick}
					startIcon={
						<CachedIcon
							sx={{
								animation: reloading ? "spin 0.5s linear infinite" : "none",
								"@keyframes spin": { "0%": { transform: "rotate(0deg)" }, "100%": { transform: "rotate(360deg)" } },
							}}
						/>
					}
				>
					Reload all
				</Button>
			</span>
		</Tooltip>
	);
});
