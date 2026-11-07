/*
 * Responsive view-mode detection.
 *
 * The desktop layout is a four column row; phones need a stacked (portrait)
 * or compact (landscape) arrangement. Instead of relying on media queries
 * only, the mode is computed in JS and written to body classes so the CSS and
 * the JS (file import/export, screenshots) can agree on the current mode.
 *
 * `?zp_view=portrait|landscape|desktop` forces a mode, which is handy for
 * previewing both orientations without a real phone.
 */

const MOBILE_MAX_WIDTH = 900;

const FORCED = ["portrait", "landscape", "desktop"];

export function detectViewMode() {
    try {
        const forced = new URLSearchParams(window.location.search).get("zp_view");
        if (FORCED.indexOf(forced) > -1) return forced;
    } catch (e) {}

    // Some Android WebViews lay the page out at a desktop-like width even
    // when the viewport meta says width=device-width, which silently turns
    // every phone rule off. The screen size is the reliable number there.
    const w = Math.min(window.innerWidth || 0, (window.screen && window.screen.width) || 9999);
    const h = window.innerHeight || 0;

    if (isAndroidApp()) return w < h ? "portrait" : "landscape";
    if (w <= MOBILE_MAX_WIDTH) return w < h ? "portrait" : "landscape";
    return "desktop";
}

export function applyViewMode() {
    const mode = detectViewMode();
    const body = document.body;
    if (!body) return mode;

    body.classList.toggle("zp-mobile", mode !== "desktop");
    body.classList.toggle("zp-portrait", mode === "portrait");
    body.classList.toggle("zp-landscape", mode === "landscape");
    body.setAttribute("data-zp-view", mode);

    // Used by the CSS as a fallback for browsers without dvh support.
    const vh = window.innerHeight || 0;
    document.documentElement.style.setProperty("--zp-vh", vh + "px");

    // Height left for the content area once the toolbar and the footer are
    // measured; the landscape grid uses it to keep every panel on screen.
    const top = document.getElementById("toolbar_top");
    const footer = document.getElementById("version_box");
    const chrome = (top ? top.offsetHeight : 0) + (footer ? footer.offsetHeight : 0) + 16;
    document.documentElement.style.setProperty("--zp-content-h", Math.max(180, vh - chrome) + "px");
    return mode;
}

export function initViewMode() {
    applyViewMode();

    let timer = null;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(applyViewMode, 120);
    };

    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", () => setTimeout(applyViewMode, 250));
    if (window.visualViewport) window.visualViewport.addEventListener("resize", schedule);
}

export function isMobileView() {
    return !!document.body && document.body.classList.contains("zp-mobile");
}

/* True inside the Electron shell (preload bridge available). */
export function isDesktopShell() {
    return !!(window.zpDesktop && window.zpDesktop.getPathForFile);
}

/* True inside the Android APK (the WebView exposes a native bridge). */
export function isAndroidApp() {
    try {
        if (window.zpAndroid && typeof window.zpAndroid.isAndroidApp === "function") {
            return !!window.zpAndroid.isAndroidApp();
        }
    } catch (e) {}
    return window.zpAndroidApp === true;
}

/* Downloads a blob/URL directly from the browser, used on phones where the
 * desktop shell's native dialogs are not reachable. */
export function triggerDownload(href, filename) {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename || "";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 0);
}
