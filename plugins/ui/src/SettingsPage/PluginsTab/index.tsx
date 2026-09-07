import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { LunaPlugin, unloadSet } from "@luna/core";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { LunaGroup, LunaRow, LunaSection } from "../../components/LunaList";
import { LunaSearch } from "../../components/LunaSearch";
import { descSx, metaSx, metrics, searchStickyTop, wave } from "../../tidalTokens";
import { LunaPluginSettings } from "./LunaPluginSettings";

const matches = (plugin: LunaPlugin, query: string) => {
	if (query === "") return true;
	const pkg = plugin.store.package;
	return `${pkg?.name ?? ""} ${pkg?.description ?? ""}`.toLowerCase().includes(query);
};

const isActive = (plugin: LunaPlugin) => plugin.enabled && !plugin.loadError._;

const partition = () => {
	const errored: LunaPlugin[] = [];
	const enabled: LunaPlugin[] = [];
	const disabled: LunaPlugin[] = [];
	for (const plugin of Object.values(LunaPlugin.plugins)) {
		if (LunaPlugin.corePlugins.has(plugin.name)) continue;
		if (!plugin.installed) continue;
		if (plugin.loadError._) errored.push(plugin);
		else if (plugin.enabled) enabled.push(plugin);
		else disabled.push(plugin);
	}
	const byName = (a: LunaPlugin, b: LunaPlugin) => a.name.localeCompare(b.name);
	return { errored: errored.sort(byName), enabled: enabled.sort(byName), disabled: disabled.sort(byName) };
};

export const PluginsTab = React.memo(() => {
	const [query, setQuery] = useState("");
	// Single open accordion. One id, not a persisted flag per plugin, so a fresh visit never
	// starts with thirty panels left open from last time.
	const [openId, setOpenId] = useState<string | undefined>(undefined);
	// Re-partition live: enabling a disabled plugin or clearing an error moves the row to Enabled.
	const [, bump] = useReducer((x: number) => x + 1, 0);

	const rowRefs = useRef(new Map<string, HTMLElement>());
	const wasActive = useRef(new Map<string, boolean>());
	const [scrollTo, setScrollTo] = useState<string | undefined>(undefined);
	// The row that just moved, marked until the user scrolls or hovers it
	const [highlight, setHighlight] = useState<string | undefined>(undefined);

	useEffect(() => {
		const plugins = Object.values(LunaPlugin.plugins).filter((p) => p.installed && !LunaPlugin.corePlugins.has(p.name));
		for (const p of plugins) wasActive.current.set(p.store.url, isActive(p));

		const onChange = (plugin: LunaPlugin) => {
			const url = plugin.store.url;
			const nowActive = isActive(plugin);
			// Only scroll on the transition INTO active (enabled + no error), not on every toggle
			if (nowActive && !wasActive.current.get(url)) {
				setScrollTo(url);
				setHighlight(url);
			}
			wasActive.current.set(url, nowActive);
			bump();
		};

		const unloads = new Set(plugins.flatMap((p) => [p.onSetEnabled(() => onChange(p)), p.loadError.onValue(() => onChange(p))]));
		return () => {
			unloadSet(unloads);
		};
	}, []);

	// After the row has moved into its new section, bring it into view there
	useEffect(() => {
		if (scrollTo === undefined) return;
		const el = rowRefs.current.get(scrollTo);
		if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
		setScrollTo(undefined);
	}, [scrollTo]);

	// Clear the marker once the user takes over: a real wheel/touch/key, not the programmatic scroll
	useEffect(() => {
		if (highlight === undefined) return;
		const clear = () => setHighlight(undefined);
		const opts = { passive: true } as const;
		window.addEventListener("wheel", clear, opts);
		window.addEventListener("touchstart", clear, opts);
		window.addEventListener("keydown", clear);
		return () => {
			window.removeEventListener("wheel", clear);
			window.removeEventListener("touchstart", clear);
			window.removeEventListener("keydown", clear);
		};
	}, [highlight]);

	const toggle = useCallback((url: string) => setOpenId((prev) => (prev === url ? undefined : url)), []);
	const setRowRef = useCallback(
		(url: string) => (el: HTMLElement | null) => {
			if (el) rowRefs.current.set(url, el);
			else rowRefs.current.delete(url);
		},
		[],
	);

	const partitions = partition();
	const total = partitions.errored.length + partitions.enabled.length + partitions.disabled.length;
	if (total === 0)
		return (
			<Box sx={{ maxWidth: metrics.maxTextW }}>
				<LunaGroup>
					<LunaRow title="No plugins installed" desc="Open the Plugin Store tab to add one." />
				</LunaGroup>
			</Box>
		);

	const q = query.trim().toLowerCase();
	const shown = [...partitions.errored, ...partitions.enabled, ...partitions.disabled].filter((p) => matches(p, q)).length;

	const section = (title: string, plugins: LunaPlugin[]) => {
		const visible = plugins.filter((plugin) => matches(plugin, q));
		if (visible.length === 0) return null;
		return (
			<LunaSection title={`${title} (${visible.length})`}>
				<LunaGroup>
					{visible.map((plugin) => (
						<LunaPluginSettings
							key={plugin.store.url}
							plugin={plugin}
							open={openId === plugin.store.url}
							onToggle={() => toggle(plugin.store.url)}
							rootRef={setRowRef(plugin.store.url)}
							highlight={highlight === plugin.store.url}
							onSeen={highlight === plugin.store.url ? () => setHighlight(undefined) : undefined}
						/>
					))}
				</LunaGroup>
			</LunaSection>
		);
	};

	return (
		<Stack spacing={3} sx={{ fontFamily: wave.font, maxWidth: metrics.maxTextW }}>
			<Stack direction="row" spacing={1.5} sx={{ alignItems: "center", position: "sticky", top: searchStickyTop, zIndex: 3 }}>
				<Box sx={{ flex: 1 }}>
					<LunaSearch value={query} onChange={setQuery} placeholder="Search installed plugins" />
				</Box>
				<Typography sx={{ ...metaSx, flex: "0 0 auto" }} children={q === "" ? `${total} installed` : `${shown} of ${total}`} />
			</Stack>

			{/* Errors first: a plugin that failed to load is the thing you came here for */}
			{section("Errors", partitions.errored)}
			{section("Enabled", partitions.enabled)}
			{section("Disabled", partitions.disabled)}

			{shown === 0 && <Typography sx={{ ...descSx }} children={`No installed plugin matches "${query}".`} />}
		</Stack>
	);
});
