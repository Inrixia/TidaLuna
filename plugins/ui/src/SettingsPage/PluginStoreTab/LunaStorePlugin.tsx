import { LunaPlugin } from "@luna/core";

import React, { useEffect, useState } from "react";

import { LunaPluginHeader } from "../PluginsTab/LunaPluginHeader";

import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import { installPluginWithLibraries, uninstallPluginWithDependenciesCheck } from "./pluginInstall";

export const LunaStorePlugin = React.memo(({ url }: { url: string }) => {
	const [plugin, setPlugin] = useState<LunaPlugin | undefined>(undefined);
	const [loadError, setLoadError] = useState<string | undefined>(undefined);
	const [isHovered, setIsHovered] = useState(false);

	useEffect(() => {
		LunaPlugin.fromStorage({ url }).then(setPlugin).catch(setLoadError);
	}, [url]);

	if (!plugin) return null;

	const dependsOn = plugin.dependencyRequirements.map((dependency) => dependency.name);

	const onInstallToggle = async () => {
		if (plugin.installed) await uninstallPluginWithDependenciesCheck(plugin);
		else await installPluginWithLibraries(plugin);
	};

	const version = url.startsWith("http://127.0.0.1") ? `${plugin.package?.version ?? ""} [DEV]` : plugin.package?.version;

	return (
		<ButtonBase
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			sx={{
				position: "relative", // Needed for absolute positioning of children
				borderRadius: 2,
				backgroundColor: `rgba(0, 0, 0, ${!isHovered ? 0.2 : 0.5})`,
				padding: 2,
				paddingBottom: 1,
				paddingTop: 1,
				boxShadow: 5,
				transition: "opacity 0.3s ease-in-out",
				opacity: plugin.installed && !isHovered ? 0.5 : 1, // Keep installed opacity logic
				overflow: "hidden",
				width: "100%",
			}}
			style={{ textAlign: "left" }}
			onClick={onInstallToggle}
		>
			<LunaPluginHeader
				sx={{ transition: "opacity 0.3s ease-in-out", opacity: isHovered ? 0.2 : 1, width: "100%" }}
				name={plugin.name}
				version={version}
				loadError={loadError}
				author={plugin.package?.author}
				desc={plugin.package?.description}
				isLibrary={plugin.isLibrary}
				dependsOn={dependsOn}
			/>
			<Typography
				sx={{
					position: "absolute",
					top: "50%",
					left: "50%",
					transform: "translate(-50%, -50%)",
					opacity: isHovered ? 1 : 0,
					transition: "opacity 0.3s ease-in-out",
					fontWeight: "bold",
					color: plugin.installed ? "red" : "green",
					borderRadius: 2,
					padding: 1,
					pointerEvents: "none",
				}}
				children={plugin.installed ? "Uninstall" : "Install"}
			/>
		</ButtonBase>
	);
});
