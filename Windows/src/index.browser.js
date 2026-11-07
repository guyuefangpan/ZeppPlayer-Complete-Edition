/*
    ZeppPlayer - ZeppOS, mostly Mi Band 7, simulator for PC
    Copyright (C) 2022  MelianMiko

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import {ConsoleManager} from "./ui_managment/ConsoleManager.js";
import ExplorerManager from "./ui_managment/ExplorerManager.js";
import {ProjectPicker} from "./ui_managment/ProjectPicker.js";
import {ToolbarManager} from "./ui_managment/ToolbarManager.js";
import {initVersionUI} from "./ui_managment/Updater.js";
import {ChromeZeppPlayer} from "./zepp_player/ChromeZeppPlayer.js";
import {ChangesWatcher} from "./ui_managment/ChangesWatcher";
import {start as startNgUi} from "./ui_next/RootComponent";
import {PlayerSettingsLoader} from "./ui_next/PlayerSettingsLoader";
import { Buffer } from "buffer/";
import I18n from "./zepp_player/i18n.js";
import {zpAlert} from "./zepp_player/zpDialogs.js";
import {showToast} from "./zepp_player/zpToast.js";
import {initViewMode, isDesktopShell, isAndroidApp, isMobileView} from "./ui_managment/ViewMode.js";

const DISPLAY_FPS = 60;

/* Scale the watch canvas to the space a phone actually gives it. The canvas
 * keeps its native resolution, only its CSS size changes, so touch input is
 * mapped back by ChromeZeppPlayer._fetchCoordinates(). */
function fitDisplayCanvas() {
    const canvas = document.getElementById("display");
    if (!canvas || !canvas.width || !canvas.height) return;

    if (!isMobileView()) {
        canvas.style.width = "";
        canvas.style.height = "";
        return;
    }

    // Scale to the cell the canvas actually lives in: on a phone that is the
    // area below the console, so the watch always fits without page scrolling.
    const host = canvas.parentElement;
    const availW = Math.max(60, (host ? host.clientWidth : window.innerWidth) - 12);
    const availH = Math.max(60, (host && host.clientHeight > 40)
        ? host.clientHeight - 12
        : window.innerHeight * 0.35);

    let scale = Math.min(availW / canvas.width, availH / canvas.height, 3);
    if (!isFinite(scale) || scale <= 0) scale = 1;

    canvas.style.width = Math.round(canvas.width * scale) + "px";
    canvas.style.height = Math.round(canvas.height * scale) + "px";
}

const DISPLAY_DELTA = 1000 / DISPLAY_FPS;

window.Buffer = Buffer;

/* ===== Phone toolbar dropdowns =====
 * Phones collapse the panel buttons and the file buttons into one icon each.
 * The menu lives in viewport coordinates because the toolbar scrolls
 * sideways and would otherwise clip it. */
function closeToolbarSplits(exceptId) {
    const open = document.querySelectorAll(".zp-split.open");
    for (const el of open) {
        if (el.id !== exceptId) el.classList.remove("open");
    }
}

function positionSplitMenu(root) {
    const toggle = root.querySelector(".zp-split__toggle");
    const menu = root.querySelector(".zp-split__menu");
    if (!toggle || !menu) return;

    const rect = toggle.getBoundingClientRect();
    const width = menu.offsetWidth || 150;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);

    menu.style.top = Math.round(rect.bottom + 4) + "px";
    menu.style.left = Math.round(Math.min(Math.max(8, rect.left), maxLeft)) + "px";
}

window.zpSplitToggle = (kind) => {
    const root = document.getElementById("zp_split_" + kind);
    if (!root) return;
    const open = !root.classList.contains("open");
    closeToolbarSplits(open ? root.id : null);
    root.classList.toggle("open", open);
    if (open) positionSplitMenu(root);
};

window.zpSplitPanel = (panelId) => {
    closeToolbarSplits(null);
    window.zpPanelTab(panelId, null);
};

window.zpSplitCode = () => {
    closeToolbarSplits(null);
    window.zpOpenCode();
};

window.zpSplitFile = (kind) => {
    closeToolbarSplits(null);
    if (kind === "import") window.zpImportProject();
    else if (kind === "export") window.zpExportProject();
    else if (kind === "folder") window.zpOpenProjects();
};

/* ===== Phone sidebar dropdown =====
 * Record and screenshot share one icon in the 40px wide icon bar. The menu
 * unfolds to the right of the bar, positioned in viewport coordinates so the
 * scrolling sidebar cannot clip it. */
function closeSideSplits(exceptId) {
    const open = document.querySelectorAll(".zp-side-split.open");
    for (const el of open) {
        if (el.id !== exceptId) el.classList.remove("open");
    }
}

