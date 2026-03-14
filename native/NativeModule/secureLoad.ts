import { objectify } from "@inrixia/helpers";
import vm from "vm";

import { nativeRequire, type NativeModuleInfo } from ".";
import { isTrusted } from "./trust";

import type Module from "module";
import { moduleWhitelist } from "./moduleWhitelist";

export const secureLoad = (moduleInfo: NativeModuleInfo): Module["exports"] => {
	const { fileName, code } = moduleInfo;

	const require = new Proxy(nativeRequire, {
		apply: (target, thisArg, argumentsList: [moduleName: string]) => {
			const moduleName = argumentsList[0].replace(/^node:/, "").replace("/promises", "");

			// Whitelist (Pass through directly, no proxy needed)
			if (moduleWhitelist.has(moduleName)) return target.apply(thisArg, argumentsList);

			// Load the real module
			const realModule = target.apply(thisArg, argumentsList);

			// REVERSE LOOKUP (Critical for fixing "Incompatible Receiver")
			const proxyToTarget = new WeakMap<any, any>();
			// FORWARD CACHE (Preserves Identity)
			const proxyCache = new WeakMap<any, any>();

			const createLazyProxy = (targetValue: any): any => {
				// Pass through primitives
				if (Object(targetValue) !== targetValue) return targetValue;

				// Return cached proxy
				if (proxyCache.has(targetValue)) return proxyCache.get(targetValue);

				const proxy = new Proxy(targetValue, {
					get: (obj, prop, receiver) => {
						// Block Sandbox Escapes
						if (prop === "constructor") return undefined;

						// Pass through Symbols (Safe)
						if (typeof prop === "symbol") return Reflect.get(obj, prop, receiver);

						// Handle Read-Only Invariants (Fixes "TypeError: 'get' on proxy...")
						const descriptor = Reflect.getOwnPropertyDescriptor(obj, prop);
						if (descriptor && !descriptor.configurable && !descriptor.writable) {
							return Reflect.get(obj, prop, receiver);
						}

						const value = Reflect.get(obj, prop, receiver);

						// We still proxy properties (like .promises or .constants) so we can trap them later.
						return createLazyProxy(value);
					},

					apply: (fn, thisArg, args) => {
						if (!isTrusted(moduleInfo, moduleName, targetValue)) {
							throw new Error(`[🛑Security🛑] Access Denied: User blocked execution of '${moduleName}' in '${fileName}'`);
						}

						// Native methods (Map.get, Promise.then) crash if 'this' is a Proxy.
						const realThis = proxyToTarget.get(thisArg) || thisArg;

						// Return the REAL result (Promise, Buffer, etc.) fixes "Incompatible Receiver" or chaining issues.
						return Reflect.apply(fn, realThis, args);
					},

					construct: (fn, args) => {
						if (!isTrusted(moduleInfo, moduleName, targetValue)) {
							throw new Error(`[🛑Security🛑] Access Denied: User blocked construction of '${moduleName}' in '${fileName}'`);
						}

						return Reflect.construct(fn, args);
					},
				});

				// Register in both maps
				proxyCache.set(targetValue, proxy);
				proxyToTarget.set(proxy, targetValue);

				return proxy;
			};

			// Start the proxy chain with the module name as the root path
			return createLazyProxy(realModule);
		},
		get: (target, prop, receiver) => {
			// Only expose resolve and toString
			if (prop === "resolve" || prop === "toString") return Reflect.get(target, prop, receiver);
			return undefined;
		},
	});

	const WebAssembly = new Proxy(globalThis.WebAssembly, {
		get(target, prop, receiver) {
			console.warn(`[🛑Security🛑] '${fileName}' is loading WebAssembly (${String(prop)})!`);
			if (!isTrusted(moduleInfo, "WebAssembly", target)) {
				throw new Error(`[🛑Security🛑] Access Denied! User blocked 'WebAssembly' (${String(prop)}) in '${fileName}'`);
			}

			return Reflect.get(target, prop, receiver);
		},
	});

	const createStreamMock = (realStream: (NodeJS.ReadStream | NodeJS.WriteStream) & { fd: number }) => ({
		fd: realStream.fd,
		isTTY: realStream.isTTY,
		write: (...args: Parameters<typeof realStream.write>) => realStream.write(...args),
		on: () => {},
		once: () => {},
		emit: () => false,
		removeListener: () => {},
		setMaxListeners: () => {},
	});

	const mockProcess = {
		// Safe Methods
		nextTick: (...args: Parameters<typeof process.nextTick>) => process.nextTick(...args),
		hrtime: (time?: [number, number]) => process.hrtime(time),
		...objectify({
			env: Object.freeze(Object.fromEntries(
				["TMPDIR", "TMP", "TEMP", "XDG_RUNTIME_DIR", "HOME", "USERPROFILE", "PATH", "APPDATA"]
					.filter((k) => k in process.env)
					.map((k) => [k, process.env[k]]),
			)),
			version: process.version,
			versions: process.versions,
			platform: process.platform,
			arch: process.arch,
			release: process.release,
			features: process.features,
		}),
		stdin: createStreamMock(process.stdin),
		stderr: createStreamMock(process.stderr),
		stdout: createStreamMock(process.stdout),

		resourcesPath: process.resourcesPath,

		cwd: () => process.cwd(),
		argv: Object.freeze([...process.argv]),

		debugProcess: () => {
			// @ts-expect-error This exists
			const debugProcess: (pid: number) => void = process._debugProcess;
			console.warn(`[🛑Security🛑] '${fileName}' is calling 'process.debugProcess'`);
			if (!isTrusted(moduleInfo, "DebugProcess", debugProcess)) {
				throw new Error(`[🛑Security🛑] Access Denied! User blocked 'process.debugProcess' in '${fileName}'`);
			}
			debugProcess(process.pid);
			return process.debugPort;
		},
	};

	// 2. Setup Sandbox
	const sandbox = {
		module: { exports: {} },
		exports: {},
		global: {},
		__filename: `luna://${fileName}`,
		__dirname: process.resourcesPath,

		// Proxied
		require,
		WebAssembly,

		// Mocked
		process: mockProcess,

		// Node.js specific
		ReadableStream,
		Buffer,
		Event,
		EventTarget,
		console: {
			log: console.log.bind(console),
			error: console.error.bind(console),
			warn: console.warn.bind(console),
			info: console.info.bind(console),
		},

		// Timers (Not part of JS spec, part of host)
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		setImmediate,
		clearImmediate,

		// Web APIs (Node.js provides these, but V8 vanilla context might lack them)
		URL,
		URLSearchParams,
		TextEncoder,
		TextDecoder,
		fetch,
		Headers,
		Request,
		Response,
		FormData,
		Blob,
		File,
		atob,
		btoa,
		performance,
		queueMicrotask,
		structuredClone,
		AbortController,
		AbortSignal,

		// Crypto
		crypto,
		SubtleCrypto,
		CryptoKey,

		// Luna specific
		luna,
	};

	sandbox.global = sandbox;

	// Link exports so 'exports.foo =' works
	sandbox.exports = sandbox.module.exports;

	try {
		const context = vm.createContext(sandbox, {
			name: fileName,
			codeGeneration: {
				strings: false,
				wasm: true,
			},
		});

		vm.runInContext(code, context, {
			filename: `luna://${fileName}`,
			timeout: 5000,
			displayErrors: true,
		});

		return sandbox.module.exports as Module;
	} catch (err) {
		console.error(`Failed to load module ${fileName}:`, err);
		throw err;
	}
};
