import React, { useLayoutEffect, useRef, useState } from "react";

import Box from "@mui/material/Box";
import Container from "@mui/material/Container";

import { Signal } from "@inrixia/helpers";
import { PuzzleIcon, SlidersIcon } from "../components/LunaDrawnIcons";
import { LunaIcon, icons } from "../components/LunaIcon";
import { metrics, wave } from "../tidalTokens";
import { PluginsTab } from "./PluginsTab";
import { PluginStoreTab } from "./PluginStoreTab";
import { SettingsTab } from "./SettingsTab";
import { SupportersTab } from "./SupportersTab";
import { ThemesTab } from "./ThemesTab";

type LunaSettingsTab = "Plugins" | "Plugin Store" | "Themes" | "Settings" | "Supporters";

// From Tidal's sprite where it has one. It carries no puzzle piece and no gear, so those are drawn
const TABS: { value: LunaSettingsTab; icon: React.ReactNode }[] = [
	{ value: "Plugins", icon: <PuzzleIcon size={17} /> },
	{ value: "Plugin Store", icon: <LunaIcon name={icons.marketplace} size={17} /> },
	{ value: "Themes", icon: <LunaIcon name={icons.shine} size={17} /> },
	{ value: "Settings", icon: <SlidersIcon size={17} /> },
	{ value: "Supporters", icon: <LunaIcon name={icons.heart} size={17} /> },
];

/** Tidal's own easing, read off its buttons and its player panel. */
const EASE_PRESS = "cubic-bezier(0.76, 0, 0.24, 1)";
const EASE_SLIDE = "cubic-bezier(0.32, 0.72, 0, 1)";

// Tidal's player bar overlays the bottom of the scroll container and nothing reserves space for
// it, so the last row of every tab used to sit underneath it. Tidal's own views reserve 112px.
const PLAYER_BAR_CLEARANCE = 128;

