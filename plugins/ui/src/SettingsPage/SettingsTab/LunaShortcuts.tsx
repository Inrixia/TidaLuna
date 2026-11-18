import { Shortcut } from "@luna/lib";
import React from "react";

import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";

import { LunaSetting, LunaSettings } from "../../components";

// Not memoized, so conflicts update when another shortcut changes
const ShortcutSetting = ({ shortcut }: { shortcut: Shortcut }) => {
	const [recording, setRecording] = React.useState(false);
	const conflicts = shortcut.conflicts.map((other) => `"${other.label}"`);
	return (
		<LunaSetting
			title={shortcut.label}
			desc={conflicts.length > 0 ? `Also used by ${conflicts.join(", ")}, the one registered first wins` : undefined}
			spacing={2}
		>
			<Stack direction="row" alignItems="center" spacing={1} sx={{ flexGrow: 1 }}>
				<TextField
					size="small"
					fullWidth
					value={recording ? "Press the new keys, Esc to cancel" : shortcut.keys.join(" / ")}
					error={conflicts.length > 0}
					slotProps={{ htmlInput: { readOnly: true } }}
					onFocus={() => setRecording(true)}
					onBlur={() => setRecording(false)}
					onKeyDown={(event) => {
						event.preventDefault();
						event.stopPropagation();
						if (event.key === "Escape") return (event.target as HTMLElement).blur();
						const keys = Shortcut.fromEvent(event.nativeEvent);
						if (keys === undefined) return;
						shortcut.setKeys([keys]);
						(event.target as HTMLElement).blur();
					}}
				/>
				<Button disabled={!shortcut.isRebound} onClick={() => shortcut.setKeys()} sx={{ flexShrink: 0 }}>
					Reset
				</Button>
			</Stack>
		</LunaSetting>
	);
};

export const LunaShortcuts = React.memo(() => {
	const [, setVersion] = React.useState(Shortcut.version._);
	React.useEffect(() => Shortcut.version.onValue(setVersion), []);
	const shortcuts = [...Shortcut.shortcuts.values()];
	if (shortcuts.length === 0) return null;
	return (
		<LunaSettings
			title="Keyboard shortcuts"
			desc="Click a shortcut and press the keys to rebind it. Shortcuts don't fire while typing in a text field"
		>
			{shortcuts.map((shortcut) => (
				<ShortcutSetting key={shortcut.id} shortcut={shortcut} />
			))}
		</LunaSettings>
	);
});
