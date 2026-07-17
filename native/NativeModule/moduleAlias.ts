export const moduleAlias = (moduleName: string) => {
	switch (moduleName) {
		case "fs":
		case "fs/promises":
			return "your FILESYSTEM";

		case "child_process":
		case "worker_threads":
		case "cluster":
		case "WebAssembly":
			return "EXECUTE code on your system";

		case "net":
		case "http":
		case "https":
		case "dgram":
		case "tls":
		case "http2":
		case "inspector":
			return "your NETWORK";

		case "os":
		case "v8":
		case "vm":
		case "process":
		case "electron":
			return "your SYSTEM";

		case "clipboard":
			return "your CLIPBOARD";

		case "DebugProcess":
			return "DEBUG the main process";

		default:
			return moduleName;
	}
};
