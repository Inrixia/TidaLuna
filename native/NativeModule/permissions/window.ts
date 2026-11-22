import { BrowserWindow } from "electron";

import { categoryInfo } from "./categories";
import type { PermissionAnswer } from "./store";

export type PermissionRequest = {
	fileName: string;
	/** Checked plugin url; undefined if it is unknown or could not be checked */
	url?: string;
	/** The url the renderer named, shown when it could not be checked */
	claimedUrl?: string;
	rows: { category: string; modules: string[] }[];
	/** Answers kept from earlier builds, shown for context */
	kept: { category: string; answer: PermissionAnswer }[];
};

const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const SUBMIT = "luna-permissions:";
const FIT = "luna-permissions-fit:";

const keptText: Record<PermissionAnswer, string> = {
	allow: "allowed for this version",
	allowUpdates: "allowed for all versions",
	deny: "denied",
};

/** Shown before "All versions" is taken, here and in the message box of a module first used after the load */
export const ALL_VERSIONS_WARNING =
	"Every future update from this source gets this access without asking. If the plugin's author, or anyone who takes over its repository or release, ships harmful code, it runs with this access.";

/** Categories that give the code control of the app or the computer, marked "High risk" */
const highRisk = new Set(["main", "filesystem", "execute", "electron", "tidal", "debug"]);

// Line icons (24x24, drawn with the text colour)
const icon = (paths: string, className = "icon") =>
	`<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const icons = {
	plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>',
	file: '<path d="M14 3H6v18h12V7zM14 3v4h4"/>',
	link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
	close: '<path d="M6 6l12 12M18 6L6 18"/>',
	check: '<path d="M5 12l5 5 9-10"/>',
	chevron: '<path d="M6 9l6 6 6-6"/>',
	warning: '<path d="M12 3l10 18H2zM12 10v5M12 18v.01"/>',
};
const categoryIcons: Record<string, string> = {
	main: '<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6zM12 9v4M12 16v.01"/>',
	network: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
	udp: '<circle cx="12" cy="12" r="2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 19a10 10 0 0 1 0-14M19 5a10 10 0 0 1 0 14"/>',
	filesystem: '<path d="M3 6h6l2 2h10v11H3z"/>',
	system: '<rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
	execute: '<path d="M4 17l6-5-6-5M12 19h8"/>',
	electron:
		'<circle cx="12" cy="12" r="1.5"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/>',
	debug:
		'<path d="M8 8a4 4 0 0 1 8 0v1H8zM7 9h10v6a5 5 0 0 1-10 0zM12 9v11M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 20l3-3M20 20l-3-3M9 4L8 2M15 4l1-2"/>',
	tidal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
	module: '<path d="M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"/>',
};

const isLocal = (url: string) => {
	try {
		return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
	} catch {
		return false;
	}
};

const buildHtml = ({ fileName, url, claimedUrl, rows, kept }: PermissionRequest) => {
	// "@scope/plugin/file.native.ts" -> scope "@scope", plugin "plugin", file "file.native.ts"
	const slash = fileName.lastIndexOf("/");
	const pluginPath = slash === -1 ? fileName : fileName.slice(0, slash);
	const file = slash === -1 ? undefined : fileName.slice(slash + 1);
	const scoped = /^(@[^/]+)\/(.+)$/.exec(pluginPath);
	const plugin = scoped?.[2] ?? pluginPath;
	const by = scoped !== null ? `${escapeHtml(scoped[1])} · ` : "";
	const wants = `wants ${rows.length} ${kept.length > 0 ? "new " : ""}permission${rows.length === 1 ? "" : "s"}`;

	const shown = (text: string) => escapeHtml(text.replace(/^https?:\/\//, ""));
	const chips = [
		file !== undefined ? `<span class="chip mono">${icon(icons.file)}${escapeHtml(file)}</span>` : "",
		url !== undefined
			? `<span class="chip mono" title="${escapeHtml(url)}">${icon(icons.link)}${shown(url)}</span>${isLocal(url) ? '<span class="tag local">Local</span>' : ""}`
			: claimedUrl !== undefined
				? `<span class="chip mono" title="${escapeHtml(claimedUrl)}">${icon(icons.link)}${shown(claimedUrl)}</span><span class="tag bad" title="It does not serve this code, or could not be reached">Not checked</span>`
				: '<span class="tag bad">Unknown source</span>',
	].join("");

	const rowsHtml = rows
		.map(({ category, modules }, i) => {
			const { label, description } = categoryInfo(category);
			const glyph = categoryIcons[category.startsWith("module:") ? "module" : category] ?? categoryIcons.module;
			const updates =
				url !== undefined
					? `<label class="risky" title="Also allow future versions from this source, after a confirmation"><input type="radio" name="r${i}" value="allowUpdates">All versions</label>`
					: "";
			return `<div class="row">
	<div class="what">
		<span class="cat-icon${highRisk.has(category) ? " high" : ""}">${icon(glyph)}</span>
		<div>
			<div class="name">${escapeHtml(label)}${highRisk.has(category) ? '<span class="tag risk">High risk</span>' : ""}</div>
			<div class="desc">${escapeHtml(description)}</div>
			<div class="modules mono">${escapeHtml(modules.join(", "))}</div>
		</div>
	</div>
	<div class="seg${url !== undefined ? "" : " two"}" role="radiogroup" aria-label="${escapeHtml(label)}">
		<label><input type="radio" name="r${i}" value="deny">Deny</label>
		<label><input type="radio" name="r${i}" value="allow">This version</label>
		${updates}
	</div>