// Tidal marks a selected chip with a filled pill, never an underline: radius 1000px, 40 tall,
// transparent at rest and rgba(255,255,255,.08) when chosen, weight 500 to 600.
// Rest, hover and selected are three different kinds of cue so none reads as another: bare, a
// hairline outline with no fill, a fill with no outline.
const LunaTabs = React.memo(({ value, onChange }: { value: LunaSettingsTab; onChange: (t: LunaSettingsTab) => void }) => {
	const refs = useRef<Partial<Record<LunaSettingsTab, HTMLButtonElement | null>>>({});
	const [indicator, setIndicator] = useState({ left: 0, width: 0, ready: false });

	useLayoutEffect(() => {
		const el = refs.current[value];
		if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth, ready: true });
	}, [value]);

	// The pill has to follow the tabs when the window resizes, otherwise it is left behind mid row
	useLayoutEffect(() => {
		const el = refs.current[value];
		if (el === null || el === undefined) return;
		const ro = new ResizeObserver(() => {
			const current = refs.current[value];
			if (current) setIndicator({ left: current.offsetLeft, width: current.offsetWidth, ready: true });
		});
		ro.observe(el.parentElement ?? el);
		return () => ro.disconnect();
	}, [value]);

	const onKeyDown = (event: React.KeyboardEvent) => {
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "Home" ? -99 : event.key === "End" ? 99 : 0;
		if (step === 0) return;
		event.preventDefault();
		const at = TABS.findIndex((t) => t.value === value);
		const next = Math.min(TABS.length - 1, Math.max(0, step === -99 ? 0 : step === 99 ? TABS.length - 1 : at + step));
		onChange(TABS[next].value);
		refs.current[TABS[next].value]?.focus();
	};

	return (
		<Box
			role="tablist"
			aria-label="Luna settings"
			onKeyDown={onKeyDown}
			sx={{
				position: "relative",
				display: "flex",
				// Spread across the content column, not the window, or the strip ends up wider than the page
				justifyContent: "space-between",
				alignItems: "center",
				maxWidth: metrics.maxTextW,
				borderBottom: `1px solid ${wave.line}`,
				paddingBottom: 1,
			}}
		>
			{/* One pill, moved, rather than a fill per tab that cross fades. Moving it is what makes
			    the change of tab legible as a change rather than as two separate blinks. */}
			<Box
				sx={{
					position: "absolute",
					top: 0,
					height: 36,
					left: `${indicator.left}px`,
					width: `${indicator.width}px`,
					borderRadius: wave.radiusFull,
					backgroundColor: "rgba(255, 255, 255, 0.08)",
					opacity: indicator.ready ? 1 : 0,
					transition: `left 280ms ${EASE_SLIDE}, width 280ms ${EASE_SLIDE}, opacity 160ms linear`,
					"@media (prefers-reduced-motion: reduce)": { transition: "opacity 160ms linear" },
				}}
			/>
			{TABS.map(({ value: tab, icon }) => {
				const active = tab === value;
				return (
					<Box
							key={tab}
							component="button"
							type="button"
							role="tab"
							aria-selected={active}
							tabIndex={active ? 0 : -1}
							ref={(el: HTMLButtonElement | null) => {
								refs.current[tab] = el;
							}}
							onClick={() => onChange(tab)}
							sx={{
								all: "unset",
								position: "relative",
								boxSizing: "border-box",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								gap: 1,
								height: 36,
								paddingX: 2,
								maxWidth: "100%",
								cursor: "pointer",
								whiteSpace: "nowrap",
								borderRadius: wave.radiusFull,
								border: "1px solid transparent",
								fontFamily: wave.font,
								fontSize: 13,
								fontWeight: active ? 600 : 500,
								color: active ? wave.text : wave.textSecondary,
								transition: `color 200ms ease, border-color 200ms ease, transform 90ms ${EASE_PRESS}`,
								// Hover is an outline, never a fill: a fill is what selected means
								"&:hover": { color: wave.text, borderColor: active ? "transparent" : wave.lineStrong },
								// The press is on the label, not the pill, so the pill keeps sliding cleanly
								"&:active": { transform: "scale(0.96)" },
								"&:focus-visible": { outline: `2px solid ${wave.accent}`, outlineOffset: 2 },
								"@media (prefers-reduced-motion: reduce)": { transition: "color 200ms ease, border-color 200ms ease" },
							}}
						>
							{icon}
							<Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }} children={tab} />
					</Box>
				);
			})}
		</Box>
	);
});

const TabContent = React.memo(({ tab }: { tab: LunaSettingsTab }) => {
	switch (tab) {
		case "Plugins":
			return <PluginsTab />;
		case "Plugin Store":
			return <PluginStoreTab />;
		case "Themes":
			return <ThemesTab />;
		case "Settings":
			return <SettingsTab />;
		case "Supporters":
			return <SupportersTab />;
	}
});

export const currentSettingsTab = new Signal<LunaSettingsTab>("Plugins");
export const LunaPage = React.memo(() => {
	const [currentTab, setCurrentTab] = React.useState(currentSettingsTab._);
	React.useEffect(() => {
		const unload = currentSettingsTab.onValue((tab) => setCurrentTab(tab));
		return () => {
			unload();
		};
	}, []);

	return (
		<Container maxWidth="lg" sx={{ padding: 0, flexGrow: 1 }}>
			<LunaTabs value={currentTab} onChange={(tab) => (currentSettingsTab._ = tab)} />
			<Box
				// key forces a remount per tab so the content animates in; also drops stale state
				key={currentTab}
				sx={{
					marginTop: 3,
					paddingBottom: `${PLAYER_BAR_CLEARANCE}px`,
					maxWidth: metrics.maxTextW,
					animation: "lunaTabIn 220ms cubic-bezier(0.2, 0, 0, 1)",
					"@keyframes lunaTabIn": {
						from: { opacity: 0, transform: "translateY(6px)" },
						to: { opacity: 1, transform: "none" },
					},
					"@media (prefers-reduced-motion: reduce)": { animation: "none" },
				}}
			>
				<TabContent tab={currentTab} />
			</Box>
		</Container>
	);
});

