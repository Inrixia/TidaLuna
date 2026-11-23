import { BrowserWindow } from "electron";

import { groupModules } from "./categories";
import type { PermissionAnswer } from "./store";

export type PermissionRequest = {
	fileName: string;
	/** Checked plugin url; undefined if it is unknown or could not be checked */
	url?: string;
	/** The url the renderer named, shown when it could not be checked */
	claimedUrl?: string;
	/** Modules the file's source names, shown for information */
	modules: string[];
};

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const SUBMIT = "luna-permissions:";
const FIT = "luna-permissions-fit:";

/** Shown before "All versions" is taken */
const ALL_VERSIONS_WARNING =
	"Every future update of this file from this source runs without asking. If the plugin's author, or anyone who takes over its repository or release, ships harmful code, it runs in TIDAL's main process.";

// Line icons (24x24, drawn with the text colour)
const icon = (paths: string, className = "icon") =>
	`<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const icons = {
	plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>',
	file: '<path d="M14 3H6v18h12V7zM14 3v4h4"/>',
	link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
	close: '<path d="M6 6l12 12M18 6L6 18"/>',
	list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
	chevron: '<path d="M6 9l6 6 6-6"/>',
	shield: '<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6zM12 9v4M12 16v.01"/>',
};
const isLocal = (url: string) => {
	try {
		return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
	} catch {
		return false;
	}
};

const buildHtml = ({ fileName, url, claimedUrl, modules }: PermissionRequest) => {
	// "@scope/plugin/file.native.ts" -> scope "@scope", plugin "plugin", file "file.native.ts"
	const slash = fileName.lastIndexOf("/");
	const pluginPath = slash === -1 ? fileName : fileName.slice(0, slash);
	const file = slash === -1 ? undefined : fileName.slice(slash + 1);
	const scoped = /^(@[^/]+)\/(.+)$/.exec(pluginPath);
	const plugin = scoped?.[2] ?? pluginPath;
	const by = scoped !== null ? `${escapeHtml(scoped[1])} · ` : "";

	const shown = (text: string) => escapeHtml(text.replace(/^https?:\/\//, ""));
	const chips = [
		file !== undefined ? `<span class="chip mono">${icon(icons.file)}${escapeHtml(file)}</span>` : "",
		url !== undefined
			? `<span class="chip mono" title="${escapeHtml(url)}">${icon(icons.link)}${shown(url)}</span>${isLocal(url) ? '<span class="tag local">Local</span>' : ""}`
			: claimedUrl !== undefined
				? `<span class="chip mono" title="${escapeHtml(claimedUrl)}">${icon(icons.link)}${shown(claimedUrl)}</span><span class="tag bad" title="It does not serve this code, or could not be reached">Not checked</span>`
				: '<span class="tag bad">Unknown source</span>',
	].join("");

	// What the source names, by category. For information: the answer is for the file as a whole
	const groups = groupModules(modules);
	const namesSummary = modules.length === 0 ? "Its code names no Node modules" : `Its code names ${modules.length} module${modules.length === 1 ? "" : "s"}`;
	const namesHtml = `<details class="names"><summary>${icon(icons.list)}<span>${namesSummary}<span class="muted"> · for information, not a limit</span></span>${icon(icons.chevron, "icon chevron")}</summary>
	<div class="note">Read from the text of the file. This list does not limit the plugin: native code that runs in the main process can do more than it shows.</div>
	<ul>${groups
		.map(
			({ label, description, modules }) =>
				`<li title="${escapeHtml(description)}">${escapeHtml(label)} <span class="mono muted">${escapeHtml(modules.join(", "))}</span></li>`,
		)
		.join("")}</ul>