window.zpSideSplitToggle = () => {
    const root = document.getElementById("zp_split_capture");
    if (!root) return;
    const open = !root.classList.contains("open");
    closeToolbarSplits(null);
    closeSideSplits(open ? root.id : null);
    root.classList.toggle("open", open);
    if (!open) return;

    const toggle = root.querySelector(".zp-side-split__toggle");
    const menu = root.querySelector(".zp-side-split__menu");
    if (!toggle || !menu) return;

    const rect = toggle.getBoundingClientRect();
    const height = menu.offsetHeight || 40;
    // Centre the popover on the toggle; aligning their tops made the menu
    // hang visibly below the button.
    const centred = rect.top + rect.height / 2 - height / 2;
    const top = Math.min(Math.max(8, centred), Math.max(8, window.innerHeight - height - 8));
    menu.style.left = Math.round(rect.right + 6) + "px";
    menu.style.top = Math.round(top) + "px";
};

document.addEventListener("pointerdown", (e) => {
    const target = e.target;
    const inSplit = target && target.closest ? target.closest(".zp-split") : null;
    if (!inSplit) closeToolbarSplits(null);
    const inSideSplit = target && target.closest ? target.closest(".zp-side-split") : null;
    if (!inSideSplit) closeSideSplits(null);
});

document.addEventListener("click", (e) => {
    const target = e.target;
    if (target && target.closest && target.closest(".zp-side-split__menu")) closeSideSplits(null);
});

const sideBarEl = document.getElementById("toolbar_side");
if (sideBarEl) sideBarEl.addEventListener("scroll", () => closeSideSplits(null), {passive: true});

window.addEventListener("resize", () => {
    closeToolbarSplits(null);
    closeSideSplits(null);
});

/* After an import the new folder is selected right away instead of reloading
 * the whole page, so the imported project starts previewing immediately. */
async function afterImport(result) {
    const name = result && result.name;
    try {
        const selected = await ProjectPicker.refreshOptions(name ? "/projects/" + name : "");
        if (selected) await ProjectPicker.applyProjectUrl(selected);
    } catch (e) {
        console.warn("Cannot refresh the project list after import", e);
        location.reload();
        return;
    }
    showToast(I18n.t("dialog.imported", "Project imported"), false);
}

/* Pick a .zip from the device storage (phones and plain browsers). */
function pickLocalZip() {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".zip,application/zip,application/x-zip-compressed";
        input.style.display = "none";
        document.body.appendChild(input);
        input.onchange = () => {
            const file = input.files && input.files[0];
            input.remove();
            resolve(file || null);
        };
        input.click();
    });
}

async function importViaUpload() {
    const file = await pickLocalZip();
    if (!file) return;

    const loading = document.getElementById("loading");
    if (loading) loading.style.display = "";
    try {
        const r = await fetch("/api/import_zip_upload", {
            method: "POST",
            headers: {
                "Content-Type": "application/zip",
                "X-File-Name": encodeURIComponent(file.name),
            },
            body: file,
        });
        const j = await r.json();
        if (j && j.ok) {
            await afterImport(j);
        } else {
            await zpAlert((j && j.msg) || I18n.t("dialog.importFailed", "Import failed"));
        }
    } catch (e) {
        console.error("Upload import failed", e);
        await zpAlert(I18n.t("dialog.importFailed", "Import failed") + ": " + e);
    } finally {
        if (loading) loading.style.display = "none";
    }
}

window.zpImportProject = async () => {
    if (!isDesktopShell()) {
        await importViaUpload();
        return;
    }
    try {
        const r = await fetch("/api/import_project?lang=" + encodeURIComponent(I18n.locale));
        const j = await r.json();
        if (j && j.ok) {
            await afterImport(j);
        } else if (j && j.msg) {
            await zpAlert(j.msg);
        }
    } catch (e) {
        console.error("Import failed", e);
        await zpAlert(I18n.t("dialog.importFailed", "Import failed") + ": " + e);
    }
};

window.zpOpenProjects = async () => {
    try {
        const r = await fetch("/api/open_projects");
        const j = await r.json();
        if (j && !j.ok) {
            await zpAlert(I18n.t("dialog.openFolderFailed", "Cannot open the projects folder") + ": " + (j.msg || ""));
        }
    } catch (e) {
        console.error(e);
        await zpAlert(I18n.t("dialog.openFolderFailed", "Cannot open the projects folder") + ": " + e);
    }
};

window.zpAndroidExportResult = (requestId, status, detail) => {
    const loading = document.getElementById("loading");
    if (loading) loading.style.display = "none";
    if (status === "ok") {
        showToast(I18n.t("dialog.exportedChosen", "Project exported to the selected folder"), false);
    } else if (status === "cancelled") {
        showToast(I18n.t("dialog.exportCancelled", "Export cancelled"), false);
    } else {
        showToast(I18n.t("dialog.exportFailed", "Export failed") + ": " + (detail || ""), true);
    }
};

