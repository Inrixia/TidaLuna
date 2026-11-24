// The page side of Luna's prompt windows (NativeConfirm.ts): what every prompt page has, without Electron so it can be tested.
// The page talks to main only by its title (see NativeConfirm.ts): it has no preload and no IPC.

export const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** Title prefix of an answer: `submit(answer)` in the page */
export const SUBMIT = "luna-confirm:";
/**
 * Title prefix of a click that doesn't answer (`note(what)` in the page: open a link, fit the window), then `#<count>` so
 * the same click twice changes the title
 */
export const NOTE = "luna-confirm-note:";
/** Note that asks main to fit the window to the page again (a list opened, say) */
export const FIT = "fit";

/**
 * A prompt page: a static page with a strict CSP (no network, only its own inline style and script). Buttons with
 * `data-arm` start disabled: main enables them a moment after the window shows or gets the focus back, and disables them
 * while it has lost it (see NativeConfirm.ts), so a click meant for another window can't answer.
 *
 * In the page's script: `submit(answer)` answers and closes the window, `note(what)` tells main of a click that doesn't answer.
 */
export const promptPage = ({ title, style, body, script }: { title: string; style: string; body: string; script: string }) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
:root { color-scheme:dark; }
body { background:#0a0a0a; color:#f4f4f5; font-family:system-ui,"Segoe UI",sans-serif; font-size:14px; padding:24px 28px 22px; user-select:none; }
.eyebrow { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:#8b8b93; font-weight:600; }
button { font:inherit; border:none; cursor:pointer; }
button[data-arm]:disabled { opacity:.4; cursor:default; }
:focus-visible { outline:2px solid #5eead4; outline-offset:2px; }
${style}
</style>
</head>
<body>
${body}
<script>
const submit = (answer) => (document.title = "${SUBMIT}" + answer);
let notes = 0;
const note = (what) => (document.title = "${NOTE}" + what + "#" + ++notes);
for (const button of document.querySelectorAll("button[data-arm]")) button.disabled = true;
window.arm = (armed) => {
	for (const button of document.querySelectorAll("button[data-arm]")) button.disabled = !armed;
};
${script}
</script>
</body>
</html>`;