</details>`;

	// How long an answer holds. Answers of a file without a url are kept for its code, an uninstall can't find them
	const help = [
		"This version: until an update changes this file.",
		url !== undefined ? "All versions: also later updates from this source. Deny: this and later versions from this source." : "Deny: this version.",
		url !== undefined || claimedUrl !== undefined ? "Until the plugin is reinstalled; revoke any time in Luna Settings." : "Revoke any time in Luna Settings.",
	].join(" ");

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Plugin Permission</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html, body { height:100%; }
:root { color-scheme:dark; }
::-webkit-scrollbar { width:8px; }
::-webkit-scrollbar-thumb { background:#3a3a3a; border-radius:4px; }
::-webkit-scrollbar-track { background:transparent; }
body { background:#0a0a0a; color:#f4f4f5; font-family:system-ui,"Segoe UI",sans-serif; font-size:14px; padding:24px 28px 22px; user-select:none; display:flex; flex-direction:column; }
.mono { font-family:ui-monospace,Consolas,monospace; }
.muted { color:#8b8b93; }
.icon { width:18px; height:18px; flex:none; }
button { font:inherit; border:none; cursor:pointer; }
:focus-visible { outline:2px solid #5eead4; outline-offset:2px; }
header { display:flex; gap:14px; align-items:flex-start; }
header .plug { color:#5eead4; margin-top:30px; }
header .plug .icon { width:30px; height:30px; }
header .titles { flex:1; min-width:0; }
.eyebrow { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:#8b8b93; font-weight:600; }
h1 { font-size:24px; font-weight:700; margin:4px 0 2px; word-break:break-word; }
.sub { color:#a1a1aa; font-size:15px; }
.x { background:none; color:#a1a1aa; padding:4px; border-radius:4px; }
.x:hover { color:#fff; background:#2a2a2a; }
.chips { display:flex; flex-wrap:wrap; gap:8px; margin:18px 0 16px; }
.chip { display:inline-flex; align-items:center; gap:8px; background:#1c1c1c; color:#d4d4d8; border-radius:4px; padding:7px 11px; font-size:13px; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.chip .icon { width:15px; height:15px; color:#8b8b93; }
.tag { display:inline-flex; align-items:center; border-radius:4px; padding:6px 9px; font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
.tag.local { background:#10302c; color:#5eead4; }
.tag.bad { background:#3a2410; color:#f0a040; }
.ask { display:flex; gap:14px; background:#161616; border-radius:6px; padding:16px; }
.ask .icon { width:24px; height:24px; color:#f87171; margin-top:1px; }
.ask b { color:#f4f4f5; }
.name { font-size:17px; font-weight:700; }
.desc { color:#b4b4bb; margin-top:6px; line-height:1.45; }
.names { color:#d4d4d8; border-top:1px solid #27272a; margin-top:16px; padding-top:8px; }
.names summary { list-style:none; display:flex; align-items:center; gap:10px; padding:8px 4px; cursor:pointer; }
.names summary::-webkit-details-marker { display:none; }
.names summary .icon { color:#8b8b93; }
.names .chevron { margin-left:auto; transition:transform .15s; }
.names[open] .chevron { transform:rotate(180deg); }
.names .note { color:#a1a1aa; line-height:1.5; padding:2px 4px 6px 32px; }
.names ul { list-style:none; padding:0 4px 0 32px; font-size:13px; line-height:1.8; max-height:170px; overflow-y:auto; }
.help { font-size:12px; color:#71717a; margin-top:12px; line-height:1.5; }
.actions { display:flex; justify-content:flex-end; gap:10px; margin-top:16px; }
.pill { padding:10px 20px; border-radius:6px; font-size:15px; font-weight:700; }
.pill.dark { background:#2a2a2a; color:#f4f4f5; }
.pill.dark:hover { background:#353535; }
.pill.light { background:#f4f4f5; color:#0a0a0a; }
.pill.red { background:#dc2626; color:#fff; }
.pill.risky { background:#2a2a2a; color:#f87171; }
.pill.risky:hover { background:#353535; }
#confirm { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.78); align-items:center; justify-content:center; padding:24px; }
#confirm.open { display:flex; }
#confirm .box { background:#1a0f10; border:1px solid #7f1d1d; border-radius:8px; padding:20px 22px; color:#e4e4e7; line-height:1.5; max-width:500px; }
#confirm h3 { color:#f87171; font-size:18px; margin-bottom:10px; }
#confirm .actions { margin-top:18px; }
</style>
</head>
<body>
<div id="main">
<header>
	<span class="plug">${icon(icons.plug)}</span>
	<div class="titles">
		<div class="eyebrow">Plugin permission</div>
		<h1>${escapeHtml(plugin)}</h1>
		<div class="sub">${by}wants to run native code</div>
	</div>
	<button class="x" id="close" title="Close: answers nothing, you will be asked again next time">${icon(icons.close)}</button>
</header>
<div class="chips">${chips}</div>
<div class="ask">${icon(icons.shield)}<div>
	<div class="name">Run this file in TIDAL's main process?</div>
	<div class="desc">Its code would run inside the TIDAL app itself. Luna can't contain code that runs there: it can get <b>full access</b> to the app, your TIDAL account and this computer (files, network, programs). Allow it only if you trust this plugin.</div>
</div></div>
<div class="help">${help}</div>
<div class="actions">
	<button class="pill dark" id="deny">Deny</button>
	${url !== undefined ? '<button class="pill risky" id="all" title="Also allow future versions from this source, after a confirmation">All versions...</button>' : ""}
	<button class="pill light" id="allow">Allow this version</button>
</div>
${namesHtml}
</div>
<div id="confirm"><div class="box">
	<h3>Allow all versions of this file?</h3>
	<div>${escapeHtml(ALL_VERSIONS_WARNING)}</div>
	<div class="actions"><button class="pill dark" id="confirm-no">Cancel</button><button class="pill red" id="confirm-yes">Allow all versions</button></div>
</div></div>
<script>
const confirmBox = document.getElementById("confirm");
const main = document.getElementById("main");
const all = document.getElementById("all");
const submit = (answer) => (document.title = "${SUBMIT}" + answer);
// "All versions" must be confirmed: nothing behind the question can be clicked until it is answered
const confirm = (open) => {
	confirmBox.classList.toggle("open", open);
	main.inert = open;
	(open ? document.getElementById("confirm-no") : all).focus();
};
document.getElementById("deny").addEventListener("click", () => submit("deny"));
document.getElementById("allow").addEventListener("click", () => submit("allow"));
all?.addEventListener("click", () => confirm(true));
document.getElementById("confirm-yes").addEventListener("click", () => submit("allowUpdates"));
document.getElementById("confirm-no").addEventListener("click", () => confirm(false));
document.addEventListener("keydown", (event) => event.key === "Escape" && confirmBox.classList.contains("open") && confirm(false));
document.getElementById("close").addEventListener("click", () => window.close());
// Main fits the window to the opened or closed list (the title must change to be seen)
document.querySelector("details.names").addEventListener("toggle", () => (document.title = "${FIT}" + Date.now()));
</script>
</body>
</html>`;
};

