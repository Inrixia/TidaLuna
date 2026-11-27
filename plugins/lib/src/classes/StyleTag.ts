import type { LunaUnloads } from "@luna/core";

export class StyleTag {
	public readonly styleTag: HTMLElement;
	constructor(
		public readonly id: string,
		unloads: LunaUnloads,
		private _css?: string,
	) {
		this.styleTag = (id ? document.getElementById(id) : this.createElement()) ?? this.createElement();
		this.css = _css;
		unloads.add(this.remove.bind(this));
	}

	private createElement() {
		const styleTag = document.createElement("style");
		if (this.id) styleTag.id = this.id;
		return styleTag;
	}

	/**
	 * Remove style from document
	 */
	public remove() {
		this.styleTag.remove();
	}
	/**
	 * Add style to document
	 */
	public add() {
		document.head.appendChild(this.styleTag);
	}

	public get css() {
		return this._css;
	}
	public set css(css: string | undefined) {
		this._css = css?.trim();
		if (this._css === undefined || this._css === "") this.remove();
		else {
			// textContent, not innerHTML. Theme CSS is remote content, and innerHTML on this tag does parse markup: a payload
			// of `</style><img src=x onerror=...>` produced an <img> element in happy-dom, whose fragment parser does not
			// apply the rawtext rule for <style> that Chromium does. Whether that reaches HTML injection depends on the
			// engine, which is exactly why remote CSS is assigned as text and never parsed
			this.styleTag.textContent = this._css;
			if (!this.styleTag.isConnected) this.add();
		}
	}
}
