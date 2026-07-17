import type { LunaUnloads } from "@luna/core";
import { redux } from "@luna/lib";

import { store as obyStore } from "oby";
import { createRoot, type Root } from "react-dom/client";

import { unloads } from "../index.safe";

export class Page {
	private static openPage?: Page;
	private static readonly pages: Record<string, Page> = {};
	public static register(name: string, unloads: LunaUnloads, component?: React.ReactNode) {
		return (this.pages[name] ??= new this(name, unloads, component));
	}

	public readonly root: HTMLDivElement;
	public readonly rootId;
	private reactRoot?: Root;

	public readonly pageStyles: CSSStyleDeclaration;

	private constructor(
		public readonly name: string,
		private readonly unloads: LunaUnloads,
		private readonly component?: React.ReactNode,
	) {
		this.rootId = `luna-page-${this.name}`;
		this.root = <HTMLDivElement>document.getElementById(this.rootId) ?? document.createElement("div");
		this.unloads.add(this.root.remove.bind(this.root));
		this.unloads.add(() => {
			delete Page.pages[this.name];
		});

		// Make styles a deeply reactive obyStore & set parentElement styles when it changes
		this.pageStyles = obyStore(<CSSStyleDeclaration>{});
		obyStore.on(this.pageStyles, () => {
			if (this.root.parentElement) {
				Object.assign(this.root.parentElement.style, obyStore.unwrap(this.pageStyles));
			}
		});

		// If we are already on the page on load then add it to the DOM
		// This is mostly to facilitate live reloading
		if (location.search === `?${this.name}`) this.addtoDOM();
	}

	private removeFromDOM() {
		// Reset the parentElement styles to default
		if (this.root.parentElement) this.root.parentElement.removeAttribute("style");
		this.root.remove();
		Page.openPage = undefined;
	}

	private addtoDOM() {
		const notFound = document.querySelector<HTMLElement>(`[class^="_pageNotFoundError_"]`);
		if (notFound) {
			notFound.style.display = "none";
			const mainContainer = notFound.parentElement;
			if (!mainContainer) return console.warn("Could not find _pageNotFound.parentElement");

			mainContainer.appendChild(this.root);
			mainContainer.removeAttribute("style");
			Object.assign(mainContainer!.style, this.pageStyles);
			Page.openPage = this;
			this.render();
		}
	}

	/**
	 * Creates the react root and renders the component
	 */
	public render() {
		if (this.component === undefined || this.reactRoot !== undefined) return;
		this.reactRoot = createRoot(this.root);
		this.unloads.add(this.reactRoot.unmount.bind(this.reactRoot));
		this.reactRoot.render(this.component);
	}

	static {
		redux.intercept("router/NAVIGATED", unloads, (payload) => {
			// payload.search = `?name`
			const pageName = payload.search.slice(1);
			if (pageName === Page.openPage?.name) return; // Already on this page

			// Remove the current page from the DOM
			Page.openPage?.removeFromDOM();

			// If we are navigating to a page that exists, add it to the DOM
			if (pageName in this.pages) {
				const page = this.pages[pageName];
				setTimeout(page.addtoDOM.bind(page));
			}
		});
	}

	open() {
		redux.actions["router/PUSH"]({
			pathname: "/not-found",
			search: this.name,
			replace: true,
		});
	}
}