</div>`;
		})
		.join("\n");

	const allowed = kept.filter(({ answer }) => answer !== "deny");
	const keptSummary =
		allowed.length === kept.length
			? `${kept.length} already allowed${kept.every(({ answer }) => answer === "allowUpdates") ? '<span class="muted"> · all versions</span>' : ""}`
			: `${kept.length} already answered`;
	const keptHtml =
		kept.length === 0
			? ""
			: `<details class="kept"><summary>${icon(icons.check, "icon ok")}<span>${keptSummary}</span>${icon(icons.chevron, "icon chevron")}</summary><ul>${kept
					.map(({ category, answer }) => `<li>${escapeHtml(categoryInfo(category).label)} <span class="muted">${keptText[answer]}</span></li>`)
					.join("")}</ul></details>`;

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
.tag.risk { background:#3b1215; color:#f87171; padding:2px 7px; margin-left:10px; font-size:11px; vertical-align:middle; }
.rows { flex:1 1 auto; min-height:120px; overflow-y:auto; display:flex; flex-direction:column; gap:12px; padding-right:2px; }
.rows > * { flex:none; }
.row { background:#161616; border-radius:6px; padding:16px; }
.what { display:flex; gap:14px; }
.cat-icon { color:#a1a1aa; margin-top:1px; }
.cat-icon .icon { width:24px; height:24px; }
.cat-icon.high { color:#f87171; }
.name { font-size:17px; font-weight:700; }
.desc { color:#b4b4bb; margin-top:6px; line-height:1.45; }
.modules { color:#71717a; font-size:12px; margin-top:8px; }
.seg { display:grid; grid-template-columns:repeat(3,1fr); gap:4px; margin-top:14px; background:#0a0a0a; border:1px solid #2a2a2a; border-radius:6px; padding:3px; }
.seg.two { grid-template-columns:repeat(2,1fr); }
.seg label { position:relative; text-align:center; padding:8px 6px; border-radius:3px; color:#a1a1aa; font-weight:600; cursor:pointer; white-space:nowrap; }
.seg label:hover { color:#fff; }
.seg input { position:absolute; opacity:0; pointer-events:none; }
.seg label:has(input:checked) { background:#f4f4f5; color:#0a0a0a; }
.seg label.risky { color:#f87171; }
.seg label.risky:has(input:checked) { background:#dc2626; color:#fff; }
.seg label:has(input:focus-visible) { outline:2px solid #5eead4; outline-offset:1px; }
.kept { color:#d4d4d8; }
.kept summary { list-style:none; display:flex; align-items:center; gap:10px; padding:8px 4px; cursor:pointer; font-size:15px; }
.kept summary::-webkit-details-marker { display:none; }
.kept .ok { color:#5eead4; }
.kept .chevron { margin-left:auto; color:#8b8b93; transition:transform .15s; }
.kept[open] .chevron { transform:rotate(180deg); }
.kept ul { list-style:none; padding:0 4px 6px 32px; font-size:13px; line-height:1.8; }
.warn { display:flex; gap:10px; border-top:1px solid #27272a; margin-top:12px; padding-top:14px; color:#a1a1aa; line-height:1.5; }
.warn .icon { color:#facc15; margin-top:1px; }
.warn b { color:#f4f4f5; }
.help { font-size:12px; color:#71717a; margin-top:4px; }
.actions { display:flex; justify-content:flex-end; gap:10px; margin-top:16px; }
.pill { padding:10px 20px; border-radius:6px; font-size:15px; font-weight:700; }
.pill.dark { background:#2a2a2a; color:#f4f4f5; }
.pill.dark:hover { background:#353535; }
.pill.light { background:#f4f4f5; color:#0a0a0a; }
.pill.red { background:#dc2626; color:#fff; }
.pill:disabled { background:#1c1c1c; color:#52525b; cursor:default; }
#confirm { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.78); align-items:center; justify-content:center; padding:24px; }
#confirm.open { display:flex; }
#confirm .box { background:#1a0f10; border:1px solid #7f1d1d; border-radius:8px; padding:20px 22px; color:#e4e4e7; line-height:1.5; max-width:500px; }
#confirm h3 { color:#f87171; font-size:18px; margin-bottom:10px; }
#confirm .actions { margin-top:18px; }
</style>
</head>
<body>
<div id="main" style="display:flex; flex-direction:column; flex:1 1 auto; min-height:0">
<header>
	<span class="plug">${icon(icons.plug)}</span>
	<div class="titles">
		<div class="eyebrow">Plugin permission</div>
		<h1>${escapeHtml(plugin)}</h1>
		<div class="sub">${by}${wants}</div>
	</div>
	<button class="x" id="close" title="Close: answers nothing, you will be asked again next time">${icon(icons.close)}</button>
</header>
<div class="chips">${chips}</div>
<div class="rows">${rowsHtml}${keptHtml}</div>
<div class="warn">${icon(icons.warning)}<div>
	Allowed native code can get <b>full system access</b>. Only allow what you trust this plugin with.
	<div class="help">This version: until an update changes this file.${url !== undefined ? " All versions: also later updates from this source." : ""} Until the plugin is reinstalled; revoke any time in Luna Settings.</div>
</div></div>
<div class="actions"><button class="pill dark" id="deny-all">Deny all</button><button class="pill light" id="validate" disabled>Continue</button></div>
</div>
<div id="confirm"><div class="box">
	<h3>Allow <span id="confirm-what"></span> for all versions?</h3>
	<div>${escapeHtml(ALL_VERSIONS_WARNING)}</div>
	<div class="actions"><button class="pill dark" id="confirm-no">Cancel</button><button class="pill red" id="confirm-yes">Allow all versions</button></div>
</div></div>
<script>
const count = ${rows.length};
const labels = ${JSON.stringify(rows.map(({ category }) => categoryInfo(category).label)).replace(/</g, "\\u003c")};
const validate = document.getElementById("validate");
const confirmBox = document.getElementById("confirm");
const main = document.getElementById("main");
const submit = (chosen) => (document.title = "${SUBMIT}" + JSON.stringify(chosen));
// "All versions" counts only for rows where it was confirmed: Cancel puts back the row's previous choice
let pendingRisky;
const confirmed = new Set();
const previous = new Map();
const closeConfirm = (keep) => {
	if (keep) confirmed.add(pendingRisky.name);
	else {
		pendingRisky.checked = false;
		const before = previous.get(pendingRisky.name);
		if (before !== undefined) before.checked = true;
	}
	const row = pendingRisky;
	pendingRisky = undefined;
	confirmBox.classList.remove("open");
	main.inert = false;
	validate.disabled = answers() === undefined;
	// Back to the row, not to the hidden button
	(keep ? row : (previous.get(row.name) ?? row)).focus();
};
document.addEventListener("change", (event) => {
	const input = event.target;
	if (input.value !== "allowUpdates") {
		confirmed.delete(input.name);
		previous.set(input.name, input);
	} else if (!confirmed.has(input.name)) {
		pendingRisky = input;
		document.getElementById("confirm-what").textContent = labels[Number(input.name.slice(1))];
		confirmBox.classList.add("open");
		// Nothing behind it can be changed or validated until it is answered
		main.inert = true;
		document.getElementById("confirm-no").focus();
	}
}, true);
document.getElementById("confirm-yes").addEventListener("click", () => closeConfirm(true));
document.getElementById("confirm-no").addEventListener("click", () => closeConfirm(false));
document.addEventListener("keydown", (event) => event.key === "Escape" && pendingRisky !== undefined && closeConfirm(false));
const answers = () => {
	const chosen = [];
	for (let i = 0; i < count; i++) {
		const input = document.querySelector('input[name="r' + i + '"]:checked');
		if (input === null) return undefined;
		chosen.push(input.value);
	}
	return chosen;
};
document.addEventListener("change", () => (validate.disabled = answers() === undefined));
validate.addEventListener("click", () => {
	const chosen = answers();
	if (pendingRisky !== undefined || chosen?.some((answer, i) => answer === "allowUpdates" && !confirmed.has("r" + i))) return;
	if (chosen !== undefined) submit(chosen);
});
document.getElementById("deny-all").addEventListener("click", () => pendingRisky === undefined && submit(Array(count).fill("deny")));
document.getElementById("close").addEventListener("click", () => window.close());
// Main fits the window to the opened or closed list (the title must change to be seen)
document.querySelector("details.kept")?.addEventListener("toggle", () => (document.title = "${FIT}" + Date.now()));
</script>
</body>
</html>`;
};

