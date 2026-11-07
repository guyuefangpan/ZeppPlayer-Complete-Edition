/*
    DOM-based replacements for window.prompt() / window.confirm().
    Electron's renderer does not support prompt(), and confirm() is
    unreliable, so dialogs are rendered as an overlay instead.
*/

import I18n from "./i18n.js";

const OVERLAY_ID = "zp-dialog-overlay";
const KEY_PREFIX = "zp_dialog_";

let busy = false;

function ensureStyles() {
    if (document.getElementById(KEY_PREFIX + "style")) return;
    const style = document.createElement("style");
    style.id = KEY_PREFIX + "style";
    style.textContent = `
#${OVERLAY_ID} {
    position: fixed; inset: 0; z-index: 99999;
    background: rgba(0,0,0,.55);
    display: flex; align-items: center; justify-content: center;
    font-family: Arial, Helvetica, sans-serif;
}
#${OVERLAY_ID} .zp-dialog {
    background: var(--panel, #333); color: var(--panel-text, #fff);
    border-radius: 10px; padding: 18px 20px; min-width: 320px; max-width: 70vw;
    box-shadow: 0 10px 40px rgba(0,0,0,.5);
}
#${OVERLAY_ID} .zp-dialog__text { margin: 0 0 14px; font-size: 14px; line-height: 1.5; }
#${OVERLAY_ID} input {
    width: 100%; box-sizing: border-box;
    background: var(--input, #444); color: var(--input-text, #fff);
    border: 1px solid var(--foreground, #666); border-radius: 6px;
    padding: 8px 10px; font-size: 14px; margin-bottom: 14px;
}
#${OVERLAY_ID} .zp-dialog__buttons { display: flex; gap: 10px; justify-content: flex-end; }
#${OVERLAY_ID} button {
    border: none; border-radius: 6px; padding: 8px 18px;
    font-size: 14px; cursor: pointer; color: #fff;
    background: var(--input, #555);
}
#${OVERLAY_ID} button.primary { background: var(--accent, #ff7043); }
`;
    document.head.appendChild(style);
}

function close() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.remove();
    busy = false;
}

/**
 * @param {string} message
 * @param {string} [defaultValue]
 * @returns {Promise<string|null>} input value, or null when cancelled
 */
export function zpPrompt(message, defaultValue) {
    return new Promise((resolve) => {
        if (busy) return resolve(null);
        busy = true;
        ensureStyles();

        const overlay = document.createElement("div");
        overlay.id = OVERLAY_ID;
        overlay.innerHTML = `
            <div class="zp-dialog">
                <p class="zp-dialog__text"></p>
                <input type="text" spellcheck="false" />
                <div class="zp-dialog__buttons">
                    <button data-act="cancel"></button>
                    <button data-act="ok" class="primary"></button>
                </div>
            </div>`;
        overlay.querySelector(".zp-dialog__text").textContent = message;
        const input = overlay.querySelector("input");
        input.value = defaultValue === undefined || defaultValue === null ? "" : String(defaultValue);
        const cancelBtn = overlay.querySelector('button[data-act="cancel"]');
        const okBtn = overlay.querySelector('button[data-act="ok"]');
        cancelBtn.textContent = I18n.t("dialog.cancel", "Cancel");
        okBtn.textContent = I18n.t("dialog.ok", "OK");

        const done = (result) => { close(); resolve(result); };
        okBtn.onclick = () => done(input.value);
        cancelBtn.onclick = () => done(null);
        overlay.onmousedown = (e) => { if (e.target === overlay) done(null); };
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); done(input.value); }
            else if (e.key === "Escape") { e.preventDefault(); done(null); }
        });

        document.body.appendChild(overlay);
        input.focus();
        input.select();
    });
}

/**
 * @param {string} message
 * @returns {Promise<void>} resolves when the dialog is closed
 */
export function zpAlert(message) {
    return new Promise((resolve) => {
        if (busy) return resolve();
        busy = true;
        ensureStyles();

        const overlay = document.createElement("div");
        overlay.id = OVERLAY_ID;
        overlay.innerHTML = `
            <div class="zp-dialog">
                <p class="zp-dialog__text"></p>
                <div class="zp-dialog__buttons">
                    <button data-act="ok" class="primary"></button>
                </div>
            </div>`;
        overlay.querySelector(".zp-dialog__text").textContent = message;
        const okBtn = overlay.querySelector('button[data-act="ok"]');
        okBtn.textContent = I18n.t("dialog.ok", "OK");

        const done = () => { close(); resolve(); };
        okBtn.onclick = done;
        overlay.onmousedown = (e) => { if (e.target === overlay) done(); };
        overlay.addEventListener("keydown", (e) => {
            if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); done(); }
        });

        document.body.appendChild(overlay);
        okBtn.focus();
    });
}

/**
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function zpConfirm(message) {
    return new Promise((resolve) => {
        if (busy) return resolve(false);
        busy = true;
        ensureStyles();

        const overlay = document.createElement("div");
        overlay.id = OVERLAY_ID;
        overlay.innerHTML = `
            <div class="zp-dialog">
                <p class="zp-dialog__text"></p>
                <div class="zp-dialog__buttons">
                    <button data-act="cancel"></button>
                    <button data-act="ok" class="primary"></button>
                </div>
            </div>`;
        overlay.querySelector(".zp-dialog__text").textContent = message;
        const cancelBtn = overlay.querySelector('button[data-act="cancel"]');
        const okBtn = overlay.querySelector('button[data-act="ok"]');
        cancelBtn.textContent = I18n.t("dialog.cancel", "Cancel");
        okBtn.textContent = I18n.t("dialog.ok", "OK");

        const done = (result) => { close(); resolve(result); };
        okBtn.onclick = () => done(true);
        cancelBtn.onclick = () => done(false);
        overlay.onmousedown = (e) => { if (e.target === overlay) done(false); };
        overlay.addEventListener("keydown", (e) => {
            if (e.key === "Escape") { e.preventDefault(); done(false); }
        });

        document.body.appendChild(overlay);
        okBtn.focus();
    });
}