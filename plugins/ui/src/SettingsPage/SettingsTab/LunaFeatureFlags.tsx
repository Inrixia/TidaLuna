import { redux, Tidal } from "@luna/lib";
import React from "react";

import Button from "@mui/material/Button";

import { LunaSwitch } from "../../components";
import { LunaGroup, LunaRow, LunaSection } from "../../components/LunaList";
import { buttonSx } from "../../tidalTokens";

export const LunaFeatureFlags = React.memo(() => {
	const [featureFlags, setFeatureFlags] = React.useState(Tidal.featureFlags);
	const [hidden, setHidden] = React.useState(true);

	const setFlag = React.useCallback((flag: redux.FeatureFlag) => {
		redux.actions["featureFlags/TOGGLE_USER_OVERRIDE"]({ ...flag, value: !flag.value });
		setFeatureFlags(Tidal.featureFlags);
	}, []);

	const flags = Object.values(featureFlags).sort((a, b) => a.name.localeCompare(b.name));

	return (
		<LunaSection
			title="Feature flags"
			desc="Tidal desktop experiments. Internal to Tidal, not Luna features."
			trailing={<Button disableRipple sx={buttonSx} onClick={() => setHidden((h) => !h)} children={hidden ? `Show (${flags.length})` : "Hide"} />}
		>
			{!hidden && (
				<LunaGroup>
					{flags.map((flag) => (
						<LunaRow
							key={flag.name}
							compact
							title={flag.name[0].toUpperCase() + flag.name.slice(1).replaceAll("-", " ")}
							trailing={<LunaSwitch disabled={flag.type !== "BOOLEAN"} checked={flag.value} onClick={() => setFlag(flag)} />}
						/>
					))}
				</LunaGroup>
			)}
		</LunaSection>
	);
});
