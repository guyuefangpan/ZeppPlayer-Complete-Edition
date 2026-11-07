/*
    Captures the current simulated screen (the #display canvas) as a PNG,
    asks the desktop shell to write it to disk and copies it to the clipboard.
    The destination can be the user's Pictures folder or the active project.
*/

import I18n from "../zepp_player/i18n.js";
import { showToast } from "../zepp_player/zpToast.js";
import { isDesktopShell, isAndroidApp, triggerDownload } from "./ViewMode.js";
import { ChangesWatcher } from "./ChangesWatcher.js";

function pad(value) {
    return String(value).padStart(2, "0");
}

function stamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
        + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function copyCanvasToClipboard(canvas) {
    try {
        if (!navigator.clipboard || typeof ClipboardItem === "undefined") return false;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) return false;
        await navigator.clipboard.write([
            new ClipboardItem({"image/png": blob})
        ]);
        return true;
    } catch (e) {
        console.warn("Clipboard write failed", e);
        return false;
    }
}

export default class ScreenshotManager {
    static buildName(player, prefix) {
        const projectPath = (player && player.projectPath) || "";
        const project = projectPath.split("/").filter(Boolean).pop() || "zepp";
        const profile = (player && player.profileName) || "device";
        const head = prefix || project;
        return `${head}_${profile}_${stamp()}.png`;
    }

    /**
     * Grab the canvas the user currently sees (already rotated and framed
     * the same way as the window) and hand the PNG to the main process.
     * @param {object} player
     * @param {{dest?: "pictures"|"project"}} options
     * @returns {Promise<string>} absolute path of the saved file
     */
    static async capture(player, options = {}) {
        const display = document.getElementById("display");
        if (!display || !display.width || !display.height) {
            throw new Error(I18n.t("dialog.screenshotFailed", "Failed to save preview"));
        }

        const canvas = document.createElement("canvas");
        canvas.width = display.width;
        canvas.height = display.height;
        canvas.getContext("2d").drawImage(display, 0, 0);

        // On a phone the project folder is app-private and cannot be browsed,
        // so every screenshot goes to the gallery instead.
        const toProject = options.dest === "project" && !isAndroidApp();
        const fileName = ScreenshotManager.buildName(player, toProject ? "screenshot" : null);

        // A plain browser on a phone has no access to a native shell, so the
        // PNG is downloaded. The APK and the Electron shell save it through
        // their own file APIs instead.
        if (!isDesktopShell() && !isAndroidApp()) {
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
            if (!blob) throw new Error(I18n.t("dialog.screenshotFailed", "Failed to save preview"));
            const url = URL.createObjectURL(blob);
            triggerDownload(url, fileName);
            setTimeout(() => URL.revokeObjectURL(url), 8000);
            ScreenshotManager.lastCopied = await copyCanvasToClipboard(canvas);
            return fileName;
        }

        const resp = await fetch("/api/save_preview", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                dataUrl: canvas.toDataURL("image/png"),
                name: fileName,
                dest: toProject ? "project" : "pictures",
                projectUrl: player && player.projectPath ? player.projectPath : "",
            }),
        });

        let data = null;
        try {
            data = await resp.json();
        } catch (e) {}

        if (!resp.ok || !data || !data.ok) {
            throw new Error((data && data.msg) || ("HTTP " + resp.status));
        }

        // Writing into the project folder looks like an external edit to the
        // file watcher; holding it prevents a pointless restart right after
        // the screenshot is taken.
        if (toProject) ChangesWatcher.hold(3000);

        const copied = await copyCanvasToClipboard(canvas);
        ScreenshotManager.lastCopied = copied;
        return data.path;
    }

    static async captureAndNotify(player, options = {}) {
        try {
            const savedPath = await ScreenshotManager.capture(player, options);
            const copied = ScreenshotManager.lastCopied;
            const head = isAndroidApp()
                ? I18n.t("dialog.screenshotGallery", "Saved to gallery")
                : (isDesktopShell()
                    ? I18n.t("dialog.screenshotSaved", "Preview saved to")
                    : I18n.t("dialog.screenshotDownloaded", "Preview downloaded as"));
            let message = head + " " + savedPath;
            if (copied) message += " · " + I18n.t("dialog.screenshotCopied", "copied to clipboard");
            showToast(message, false);
            console.log("[ZeppPlayer] preview saved:", savedPath, "clipboard:", copied);
            return savedPath;
        } catch (e) {
            const msg = I18n.t("dialog.screenshotFailed", "Failed to save preview")
                + ": " + (e && e.message || e);
            console.error(msg, e);
            showToast(msg, true);
            return null;
        }
    }
}
