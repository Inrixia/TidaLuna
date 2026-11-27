import { ConfirmProvider, useConfirm, type ConfirmOptions, type ConfirmResult } from "material-ui-confirm";

import React, { useEffect } from "react";

import { Page } from "../classes/Page";
import { LunaMuiThemeProvider } from "../lunaTheme";

import { unloads } from "../index.safe";

// I hate this but it works and gives use a nice usable confirm anywhere so
let confirmImpl: (options: ConfirmOptions) => Promise<ConfirmResult>;
const ExfilConfirm = () => {
	const confirm = useConfirm();
	useEffect(() => {
		confirmImpl = confirm;
	}, []);
	return null;
};

Page.register(
	"@luna/ui-confirm",
	unloads,
	<LunaMuiThemeProvider>
		{/* The confirm page is appended beside the settings page, so without its own stacking context the settings panel
		    painted over the dialog and its text ran through it. `dialogProps` is a per-call option, so it goes on the
		    wrapper that every confirm call goes through. */}
		<ConfirmProvider>
			<ExfilConfirm />
		</ConfirmProvider>
	</LunaMuiThemeProvider>,
).render();

export const confirm = (options: ConfirmOptions) =>
	confirmImpl({
		// Every confirm sits above Luna's own pages: the settings panel is a sibling and painted over the dialog
		dialogProps: { sx: { zIndex: 100000 }, ...options.dialogProps },
		...options,
	});
