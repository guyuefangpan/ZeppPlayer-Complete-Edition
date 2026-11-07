/*
    Small non-blocking toast used by screenshots and the console toolbar.
    Rendered above everything else but never captures pointer events.
*/

const TOAST_ID = "zp_toast";

function ensureStyles() {
    if (document.getElementById(TOAST_ID + "_style")) return;
    const style = document.createElement("style");
    style.id = TOAST_ID + "_style";
    style.textContent = `
#${TOAST_ID} {
    position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
    max-width: 70vw; z-index: 99999;
    background: var(--panel, #333); color: var(--panel-text, #fff);
    border-left: 4px solid var(--accent, #ff7043);
    border-radius: 8px; padding: 10px 16px;
    font-size: 13px; line-height: 1.5;
    box-shadow: 0 8px 24px rgba(0,0,0,.45);
    opacity: 0; transition: opacity .2s ease;
    pointer-events: none; word-break: break-all;
}
#${TOAST_ID}.error { border-left-color: #e5484d; }
#${TOAST_ID}.visible { opacity: 1; }
`;
    document.head.appendChild(style);
}

export function showToast(message, isError = false, duration = 2800) {
    ensureStyles();
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
        toast = document.createElement("div");
        toast.id = TOAST_ID;
        document.body.appendChild(toast);
    }
    toast.className = isError ? "error" : "";
    toast.textContent = message;

    // Force reflow so the fade-in transition runs on repeated calls.
    void toast.offsetWidth;
    toast.classList.add("visible");

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
        toast.classList.remove("visible");
    }, duration);
}
