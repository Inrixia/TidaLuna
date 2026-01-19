declare global {
    interface Window {
        ipc: {
            postMessage: (message: string) => void;
        };
        nativeInterface: any;
        NativePlayerComponent: any;
        __TIDAL_CALLBACKS__: any;
        __TIDAL_IPC_RESPONSE__: any;
    }
    var window: Window & typeof globalThis;
}


const sendIpc = (channel: string, ...args: any[]) => {
    window.ipc.postMessage(JSON.stringify({ channel, args }));
};

const pendingRequests = new Map<string, { resolve: (value: any) => void, reject: (reason: any) => void }>();

window.__TIDAL_IPC_RESPONSE__ = (id: string, error: any, result: any) => {
    const req = pendingRequests.get(id);
    if (req) {
        if (error) req.reject(error);
        else req.resolve(result);
        pendingRequests.delete(id);
    }
};

const invokeIpc = (channel: string, ...args: any[]) => {
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).substring(2);
        pendingRequests.set(id, { resolve, reject });
        window.ipc.postMessage(JSON.stringify({ channel, args, id }));
    });
};
const createApplicationController = () => {
    let delegate: any = null;


    window.__TIDAL_CALLBACKS__ = window.__TIDAL_CALLBACKS__ || {};
    window.__TIDAL_CALLBACKS__.application = {
        trigger: (method: string, ...args: any[]) => {
            if (delegate && delegate[method]) {
                delegate[method](...args);
            }
        }
    };

    return {
        applyUpdate: () => sendIpc("update.action"),
        checkForUpdatesSilently: () => sendIpc("updater.check.silently"),
        getDesktopReleaseNotes: () => JSON.stringify({}),
        getPlatform: () => "win32",
        getPlatformTarget: () => "standalone",
        getProcessUptime: () => 100,
        getVersion: () => "2.38.6.6",
        getWindowsVersionNumber: () => Promise.resolve("10.0.0"),
        ready: () => sendIpc("web.loaded"),
        reenableAutoUpdater: () => sendIpc("update.reenable"),
        registerDelegate: (d: any) => { delegate = d; },
        reload: () => window.location.reload(),
        setWebVersion: (v: string) => sendIpc("web.version.set", v),
    };
};

const createAudioHack = () => {
    return {
        pause: () => { },
        play: () => { }
    }
}

const createNavigationController = () => {
    let delegate: any = null;


    window.__TIDAL_CALLBACKS__ = window.__TIDAL_CALLBACKS__ || {};
    window.__TIDAL_CALLBACKS__.navigation = {
        navigate: (command: string) => {
            if (!delegate) return;
            switch (command) {
                case "refreshprofile":
                    if (delegate.refreshprofile) delegate.refreshprofile();
                    break;
                default:
                    if (delegate.gotoPage) delegate.gotoPage(command);
            }
        }
    };

    return {
        registerDelegate: (d: any) => { delegate = d; },
        goBack: () => { if (delegate && delegate.goBack) delegate.goBack(); },
        goForward: () => { if (delegate && delegate.goForward) delegate.goForward(); },

    }
}

const createPlaybackController = () => {
    let delegate: any = null;
    return {
        registerDelegate: (d: any) => { delegate = d; },
        sendPlayerCommand: (cmd: any) => sendIpc("player.message", cmd),
        setCurrentMediaItem: (item: any) => sendIpc("playback.current.mediaitem", item),
        setCurrentTime: (time: any) => sendIpc("playback.current.time", time),
        setPlayQueueState: (state: any) => sendIpc("playback.queue.state", state),
        setPlayingStatus: (status: any) => sendIpc("playback.status.playing", status),
        setRepeatMode: (mode: any) => sendIpc("playback.status.repeat", mode),
        setShuffle: (shuffle: any) => sendIpc("playback.status.shuffle", shuffle),
    }
}

const createUserSession = () => {
    let delegate: any = null;
    return {
        clear: () => invokeIpc("user.session.clear"),
        registerDelegate: (d: any) => { delegate = d; },
        update: (s: any) => invokeIpc("user.session.update", s),
    }
}

const createUserSettings = () => {
    return {
        get: (key: string) => invokeIpc("user.settings.get", key),
        set: (key: string, value: any) => invokeIpc("user.settings.set", key, value),
    }
}

