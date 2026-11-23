// For Luna's prompt pages (./window.ts, native/core/confirmPage.ts); no Electron, so it can be tested
export const escapeHtml = (text: string) =>
	text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
