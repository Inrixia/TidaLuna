import { ConfirmProvider, useConfirm, type ConfirmOptions, type ConfirmResult } from "material-ui-confirm";

import React, { useEffect } from "react";

import { Page } from "../classes/Page";
import { LunaMuiThemeProvider } from "../lunaTheme";

import { unloads } from "../index.safe";

// I hate this but it works and gives use a nice usable confirm anywhere so
let confirmImpl: (options: ConfirmOptions) => Promise<ConfirmResult>;
let markReady: () => void;
/** Resolves once the provider behind `confirm` has mounted, so a prompt asked for at load waits instead of racing it */
export const whenConfirmReady = new Promise<void>((resolve) => (markReady = resolve));
const ExfilConfirm = () => {
	const confirm = useConfirm();
	useEffect(() => {
		confirmImpl = confirm;
		markReady();
	}, []);
	return null;
};

Page.register(
	"@luna/ui-confirm",
	unloads,
	<LunaMuiThemeProvider>
		<ConfirmProvider>
			<ExfilConfirm />
		</ConfirmProvider>
	</LunaMuiThemeProvider>,
).render();

export const confirm = (options: ConfirmOptions) => confirmImpl(options);
