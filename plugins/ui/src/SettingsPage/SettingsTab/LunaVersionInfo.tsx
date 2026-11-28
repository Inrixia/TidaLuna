import React, { useState } from "react";
import appIconBase64 from "file://../../../../../assets/brand/app-icon.svg?base64";
import { LunaSettings } from "../../components";
import { LunaClientUpdate, version } from "./LunaClientUpdate";

const appIconUrl = `data:image/svg+xml;base64,${appIconBase64}`;

export const LunaVersionInfo = React.memo(() => {
	const [_version, setVersion] = useState<string | undefined>(version);

	return (
		<div style={{ display: "flex", flexDirection: "column" }}>
			<LunaSettings>
				<div style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 8 }}>
					<img src={appIconUrl} alt="TidaLuna Icon" style={{ width: 72, height: 72, borderRadius: 16, boxShadow: "0 2px 12px #0002" }} />
					<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
						<h2>Thanks for using TidaLuna!</h2>
						<div style={{ fontSize: 18, margin: 0 }}>
							<strong>Version:</strong> <span style={{ color: "#31d8ff" }}>{version || "Unknown"}</span>
						</div>
					</div>
				</div>
				<LunaClientUpdate />
				<div style={{ padding: 2 }}></div>
			</LunaSettings>
		</div>
	);
});
