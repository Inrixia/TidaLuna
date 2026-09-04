import React from "react";
import type { ErrorInfo, ReactNode } from "react";

import { LunaPlugin, unloadSet, type PluginPackage } from "@luna/core";
import { store as obyStore } from "oby";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import { CircleIcon } from "../../components/LunaDrawnIcons";
import { LunaIcon, icons } from "../../components/LunaIcon";
import { LunaSwitch } from "../../components";
import { LunaBadge, LunaExpandableRow, LunaRow, MeasureEmpty } from "../../components/LunaList";
import { buttonSx, descSx, iconBtnSx, metaSx, oneLineSx, wave } from "../../tidalTokens";

class PluginSettingsErrorBoundary extends React.Component<{ name: string; children: ReactNode }, { error?: string }> {
	state: { error?: string } = {};
	static getDerivedStateFromError(error: Error) {
		return { error: error.message || String(error) };
	}
	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(`[Luna] Plugin settings crashed for ${this.props.name}:`, error, info.componentStack);
	}
	render() {
		if (this.state.error === undefined) return this.props.children;
		return (
			<Box sx={{ display: "flex", alignItems: "center", gap: 1.5, paddingY: 1 }}>
				<LunaIcon name={icons.alert} size={16} sx={{ color: wave.danger, flexShrink: 0 }} />
				<Typography title={this.state.error} sx={{ ...descSx, ...oneLineSx, color: wave.danger, flex: 1 }} children={`Settings crashed: ${this.state.error}`} />
				<Button disableRipple sx={buttonSx} onClick={() => this.setState({ error: undefined })} children="Retry" />
			</Box>
		);
	}
}

export interface LunaPluginSettingsProps {
	plugin: LunaPlugin;
	open: boolean;
	onToggle: () => void;
	/** Ref to the row root, so the tab can scroll to a plugin after it moves section. */
	rootRef?: React.Ref<HTMLDivElement>;
	/** Marks the row as just-moved-here until the user finds it. */
	highlight?: boolean;
	onSeen?: () => void;
}

/**
 * One installed plugin as a collapsible row. The chevron indicates state, the whole header
 * toggles, and only the two verbs used constantly stay on the row: the enable switch and expand.
 * Reload, live reload and uninstall moved into the overflow menu, which took the row from five
 * icon buttons down to two controls.
 */
