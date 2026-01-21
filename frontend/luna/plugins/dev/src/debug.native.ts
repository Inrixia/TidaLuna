export const startNativeDebugging = async () => {
	// @ts-expect-error This exists
	process._debugProcess(process.pid);
	return process.debugPort;
};
