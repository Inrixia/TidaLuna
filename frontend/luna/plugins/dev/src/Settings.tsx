import { LunaButtonSetting, LunaSetting, LunaSettings, LunaSwitch, LunaSwitchSetting } from "@luna/ui";
import { storage, trace } from ".";
import { startNativeDebugging } from "./debug.native";
import { startReduxLog, stopReduxLog } from "./interceptActions";
import { startNativeIPCLog, stopNativeIPCLog } from "./ipc";
import { startRenderIpcLog, stopRenderIpcLog } from "./ipc.native";

import TextField from "@mui/material/TextField";

import { grey } from "@mui/material/colors";
import React from "react";

export const Settings = () => {
	const [logIPCFromNative, setLogIPCFromNative] = React.useState(storage.logIPCFromNative);
	const [logIPCFromRender, setLogIPCFromRender] = React.useState(storage.logIPCFromRender);

	const [logReduxEvents, setLogReduxEvents] = React.useState(storage.logReduxEvents);
	const [logInterceptsRegex, setLogInterceptsRegex] = React.useState(storage.logInterceptsRegex);

	const [debugPort, setDebugPort] = React.useState<number | undefined>(undefined);

	const nativeDebugging = debugPort !== undefined;
	return (
		<>
			<LunaSettings title="Redux Logging">
				<LunaSetting title="Render redux events" desc="Log Redux dispatch events to console">
					<TextField
						label="Event regex filter"
						placeholder=".*"
						size="small"
						sx={{ flexGrow: 1, marginLeft: 10, marginRight: 10, marginTop: 0.5 }}
						slotProps={{
							htmlInput: { style: { color: grey.A400 } },
						}}
						value={logInterceptsRegex}
						onChange={(e) => {
							setLogInterceptsRegex((storage.logInterceptsRegex = e.target.value));
						}}
					/>
					<LunaSwitch
						tooltip="Render redux events"
						checked={logReduxEvents}
						onChange={async (_, checked) => {
							if (checked)
								await startReduxLog(new RegExp(storage.logInterceptsRegex || ".*"), trace.log.withContext("(Redux)")).catch(
									trace.err.withContext("Failed to start redux event logging").throw,
								);
							else await stopReduxLog().catch(trace.err.withContext("Failed to stop redux event logging").throw);
							setLogReduxEvents((storage.logReduxEvents = checked));
						}}
					/>
				</LunaSetting>
			</LunaSettings>
			<LunaSettings title="IPC Logging" desc="Logs IPC events between Render & Native to console">
				<LunaSwitchSetting
					title="Native IPC"
					desc={
						<>
							Log <b>Native {">"} Render</b> IPC events
						</>
					}
					checked={logIPCFromNative}
					onChange={async (_, checked) => {
						if (checked) await startNativeIPCLog().catch(trace.err.withContext("Failed to start native IPC logging").throw);
						else await stopNativeIPCLog().catch(trace.err.withContext("Failed to stop native IPC logging").throw);
						setLogIPCFromNative((storage.logIPCFromNative = checked));
					}}
				/>
				<LunaSwitchSetting
					title="Render IPC"
					desc={
						<>
							Log <b>Render {">"} Native</b> IPC events
						</>
					}
					checked={logIPCFromRender}
					onChange={async (_, checked) => {
						if (checked) await startRenderIpcLog().catch(trace.err.withContext("Failed to start render IPC logging").throw);
						else await stopRenderIpcLog().catch(trace.err.withContext("Failed to stop render IPC logging").throw);
						setLogIPCFromRender((storage.logIPCFromRender = checked));
					}}
				/>
			</LunaSettings>
			<br />
			<LunaSettings title="Debugging" desc="Toggles for triggering debugging">
				<LunaButtonSetting
					title="Native debugger"
					desc={
						<>
							Enables native side debugger, disabling requires a client restart. Access via <b>chrome://inspect</b>
						</>
					}
					onClick={() => startNativeDebugging().then(setDebugPort)}
					disabled={nativeDebugging}
					sx={{
						marginLeft: "auto",
						marginRight: 2,
						color: nativeDebugging ? "green !important" : undefined,
					}}
				>
					{nativeDebugging ? `Listening on port ${debugPort}` : "Start Debugging"}
				</LunaButtonSetting>
			</LunaSettings>
		</>
	);
};
