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

const keptText: Record<PermissionAnswer, string> = {
	allow: "allowed",
	allowUpdates: "allowed, also for updates",
	deny: "denied",
};

const buildHtml = ({ fileName, url, claimedUrl, rows, kept }: PermissionRequest) => {
	// "DiscordRPC/discord.native.ts" -> plugin "DiscordRPC", file "discord.native.ts"
	const slash = fileName.lastIndexOf("/");
	const plugin = slash === -1 ? fileName : fileName.slice(0, slash);
	const file = slash === -1 ? undefined : fileName.slice(slash + 1);

	const source =
		url !== undefined
			? `<div><span class="label">Source: </span><span class="url">${escapeHtml(url)}</span></div>`
			: `<div><span class="label">Source: </span><span class="bad url">${claimedUrl !== undefined ? `${escapeHtml(claimedUrl)} (could not be checked)` : "unknown"}</span></div>`;

	const rowsHtml = rows
		.map(({ category, modules }, i) => {
			const { label, description } = categoryInfo(category);
			const updates =
				url !== undefined
					? `<label title="Also allow future versions from this source"><input type="radio" name="r${i}" value="allowUpdates"> Allow, also for updates</label>`
					: "";
			return `<div class="row">
	<div class="what"><div class="name">${escapeHtml(label)}</div><div class="desc">${escapeHtml(description)}</div><div class="modules">${escapeHtml(modules.join(", "))}</div></div>
	<div class="choices">
		<label><input type="radio" name="r${i}" value="deny"> Deny</label>
		<label><input type="radio" name="r${i}" value="allow"> Allow</label>
		${updates}
	</div>
</div>`;
		})
		.join("\n");

	const keptHtml =
		kept.length === 0
			? ""
			: `<div class="info">Kept from earlier answers: ${kept.map(({ category, answer }) => `${escapeHtml(categoryInfo(category).label)} (${keptText[answer]})`).join(", ")}</div>`;

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Plugin Permission Request</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html, body { height:100%; }
body { background:#1a1a1a; color:#fff; font-family:system-ui,sans-serif; padding:20px 24px; user-select:none; display:flex; flex-direction:column; }
h2 { font-size:16px; margin-bottom:12px; }
.info { background:#222; padding:10px 14px; border-radius:4px; font-size:13px; color:#ccc; line-height:1.6; margin-bottom:12px; }
.url { word-break:break-all; }
.rows { flex:1 1 auto; min-height:80px; overflow-y:auto; }
.label { color:#999; }
.value { color:#fff; font-weight:600; }
.bad { color:#f0a040; }
.row { display:flex; align-items:center; gap:12px; background:#222; padding:8px 14px; border-radius:4px; margin-bottom:6px; font-size:13px; color:#ccc; }
.row .what { flex:1; }
.row .name { color:#eb1e32; font-weight:600; }
.row .desc { color:#999; font-size:12px; }
.row .modules { color:#777; font-size:11px; font-family:monospace; }
.choices { display:flex; flex-direction:column; gap:2px; }
.choices label { white-space:nowrap; cursor:pointer; }
.warn { background:#222; padding:10px 14px; border-radius:4px; font-size:12px; color:#999; line-height:1.5; margin:12px 0; }
.warn ul { margin:4px 0 0 16px; }
.actions { display:flex; justify-content:flex-end; }
button { padding:8px 16px; border:none; border-radius:4px; background:#eb1e32; color:#fff; cursor:pointer; font-size:13px; }
button:disabled { background:#333; color:#777; cursor:default; }
</style>
</head>
<body>
<h2>Plugin Permission Request</h2>
<div class="info">
	<div><span class="label">Plugin: </span><span class="value">${escapeHtml(plugin)}</span></div>
	${file !== undefined ? `<div><span class="label">File: </span><span>${escapeHtml(file)}</span></div>` : ""}
	${source}
</div>
${keptHtml}
<div class="rows">${rowsHtml}</div>
<div class="warn">
	Only allow what you trust this plugin with. Allowed native code may get FULL SYSTEM ACCESS.
	<ul>
		<li>Allow: until an update changes this file, or the plugin is reinstalled</li>
		${url !== undefined ? "<li>Allow, also for updates: until the plugin is reinstalled</li>" : ""}
		<li>Deny: until the plugin is reinstalled</li>
	</ul>
	<div style="margin-top:6px">Answers can be revoked in Luna Settings. Closing this window answers nothing: you will be asked again next time.</div>
</div>
<div class="actions"><button id="validate" disabled>Validate</button></div>
<script>
const count = ${rows.length};
const validate = document.getElementById("validate");
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
	if (chosen !== undefined) document.title = "${SUBMIT}" + JSON.stringify(chosen);
});
</script>
</body>
</html>`;
};

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
			const win = new BrowserWindow({
				parent: parent?.isDestroyed() === false ? parent : undefined,
				modal: parent?.isDestroyed() === false,
				width: 640,
				// Rows scroll past this, Validate stays in view
				height: Math.min(420 + request.rows.length * 100 + (request.kept.length > 0 ? 80 : 0), 900),
				resizable: true,
				minimizable: false,
				maximizable: false,
				fullscreenable: false,
				autoHideMenuBar: true,
				backgroundColor: "#1a1a1a",
				title: "Plugin Permission Request",
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
			let answered: PermissionAnswer[] | undefined;
			win.webContents.on("page-title-updated", (event, title) => {
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
			win.once("ready-to-show", () => win.show());
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