const createWindowController = (initialState: { isMaximized: boolean, isFullscreen: boolean }) => {
    let isMaximized = initialState.isMaximized;
    let isFullscreen = initialState.isFullscreen;
    const listeners: Record<string, Function[]> = {};

    const updateState = (maximized: boolean, fullscreen: boolean) => {
        const maxChanged = isMaximized !== maximized;
        const fullChanged = isFullscreen !== fullscreen;

        isMaximized = maximized;
        isFullscreen = fullscreen;

        if (maxChanged) {
            const event = maximized ? "maximize" : "unmaximize";
            if (listeners[event]) listeners[event].forEach(cb => cb());
        }
        if (fullChanged) {
            const event = fullscreen ? "enter-full-screen" : "leave-full-screen";
            if (listeners[event]) listeners[event].forEach(cb => cb());
        }
    };

    window.__TIDAL_CALLBACKS__ = window.__TIDAL_CALLBACKS__ || {};
    window.__TIDAL_CALLBACKS__.window = {
        updateState: updateState
    };

    return {
        close: () => sendIpc("window.close"),
        isFullscreen: () => isFullscreen,
        isMaximized: () => isMaximized,
        maximize: () => sendIpc("window.maximize"),
        minimize: () => sendIpc("window.minimize"),
        on: (event: string, callback: any) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(callback);
        },
        openMenu: (x: number, y: number) => sendIpc("menu.clicked", x, y),
        unmaximize: () => sendIpc("window.unmaximize"),
    }
}

const generateCodeVerifier = () => {
    const array = new Uint8Array(32);
    window.crypto.getRandomValues(array);
    return btoa(String.fromCharCode.apply(null, Array.from(array))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const generateCodeChallenge = async (verifier: string) => {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await window.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hash));
    return btoa(String.fromCharCode.apply(null, hashArray)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const createNativePlayerComponent = () => {

    const Player = () => {
        const listeners: any = {};
        window.__TIDAL_CALLBACKS__ = window.__TIDAL_CALLBACKS__ || {};
        window.__TIDAL_CALLBACKS__.player = (message: any) => {
            console.log("Native Player Callback:", message);
        };
        return {
            addEventListener: (event: string, cb: any) => {
                if (!listeners[event]) listeners[event] = [];
                listeners[event].push(cb);
            },
            removeEventListener: (event: string, cb: any) => {
                if (listeners[event]) {
                    listeners[event] = listeners[event].filter((x: any) => x !== cb);
                }
            },
            load: (url: string, streamFormat: string, encryptionKey: string) => {
                sendIpc("media.load", { url, streamFormat, encryptionKey });
            },
            play: () => sendIpc("media.play"),
            pause: () => sendIpc("media.pause"),
            stop: () => sendIpc("media.stop"),
            seek: (time: number) => sendIpc("media.seek", time),
            setVolume: (volume: number) => sendIpc("media.volume", volume),
            listDevices: () => [],

        }
    }
    return { Player };
}

const init = async () => {
    console.log("Initializing Native Interface...");

    let codeVerifier = sessionStorage.getItem("pkce_verifier");
    let codeChallenge = sessionStorage.getItem("pkce_challenge");

    if (!codeVerifier || !codeChallenge) {
        codeVerifier = generateCodeVerifier();
        codeChallenge = await generateCodeChallenge(codeVerifier);
        sessionStorage.setItem("pkce_verifier", codeVerifier);
        sessionStorage.setItem("pkce_challenge", codeChallenge);
        console.log("Generated new PKCE pair");
    } else {
        console.log("Restored PKCE pair from session storage");
    }

    console.log("PKCE Verifier:", codeVerifier);
    console.log("PKCE Challenge:", codeChallenge);


    let windowState = { isMaximized: false, isFullscreen: false };
    try {
        const state = await invokeIpc("window.state.get");
        if (state) windowState = state as any;
    } catch (e) {
        console.error("Failed to get window state", e);
    }

    const nativeInterface = {
        application: createApplicationController(),
        audioHack: createAudioHack(),
        chromecast: undefined,
        credentials: {
            credentialsStorageKey: "tidal",
            codeChallenge: codeChallenge,
            redirectUri: "tidal://auth/",
            codeVerifier: codeVerifier
        },
        features: { chromecast: false, tidalConnect: false },
        navigation: createNavigationController(),
        playback: createPlaybackController(),
        remoteDesktop: undefined,
        tidalConnect: undefined,
        userSession: createUserSession(),
        userSettings: createUserSettings(),
        window: createWindowController(windowState),
    };

    window.nativeInterface = nativeInterface;
    window.NativePlayerComponent = createNativePlayerComponent();

    console.log("Native Interface initialized.");
};

if (window.location.hostname !== 'login.tidal.com') {
    init();
} else {
    console.log("Skipping Native Interface initialization on login.tidal.com");
}