window.zpExportProject = async () => {
    const url = ProjectPicker.getProject();
    if (!url) {
        await zpAlert(I18n.t("dialog.noProjects", "No projects found in the current folder."));
        return;
    }

    // A plain browser on a phone has no native save dialog, so the zip is
    // streamed as a download. The APK saves it natively instead.
    if (!isDesktopShell() && !isAndroidApp()) {
        window.location.href = "/api/download_project?projectUrl=" + encodeURIComponent(url);
        return;
    }

    // On the phone the zip is packed into cache and then handed to the system
    // file picker, so the user can choose any folder they like.
    if (isAndroidApp() && window.zpAndroid && window.zpAndroid.exportFileToUser) {
        const loading = document.getElementById("loading");
        if (loading) loading.style.display = "";
        try {
            const r = await fetch("/api/export_project", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({projectUrl: url, dest: "ask"}),
            });
            const j = await r.json();
            if (j && j.ok && j.cachePath) {
                showToast(I18n.t("dialog.exportChooseDir", "Choose a folder to save the zip"), false);
                window.zpAndroid.exportFileToUser(j.cachePath, j.name || "project.zip", "export-" + Date.now());
                return;
            }
            if (loading) loading.style.display = "none";
            await zpAlert(I18n.t("dialog.exportFailed", "Export failed") + ": " + ((j && j.msg) || ""));
        } catch (e) {
            if (loading) loading.style.display = "none";
            console.error("Export failed", e);
            await zpAlert(I18n.t("dialog.exportFailed", "Export failed") + ": " + e);
        }
        return;
    }

    const loading = document.getElementById("loading");
    if (loading) loading.style.display = "";
    try {
        const r = await fetch("/api/export_project", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({projectUrl: url}),
        });
        const j = await r.json();
        if (j && j.ok) {
            showToast(I18n.t("dialog.exported", "Project exported to") + " " + j.path);
        } else if (j && j.cancelled) {
            return;
        } else {
            await zpAlert(I18n.t("dialog.exportFailed", "Export failed") + ": " + ((j && j.msg) || ""));
        }
    } catch (e) {
        console.error("Export failed", e);
        await zpAlert(I18n.t("dialog.exportFailed", "Export failed") + ": " + e);
    } finally {
        if (loading) loading.style.display = "none";
    }
};

/* Drag & drop a project folder or .zip onto the window to import it. */
const setupDropImport = () => {
    const overlay = document.getElementById("zp_drop_overlay");
    if (!overlay) return;

    let depth = 0;
    const hasFiles = (e) => !!(e.dataTransfer
        && Array.from(e.dataTransfer.types || []).indexOf("Files") > -1);
    const show = (visible) => overlay.classList.toggle("visible", visible);

    window.addEventListener("dragenter", (e) => {
        if (!hasFiles(e)) return;
        depth++;
        show(true);
    });
    window.addEventListener("dragover", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    });
    window.addEventListener("dragleave", (e) => {
        if (!hasFiles(e)) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) show(false);
    });
    window.addEventListener("drop", async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        show(false);

        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;

        let droppedPath = "";
        try {
            if (window.zpDesktop && window.zpDesktop.getPathForFile) {
                droppedPath = window.zpDesktop.getPathForFile(file);
            }
        } catch (err) {}

        if (!droppedPath) {
            await zpAlert(I18n.t("dialog.importFailed", "Import failed")
                + ": " + (I18n.locale === "zh" ? "无法读取拖入文件的路径" : "Cannot read the dropped path"));
            return;
        }

        try {
            const r = await fetch("/api/import_path", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({path: droppedPath}),
            });
            const j = await r.json();
            if (j && j.ok) {
                await afterImport(j);
            } else if (j && j.msg) {
                await zpAlert(j.msg);
            }
        } catch (err) {
            console.error("Drop import failed", err);
            await zpAlert(I18n.t("dialog.importFailed", "Import failed") + ": " + err);
        }
    });
};

/* Rejects instead of hanging forever, so a stalled network call can never
 * leave the whole UI unresponsive. */
const bootIssues = [];

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error(label + " timed out after " + ms + "ms")), ms)),
    ]);
}

function bootWarn(label, e) {
    console.warn("[boot] " + label + " failed", e);
    bootIssues.push(label + ": " + ((e && (e.message || e)) || "unknown"));
}

function bootFail(label, e) {
    console.error("[boot] " + label + " failed", e);
    if (window.__zpReport) {
        window.__zpReport(label + " failed: " + (e && (e.stack || e.message) || e));
    }
}

