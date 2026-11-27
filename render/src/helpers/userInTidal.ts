/** Resolves once TIDAL has the focus or the user clicks or types in it (some Linux window managers don't report focus) */
export const userInTidal = (target: Pick<Window, "addEventListener" | "removeEventListener"> = window, hasFocus = () => document.hasFocus()) =>
	new Promise<void>((resolve) => {
		if (hasFocus()) return resolve();
		const types = ["focus", "pointerdown", "keydown"];
		const done = (event: Event) => {
			// Focus of an element in the page is not TIDAL's window getting it
			if (event.type === "focus" && event.target !== target) return;
			for (const type of types) target.removeEventListener(type, done, true);
			resolve();
		};
		for (const type of types) target.addEventListener(type, done, true);
	});