export const LunaPluginSettings = React.memo(({ plugin, open, onToggle, rootRef, highlight, onSeen }: LunaPluginSettingsProps) => {
	const [enabled, setEnabled] = React.useState(plugin.enabled);
	const [loading, setLoading] = React.useState(plugin.loading._);
	const [loadError, setLoadError] = React.useState(plugin.loadError._);
	// Separate from loadError: only true when load() itself threw
	const [loadFailed, setLoadFailed] = React.useState(plugin.loadFailed._);
	const [installed, setInstalled] = React.useState(plugin.installed);
	const [pkg, setPackage] = React.useState<PluginPackage>(obyStore.unwrap(plugin.store.package));
	const [menuAnchor, setMenuAnchor] = React.useState<HTMLElement | null>(null);
	// A Settings export can render nothing but spacers. Detected after render, then the row drops
	// its chevron rather than opening onto an empty panel.
	const [emptyPanel, setEmptyPanel] = React.useState(false);

	React.useEffect(() => {
		const unloads = new Set([
			plugin.onSetEnabled((next) => setEnabled(next)),
			plugin.loading.onValue((next) => setLoading(next)),
			plugin.loadError.onValue((next) => setLoadError(next)),
			plugin.loadFailed.onValue((next) => setLoadFailed(next)),
			obyStore.on(
				() => plugin.store.package,
				() => setPackage(obyStore.unwrap(plugin.store.package)),
			),
			obyStore.on(
				() => plugin.installed,
				() => setInstalled(obyStore.unwrap(plugin.store.installed)),
			),
		]);
		return () => {
			unloadSet(unloads);
		};
	}, [plugin]);

	const handleReload = React.useCallback(plugin.reload.bind(plugin), [plugin]);
	const toggleEnabled = React.useCallback((_: unknown, checked: boolean) => (checked ? plugin.enable() : plugin.disable()), [plugin]);
	const uninstall = React.useCallback(plugin.uninstall.bind(plugin), [plugin]);

	if (!installed) return null;

	const isDev = plugin.store.url.startsWith("http://127.0.0.1");
	const name = pkg.name;
	const isCore = LunaPlugin.corePlugins.has(name);
	const Settings = plugin.exports?.Settings;
	const hasSettings = Settings !== undefined && Settings !== null;
	const link = pkg.homepage ?? pkg.repository?.url;
	const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;

	const closeMenu = () => setMenuAnchor(null);
	const run = (fn: () => unknown) => () => {
		closeMenu();
		fn();
	};

	const lead = loadError ? (
		<LunaIcon name={icons.alert} size={16} sx={{ color: wave.danger }} />
	) : enabled ? (
		<LunaIcon name={icons.check} size={16} sx={{ color: wave.textSecondary }} />
	) : (
		<CircleIcon size={16} sx={{ color: wave.textTertiary }} />
	);

	const meta = (
		<>
			{pkg.version && <Typography component="span" sx={{ ...metaSx, flex: "0 0 auto" }} children={pkg.version} />}
			{isDev && <LunaBadge children="Dev" />}
			{!enabled && !loadError && <LunaBadge children="Disabled" />}
			{loadError && <LunaBadge tone="danger" children={loadFailed ? "Load failed" : "Runtime error"} />}
		</>
	);

	const desc = loadError ? (
		<Typography title={loadError} sx={{ ...metaSx, ...oneLineSx, color: wave.danger }} children={loadError} />
	) : (
		(pkg.description ?? "No description")
	);

	const trailing = (
		<>
			{author && <Typography sx={{ ...metaSx, display: { xs: "none", sm: "block" } }} children={author} />}
			{!isCore && (
				<Tooltip title={enabled ? `Disable ${name}` : `Enable ${name}`}>
					<span onClick={(e) => e.stopPropagation()}>
						<LunaSwitch checked={enabled} loading={loading} onChange={toggleEnabled} />
					</span>
				</Tooltip>
			)}
			<IconButton
				disableRipple
				aria-label={`More actions for ${name}`}
				sx={iconBtnSx}
				onClick={(e) => {
					e.stopPropagation();
					setMenuAnchor(e.currentTarget);
				}}
				children={<LunaIcon name={icons.threeDots} size={18} />}
			/>
			<Menu
				anchorEl={menuAnchor}
				open={menuAnchor !== null}
				onClose={closeMenu}
				slotProps={{ paper: { sx: { backgroundColor: wave.surfaceRaised, border: `1px solid ${wave.line}`, boxShadow: "none" } } }}
			>
				<MenuItem sx={descSx} onClick={run(handleReload)} children="Reload" />
				{isDev && (
					<MenuItem
						sx={descSx}
						onClick={run(() => (plugin.store.liveReload = !plugin.store.liveReload))}
						children={plugin.store.liveReload ? "Live reload: on" : "Live reload: off"}
					/>
				)}
				{link && <MenuItem sx={descSx} onClick={run(() => window.open(link, "_blank"))} children="Open homepage" />}
				<MenuItem sx={descSx} onClick={run(() => navigator.clipboard?.writeText(plugin.store.url))} children="Copy URL" />
				{!isCore && <MenuItem sx={{ ...descSx, color: wave.danger }} onClick={run(uninstall)} children="Uninstall" />}
			</Menu>
		</>
	);

	// No chevron for a plugin with no Settings export, or one whose Settings render nothing.
	if (!hasSettings || emptyPanel)
		return <LunaRow rootRef={rootRef} highlight={highlight} onSeen={onSeen} lead={lead} title={name} meta={meta} desc={desc} trailing={trailing} />;

	return (
		<LunaExpandableRow
			rootRef={rootRef}
			highlight={highlight}
			onSeen={onSeen}
			open={open}
			onToggle={onToggle}
			lead={lead}
			title={name}
			meta={meta}
			desc={desc}
			trailing={trailing}
			panel={
				<PluginSettingsErrorBoundary name={name}>
					<MeasureEmpty onResult={setEmptyPanel} children={<Settings />} />
				</PluginSettingsErrorBoundary>
			}
		/>
	);
});
