import React from "react";

import Box from "@mui/material/Box";
import InputBase from "@mui/material/InputBase";

import { LunaIcon, icons } from "./LunaIcon";
import { glassSx, wave } from "../tidalTokens";

export interface LunaSearchProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
}

/**
 * A search field shaped like Tidal's own: a full pill with a leading magnifier. Given glassmorphism
 * so, when it sticks, the content scrolling behind it blurs through rather than being hidden by a
 * flat bar. Sticky top is 14px, which places it at the same height as Tidal's real search field and
 * the back/forward buttons (both at y=44 in a scroll container that starts at y=30).
 */
export const LunaSearch = React.memo(({ value, onChange, placeholder = "Search" }: LunaSearchProps) => (
	<Box
		sx={{
			position: "relative",
			zIndex: 3,
			display: "flex",
			alignItems: "center",
			// Copied from Tidal's own search field so the two read as one control: same height,
			// same radius, same translucent fill over the same blur, and no border. The border was
			// what made this look like a box sitting on top of the page.
			// Tidal's own search: 36 tall, and its placeholder starts 44px in. 16 + 16 + 12 lands on
			// the same 44, so the two fields read as one control at two sizes.
			height: 36,
			paddingX: 2,
			gap: 1.5,
			borderRadius: wave.radiusFull,
			color: wave.text,
			...glassSx,
			border: "none",
			transition: "box-shadow .15s ease",
			"&:focus-within": { boxShadow: `0 0 0 1px ${wave.accent}` },
		}}
	>
		<LunaIcon name={icons.search} size={16} sx={{ color: wave.textTertiary }} />
		<InputBase
			fullWidth
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			sx={{
				fontFamily: wave.font,
				fontSize: 14,
				color: wave.text,
				"& input::placeholder": { color: wave.textTertiary, opacity: 1 },
			}}
		/>
		{value !== "" && (
			<Box
				onClick={() => onChange("")}
				sx={{ color: wave.textTertiary, cursor: "pointer", display: "flex", "&:hover": { color: wave.text } }}
				children={<LunaIcon name={icons.close} size={18} />}
			/>
		)}
	</Box>
));
