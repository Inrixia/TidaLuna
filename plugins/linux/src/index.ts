export * from "./index.safe";
export { showSettings, hideSettings } from "./tidalHifi";


// Bridge to tidal-hifi's main process features (MPRIS, Discord RPC, notifications, hotkeys, etc.)
import "./tidalHifi";