const MIN_HEIGHT = 320;
const MAX_HEIGHT = 860;
// Height the page needs with every row in view: the body's padding plus each block, the rows at their full height
const MEASURE = `(() => {
	const body = getComputedStyle(document.body);
	let height = parseFloat(body.paddingTop) + parseFloat(body.paddingBottom);
	for (const el of document.getElementById("main").children) {
		const style = getComputedStyle(el);
		// The rows box fills or scrolls whatever height it gets: measure what is in it
		const kids = el.classList.contains("rows") ? el.children : [];
		const blockHeight = kids.length > 0 ? kids[kids.length - 1].getBoundingClientRect().bottom - kids[0].getBoundingClientRect().top : el.getBoundingClientRect().height;
		height += blockHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
	}
	return Math.ceil(height);
})()`;

const answerValues = new Set<string>(["deny", "allow", "allowUpdates"]);

// One window at a time: several native files can load at once
let queue: Promise<unknown> = Promise.resolve();

/**
 * Shows one window for all rows and resolves with an answer per row, in order, or undefined if it was closed.
 * A window of its own (own session, no preload), so the TIDAL page and its plugins cannot see or click it.
 */
export const askPermissions = (request: PermissionRequest, parent?: BrowserWindow): Promise<PermissionAnswer[] | undefined> => {
	const ask = () =>
		new Promise<PermissionAnswer[] | undefined>((resolve) => {
			// Not owned by a minimized or hidden TIDAL window: it would be hidden with it, and the plugin would wait unseen
			const owner = parent !== undefined && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized() ? parent : undefined;
			const win = new BrowserWindow({
				parent: owner,
				modal: owner !== undefined,
				width: 620,
				// Rows scroll past this, the buttons stay in view
				height: Math.min(380 + request.rows.length * 190 + (request.kept.length > 0 ? 50 : 0), 900),
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
			// Fits the window to its content (up to MAX_HEIGHT, past it the rows scroll), so a short request has no scrollbar
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
			let answered: PermissionAnswer[] | undefined;
			win.webContents.on("page-title-updated", (event, title) => {
				// The list of earlier answers was opened or closed: only a size to fit, nothing else is read from it
				if (title.startsWith(FIT)) {
					event.preventDefault();
					void fit(false);
					return;
				}
				if (!title.startsWith(SUBMIT)) return;
				event.preventDefault();
				try {
					const chosen = JSON.parse(title.slice(SUBMIT.length));
					const valid =
						Array.isArray(chosen) &&
						chosen.length === request.rows.length &&
						chosen.every((answer) => answerValues.has(answer) && (answer !== "allowUpdates" || request.url !== undefined));
					if (valid) answered = chosen;
				} catch {}
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
	const result = queue.then(ask, ask);
	queue = result;
	return result;
};
