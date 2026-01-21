import { redux, Tidal } from "@luna/lib";
import React from "react";
import { LunaSettings, LunaSwitchSetting, SpinningButton } from "../../components";

import Grid from "@mui/material/Grid";

import SettingsIcon from "@mui/icons-material/Settings";
import { grey } from "@mui/material/colors";

export const LunaFeatureFlags = React.memo(() => {
	const [featureFlags, setFeatureFlags] = React.useState(Tidal.featureFlags);
	const [hide, setHidden] = React.useState(false);

	const setFlag = React.useCallback((flag: redux.FeatureFlag) => {
		redux.actions["featureFlags/TOGGLE_USER_OVERRIDE"]({ ...flag, value: !flag.value });
		setFeatureFlags(Tidal.featureFlags);
	}, []);
	return (
		<LunaSettings
			title="Feature flags"
			desc="Feature flags & experiments currently in the Tidal desktop app. These are internal from Tidal and not Luna features"
			titleChildren={
				<SpinningButton title={hide ? "Show flags" : "Hide flags"} onClick={() => setHidden(!hide)} icon={SettingsIcon} sxColor={grey.A400} />
			}
			display={hide ? "none" : "flex"}
		>
			{!hide && (
				<Grid spacing={2} container>
					{Object.values(featureFlags)
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((flag) => (
							<Grid
								key={flag.name}
								size={6}
								sx={{ borderRadius: 4, backgroundColor: "rgba(0, 0, 0, 0.20)", boxShadow: 2, paddingLeft: 1.5 }}
								children={
									<LunaSwitchSetting
										disabled={flag.type !== "BOOLEAN"}
										title={flag.name[0].toUpperCase() + flag.name.slice(1).replaceAll("-", " ")}
										onClick={setFlag.bind(null, flag)}
										checked={flag.value}
									/>
								}
							/>
						))}
				</Grid>
			)}
		</LunaSettings>
	);
});