/* Cosmetic only: load it in the background so a slow or failing font can
 * never delay the boot sequence. */
function loadFont() {
    try {
        const font = new FontFace("allfont", "url(/app/allfont-Medium.ttf)");
        font.load()
            .then((loaded) => document.fonts.add(loaded))
            .catch((e) => console.warn("Custom font failed to load", e));
    } catch (e) {
        console.warn("Custom font unavailable", e);
    }
}

/**
 * Start all
 */
const start = async () => {
    const root = document.getElementById("display");
    const ctx = root.getContext("2d");

    try { initViewMode(); } catch (e) { bootWarn("view mode", e); }
    try { setupDropImport(); } catch (e) { bootWarn("drop import", e); }

    // The engine is created before anything async so the canvas gets its real
    // size immediately; every later step is isolated and may fail alone.
    let player = null;
    try {
        player = new ChromeZeppPlayer();
        window.player = player;
    } catch (e) {
        bootFail("Engine", e);
    }

    if (player) {
        try {
            root.width = player.screen[0];
            root.height = player.screen[1];
            fitDisplayCanvas();
            player.setupHTMLEvents(root);
        } catch (e) { bootWarn("canvas setup", e); }
    }

    loadFont();

    if (player) {
        try { PlayerSettingsLoader.loadAll(player); } catch (e) { bootWarn("settings", e); }
        try {
            startNgUi(document.getElementById("ng-root"), player);
        } catch (e) {
            bootFail("React UI", e);
        }
    }

    if (player) {
        try {
            await withTimeout(ProjectPicker.setup(player), 8000, "project list");
        } catch (e) { bootWarn("project list", e); }
        try { ToolbarManager.initProfileSelect(player); } catch (e) { bootWarn("profile select", e); }
    }

    // From here on the toolbar works even when no project could be loaded.
    if (player) {
        try { ToolbarManager.init(player); } catch (e) { bootFail("Toolbar", e); }
        try { ConsoleManager.init(player); } catch (e) { bootWarn("console", e); }
        try { ExplorerManager.init(player); } catch (e) { bootWarn("explorer", e); }
    }

    let fitTimer = null;
    const scheduleFit = () => {
        clearTimeout(fitTimer);
        fitTimer = setTimeout(fitDisplayCanvas, 160);
    };
    window.addEventListener("resize", scheduleFit);
    window.addEventListener("orientationchange", () => setTimeout(fitDisplayCanvas, 320));

    // Load project (only if the folder actually contains one)
    const initialProject = player ? ProjectPicker.getProject() : "";
    if(initialProject) {
        try {
            await player.setProject(initialProject);
            await ChangesWatcher.init(player);
            await player.init();
        } catch (e) {
            bootFail("Project load", e);
            showToast("项目加载失败: " + (e && (e.message || e)), true, 8000);
        }
    } else {
        console.warn("No project found in the projects folder");
        showToast(I18n.t("dialog.noProjects", "No projects found in the current folder."), true, 6000);
    }

    // Surface non-fatal boot problems once, so a phone without DevTools can
    // still tell us which step degraded.
    if (bootIssues.length && window.__zpReport) {
        window.__zpReport("启动告警（界面仍可用）:\n" + bootIssues.join("\n"));
    }

    // Render config
    let lastRender = 0;

    const refresh = async () => {
        try {
            requestAnimationFrame(refresh);

            if(Date.now() - lastRender > DISPLAY_DELTA) {
                await performRefresh();
                lastRender = Date.now();
            }
        } catch(e) {
            console.error("Refresh failed...", e);
            setTimeout(() => {
                refresh();
            }, 2500);
        }
    };

    const performRefresh = async () => {
        if(!player.currentRuntime) return;
        if(document.hidden || player.currentRuntime.uiPause || !player.currentRuntime.refresh_required) return;

        let canvas;
        try {
            canvas = await player.render();
        } catch(e) {
            console.error("Render err", e);
            player.refresh_required = false;
        }
        const rotation = player.rotation;

        let [w, h] = [canvas.width, canvas.height];
        if(rotation % 180 === 90) [h, w] = [w, h];
        const sizeChanged = root.width !== w || root.height !== h;
        if(root.width !== w) root.width = w;
        if(root.height !== h) root.height = h;
        if(sizeChanged) fitDisplayCanvas();

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(w / 2, h / 2);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
        ctx.restore();
    }

    refresh();
};

initVersionUI();
I18n.apply(document);
start().catch((e) => {
    console.error("Startup failed", e);
    if (window.__zpReport) {
        window.__zpReport("Startup failed: " + (e && (e.stack || e.message) || e));
    }
});
