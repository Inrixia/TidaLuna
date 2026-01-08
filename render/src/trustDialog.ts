
// trustDialog.ts - Handles the Trust Request modal

export const initTrustDialog = () => {
    __ipcRenderer.on("__Luna.requestTrust", (_, pluginName: string, hash: string, timestamp: number) => {
        // Check if a dialog is already open
        if (document.getElementById("luna-trust-dialog")) return;

        // Create styles
        const style = document.createElement("style");
        style.id = "luna-trust-styles";
        style.textContent = `
            #luna-trust-overlay {
                position: fixed;
                top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0, 0, 0, 0.85);
                backdrop-filter: blur(5px);
                z-index: 999999;
                display: flex;
                align-items: center;
                justify-content: center;
                font-family: 'Inter', system-ui, sans-serif;
                color: white;
                opacity: 0;
                transition: opacity 0.3s ease;
            }
            #luna-trust-overlay.visible {
                opacity: 1;
            }
            #luna-trust-dialog {
                background: linear-gradient(145deg, #1e1e1e, #252525);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 12px;
                padding: 32px;
                width: 440px;
                box-shadow: 0 20px 50px rgba(0,0,0,0.5);
                transform: scale(0.95);
                transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                display: flex;
                flex-direction: column;
                gap: 20px;
            }
            #luna-trust-overlay.visible #luna-trust-dialog {
                transform: scale(1);
            }
            .luna-trust-header {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            .luna-trust-icon {
                color: #ff4d4d;
                width: 24px;
                height: 24px;
            }
            .luna-trust-title {
                font-size: 20px;
                font-weight: 600;
                margin: 0;
            }
            .luna-trust-body {
                font-size: 15px;
                line-height: 1.5;
                color: #ccc;
            }
            .luna-trust-plugin {
                background: rgba(255,255,255,0.05);
                padding: 8px 12px;
                border-radius: 6px;
                font-family: monospace;
                color: #fff;
                margin-top: 8px;
                display: block;
            }
            .luna-trust-actions {
                display: grid;
                grid-template-columns: 1fr 1fr 1.2fr;
                gap: 12px;
                margin-top: 10px;
            }
            .luna-btn {
                border: none;
                border-radius: 6px;
                padding: 10px 0;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
            }
            .luna-btn:hover {
                filter: brightness(1.2);
            }
            .luna-btn:active {
                transform: scale(0.98);
            }
            .luna-btn-block {
                background: rgba(255, 77, 77, 0.1);
                color: #ff4d4d;
                border: 1px solid rgba(255, 77, 77, 0.2);
            }
            .luna-btn-once {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
            }
            .luna-btn-trust {
                background: #00E0E0; /* Tidal Cyan roughly */
                color: #000;
                font-weight: 600;
            }
        `;
        document.head.appendChild(style);

        // Create overlay
        const overlay = document.createElement("div");
        overlay.id = "luna-trust-overlay";
        overlay.innerHTML = `
            <div id="luna-trust-dialog">
                <div class="luna-trust-header">
                    <svg class="luna-trust-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <h2 class="luna-trust-title">Security Warning</h2>
                </div>
                <div class="luna-trust-body">
                    A plugin attempts to execute native code.
                    <span class="luna-trust-plugin">${pluginName}</span>
                    <br>
                    This allows the plugin full access to your computer. Only allow if you trust the author.
                </div>
                <div class="luna-trust-actions">
                    <button class="luna-btn luna-btn-block" id="luna-btn-block">Block</button>
                    <button class="luna-btn luna-btn-once" id="luna-btn-once">Allow Once</button>
                    <button class="luna-btn luna-btn-trust" id="luna-btn-trust">Always Allow</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // Animate in
        requestAnimationFrame(() => overlay.classList.add("visible"));

        const close = (responseCode: number) => {
            overlay.classList.remove("visible");
            setTimeout(() => {
                overlay.remove();
                style.remove();
                __ipcRenderer.send(`__Luna.trustResponse:${hash}:${timestamp}`, responseCode);
            }, 300);
        };

        document.getElementById("luna-btn-block")?.addEventListener("click", () => close(0)); // Block
        document.getElementById("luna-btn-once")?.addEventListener("click", () => close(1)); // Once
        document.getElementById("luna-btn-trust")?.addEventListener("click", () => close(2)); // Always
    });
};
