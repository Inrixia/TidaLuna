import { observe, registerEmitter, type AddReceiver } from "@inrixia/helpers";
import { intercept } from "../intercept";
import { llTrace } from "./Tracer";

type ExtendedElem = Element & { addButton: (text: string, onClick: (this: GlobalEventHandlers, ev: MouseEvent) => unknown) => HTMLSpanElement };
export class ContextMenu {
	private static async getContextMenu() {
		const contextMenu = await observe.promise<ExtendedElem>(`[data-type="list-container__context-menu"]`, 1000);
		if (contextMenu !== null) {
			contextMenu.addButton = (text, onClick) => {
				const newButton = <Element>contextMenu.children[0].cloneNode(true);
				newButton.querySelector<HTMLAnchorElement>("a").href = "";
				const span = newButton.querySelector<HTMLSpanElement>("span")!;
				span.innerText = text;
				span.onclick = onClick;
				contextMenu.appendChild(newButton);
				return span;
			};
		}
		return contextMenu;
	}

	public static onOpen: AddReceiver<{ event: unknown; contextMenu: ExtendedElem }> = registerEmitter((onOpen) =>
		// setTimeout to get around intial window.luna loading, icky
		setTimeout(() =>
			intercept("contextMenu/OPEN", async (event) => {
				const contextMenu = await ContextMenu.getContextMenu();
				if (contextMenu === null) return;
				onOpen({ event, contextMenu }, llTrace.err.withContext("ContextMenu.onOpen", event.type, contextMenu));
			}),
		),
	);
}
