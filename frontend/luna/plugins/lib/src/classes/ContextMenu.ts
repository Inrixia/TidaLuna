import { registerEmitter, type AddReceiver } from "@inrixia/helpers";

import type { LunaUnloads, Tracer } from "@luna/core";

import { observePromise } from "../helpers";
import { libTrace, unloads } from "../index.safe";
import * as redux from "../redux";
import { Album } from "./Album";
import { MediaItems } from "./MediaItem";
import { Playlist } from "./Playlist";

type OnClick = (ev: MouseEvent) => any;

class ContextMenuButton {
	private _element?: HTMLSpanElement;
	public get elem() {
		return this._element;
	}
	public set elem(elem: HTMLSpanElement | undefined) {
		if (this._element !== undefined) this._element.remove();
		this._element = elem;
		if (this._element === undefined) return;
		this._element.innerText = this.text;
		this._element.onclick = (e) => {
			e.preventDefault();
			this._onClick?.(e);
		};
	}

	private _text?: string;
	public get text() {
		return this._text ?? "";
	}
	public set text(text: string) {
		if (this._element !== undefined) this._element.innerText = text;
		this._text = text;
	}

	public async show(contextMenu: Element | null) {
		if (!!contextMenu) {
			const templateButton = contextMenu.querySelector(`div[data-type="contextmenu-item"]`) as Element | undefined;
			const makeButton = () => {
				if (templateButton === undefined) throw new Error("No buttons to clone off contextMenu found!");
				const newButton = templateButton.cloneNode(true) as Element;
				newButton.querySelector<HTMLButtonElement>("button")!.removeAttribute("data-test");
				return newButton.querySelector<HTMLSpanElement>("span")!;
			};
			contextMenu.appendChild((this.elem ??= makeButton()).parentElement!.parentElement!);
		}
		return this.elem;
	}

	private _onClick?: OnClick;
	public onClick(cb: OnClick) {
		this._onClick = cb;
		if (this._element === undefined) return;
		this._element.onclick = (e) => {
			e.preventDefault();
			this._onClick?.(e);
		};
	}
}

export class ContextMenu {
	public static readonly trace: Tracer = libTrace.withSource(".ContextMenu").trace;

	private static readonly buttons: Set<ContextMenuButton> = new Set();
	public static addButton(unloads: LunaUnloads) {
		const button = new ContextMenuButton();
		this.buttons.add(button);
		unloads.add(() => {
			this.buttons.delete(button);
			button.elem?.remove();
		});
		return button;
	}

	/**
	 * Attempts to find the context menu element in the DOM with a 1s timeout.
	 * Will return null if the element is not found (usually means no context menu is open)
	 */
	public static async getCurrent() {
		return await observePromise<Element>(unloads, `[data-type="list-container__context-menu"]`, 1000);
	}

	/**
	 *  Called with `contextMenu` when a context menu is opened
	 */
	public static onOpen: AddReceiver<{ event: redux.ActionPayloads["contextMenu/OPEN"]; contextMenu: Element }> = registerEmitter((onOpen) => {
		redux.intercept("contextMenu/OPEN", unloads, async (event) => {
			const contextMenu = await ContextMenu.getCurrent();
			if (contextMenu === null) return;
			onOpen({ event, contextMenu }, ContextMenu.trace.msg.err.withContext(".onOpen", event.type, contextMenu));
		});
	});

	/**
	 * Called with `contextMenu` and a `mediaCollection` when a media item or media collection (album, playlist etc) context menu is opened
	 */
	public static onMediaItem: AddReceiver<{ mediaCollection: MediaItems | Album | Playlist; contextMenu: Element }> = registerEmitter(
		(onMediaItem) => {
			redux.intercept(`contextMenu/OPEN_MEDIA_ITEM`, unloads, async (item) => {
				const contextMenu = await ContextMenu.getCurrent();
				if (contextMenu === null) return;
				onMediaItem(
					{ mediaCollection: MediaItems.fromIds([item.id]), contextMenu },
					ContextMenu.trace.err.withContext("onMediaItem.OPEN_MEDIA_ITEM", contextMenu),
				);
			});
			redux.intercept(`contextMenu/OPEN_MULTI_MEDIA_ITEM`, unloads, async (items) => {
				const contextMenu = await ContextMenu.getCurrent();
				if (contextMenu === null) return;
				onMediaItem(
					{ mediaCollection: MediaItems.fromIds(items.ids), contextMenu },
					ContextMenu.trace.err.withContext("onMediaItem.OPEN_MULTI_MEDIA_ITEM", contextMenu),
				);
			});
			ContextMenu.onOpen(unloads, async ({ event, contextMenu }) => {
				switch (event.type) {
					case "ALBUM": {
						const album = await Album.fromId(event.id);
						if (album === undefined) return;
						onMediaItem({ mediaCollection: album, contextMenu }, ContextMenu.trace.err.withContext(event.type, contextMenu));
						break;
					}
					case "PLAYLIST": {
						const playlist = await Playlist.fromId(event.id);
						if (playlist === undefined) return;
						onMediaItem({ mediaCollection: playlist, contextMenu }, ContextMenu.trace.err.withContext(event.type, contextMenu));
						break;
					}
				}
			});
		},
	);
}
