import { ThemeProvider } from "@mui/material/styles";
import { ConfirmProvider, useConfirm, type ConfirmOptions, type ConfirmResult } from "material-ui-confirm";

import React, { useEffect } from "react";

import { Page } from "../classes/Page";
import { lunaMuiTheme } from "../lunaTheme";

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
	<ThemeProvider theme={lunaMuiTheme}>
		<ConfirmProvider>
			<ExfilConfirm />
		</ConfirmProvider>
	</ThemeProvider>,
).render();

export const confirm = (options: ConfirmOptions) => confirmImpl(options);