const MIN_HEIGHT = 320;
const MAX_HEIGHT = 860;
// Height the page needs: the body's padding plus each block
const MEASURE = `(() => {
	const body = getComputedStyle(document.body);
	let height = parseFloat(body.paddingTop) + parseFloat(body.paddingBottom);
	for (const el of document.getElementById("main").children) {
		const style = getComputedStyle(el);
		height += el.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
	}
	return Math.ceil(height);
})()`;

const answerValues = new Set<string>(["deny", "allow", "allowUpdates"]);

// One window at a time: several native files can load at once
let queue: Promise<unknown> = Promise.resolve();

/**
 * Asks whether a native file may run in TIDAL's main process and resolves with the answer (none if the window was closed).
 * A window of its own (own session, no preload), so the TIDAL page and its plugins cannot see or click it.
 *
 * @param getRequest Called when the window's turn comes: a window before it may have answered what this one was to ask.
 * Returns undefined if nothing is left to ask, and no window is shown.
 */
export const askPermission = (
	getRequest: () => PermissionRequest | undefined,
	parent?: BrowserWindow,
): Promise<{ answer: PermissionAnswer | undefined } | undefined> => {
	const show = (request: PermissionRequest) =>
		new Promise<PermissionAnswer | undefined>((resolve) => {
			// Not owned by a minimized or hidden TIDAL window: it would be hidden with it, and the plugin would wait unseen
			const owner = parent !== undefined && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized() ? parent : undefined;
			const win = new BrowserWindow({
				parent: owner,
				modal: owner !== undefined,
				width: 620,
				height: 480,
				resizable: true,
				minimizable: false,
				maximizable: false,
				fullscreenable: false,
				autoHideMenuBar: true,
				backgroundColor: "#0a0a0a",
				title: "Plugin Permission",
				show: false,
				webPreferences: {
					partition: "luna-permissions",
					sandbox: true,
					contextIsolation: true,
					nodeIntegration: false,
					devTools: false,
					spellcheck: false,
				},
			});
			win.removeMenu();
			// Fits the window to its content, also once the list of modules is opened
			const fit = (first: boolean) =>
				win.webContents
					.executeJavaScript(MEASURE)
					.then((height: unknown) => {
						if (win.isDestroyed() || typeof height !== "number" || !Number.isFinite(height)) return;
						const [width] = win.getContentSize();
						win.setContentSize(width, Math.round(Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT)));
						if (first) win.center();
					})
					.catch(() => {});
			let answered: PermissionAnswer | undefined;
			win.on("page-title-updated", (event, title) => {
				// The list of modules was opened or closed: only a size to fit, nothing else is read from it
				if (title.startsWith(FIT)) {
					event.preventDefault();
					void fit(false);
					return;
				}
				if (!title.startsWith(SUBMIT)) return;
				event.preventDefault();
				const chosen = title.slice(SUBMIT.length);
				if (answerValues.has(chosen) && (chosen !== "allowUpdates" || request.url !== undefined)) answered = chosen as PermissionAnswer;
				win.close();
			});
			// The page is ours and static: nothing in it may navigate or open windows
			win.webContents.on("will-navigate", (event) => event.preventDefault());
			win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
			// A window that can't show would hold up every later one (see queue)
			win.webContents.once("render-process-gone", () => !win.isDestroyed() && win.destroy());
			win.webContents.once("did-fail-load", () => !win.isDestroyed() && win.destroy());
			win.once("ready-to-show", () => void fit(true).finally(() => !win.isDestroyed() && win.show()));
			win.once("closed", () => resolve(answered));
			win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildHtml(request))}`).catch((err) => {
				console.error("[🛑Security🛑] Failed to show the permission window", err);
				if (!win.isDestroyed()) win.close();
			});
		});
	const ask = async () => {
		const request = getRequest();
		return request === undefined ? undefined : { answer: await show(request) };
	};
	const result = queue.then(ask, ask);
	queue = result;
	return result;
};
