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

import VideoRecorder from "./VideoRecorder.js";
import ScreenshotManager from "./ScreenshotManager.js";
import { getDeviceProfiles } from "../zepp_player/DeviceProfiles";
import AppSettingsManager from "./AppSettingsManager";
import I18n from "../zepp_player/i18n.js";
import { showToast } from "../zepp_player/zpToast.js";

// Defined at module scope: the panel buttons in the top toolbar must work even
// if the rest of the boot sequence fails, so this can't live inside init().
window.zpPanelTab = (panelId, el) => {
    const panels = ["view_console", "view_edit", "view_explorer"];
    const panelButtons = { view_console: "toggle_console", view_edit: "toggle_edit", view_explorer: "toggle_explorer" };
    for(const pid of panels) {
        const panel = document.getElementById(pid);
        if(panel) panel.style.display = pid === panelId ? "" : "none";
    }
    for(const pid of panels) {
        const btn = document.getElementById(panelButtons[pid]);
        if(btn) btn.classList.toggle("active", pid === panelId);
    }
    if(el) el.classList.add("active");

    // Phones show a single dropdown icon that mirrors the active panel.
    const splitIcon = document.getElementById("zp_split_panels_btn");
    if(splitIcon) {
        const icons = {view_console: "terminal", view_edit: "edit", view_explorer: "account_tree"};
        splitIcon.textContent = icons[panelId] || "terminal";
    }
    const splitMenu = document.getElementById("zp_split_panels_menu");
    if(splitMenu) {
        const items = splitMenu.querySelectorAll(".zp-split__item");
        for(const item of items) {
            item.classList.toggle("active", item.getAttribute("data-panel") === panelId);
        }
    }

    AppSettingsManager.setObject("activePanel", panelId);
};

/* The code panel is a full-screen modal on phones (see index.css). Kept at
 * module scope so the toolbar button keeps working when init() fails. */
window.zpOpenCode = () => {
    try {
        if(!document.body.classList.contains("zp-mobile")) return;
        document.body.classList.add("zp-code-open");
        const item = document.querySelector('.zp-split__item[data-panel="code"]');
        if(item) item.classList.add("active");
    } catch (e) {}
};

window.zpCloseCode = () => {
    try {
        document.body.classList.remove("zp-code-open");
        const item = document.querySelector('.zp-split__item[data-panel="code"]');
        if(item) item.classList.remove("active");
    } catch (e) {}
};

/* localStorage can throw in restricted WebViews. */
function readLocal(key, fallback) {
    try { return localStorage[key] === undefined ? fallback : localStorage[key]; }
    catch (e) { return fallback; }
}

function writeLocal(key, value) {
    try { localStorage[key] = value; } catch (e) {}
}

export class ToolbarManager {
    static player = null;

    // UI Elements
    static toggleMode1 = document.getElementById("mode_1");
    static toggleMode2 = document.getElementById("mode_2");
    static toggleMode4 = document.getElementById("mode_4");
    static toggleEventZones = document.getElementById("toggle_events");
    static togglePause = document.getElementById("toggle_pause");
    static toggleShift = document.getElementById("toggle_shift");

    static doReloadBtn = document.getElementById("do_reload");
    static doVideoBtn = document.getElementById("do_video");
    static doScreenshotBtn = document.getElementById("do_screenshot");
    static doRotateBtn = document.getElementById("do_rotate");
    static doRestartBtn = document.getElementById("do_restart");

    static doBackBtn = document.getElementById("app_back");
    static doUpBtn = document.getElementById("app_up");
    static doDownBtn = document.getElementById("app_down");

    static bindSwitchBtn(config) {
        const {blockId, configId, fallback, handler} = config;

        const block = document.getElementById(blockId);
        const handleValue = (val) => {
            if(block.tagName === "INPUT") {
                block.checked = val;
            }

            val ? block.classList.add("active") : block.classList.remove("active");
        };

        const performChange = () => {
            const val = !AppSettingsManager.getObject(configId, fallback);
            AppSettingsManager.setObject(configId, val);
            handleValue(val);
            handler(val, false);
        };

        const current = AppSettingsManager.getObject(configId, fallback)
        handleValue(current);
        handler(current, true);

        block.onclick = performChange;
        return performChange;
    }

    static init(player) {
        ToolbarManager.player = player;

        // Panel switching lives at module scope; just restore the saved tab.
        const saved = AppSettingsManager.getObject("activePanel", "view_console");
        const target = (saved && document.getElementById(saved)) ? saved : "view_console";
        window.zpPanelTab(target, null);

        ToolbarManager.actionToggleOverlay = ToolbarManager.bindSwitchBtn({
            blockId: "toggle_overlay",
            configId: "overlayVisible",
            fallback: true,
            handler: (v) => {
                ToolbarManager.player.config.renderDeviceOverlay = v;
            }
        })

        // Load saved settings
        const savedRotation = readLocal("zepp_player_rotation", undefined);
        if(savedRotation !== undefined) {
            ToolbarManager.player.rotation = parseInt(savedRotation);
        }
        ToolbarManager._refresh();

        // Bind onClick events
        ToolbarManager.toggleMode1.onclick = () => ToolbarManager.doToggleMode(1);
        ToolbarManager.toggleMode2.onclick = () => ToolbarManager.doToggleMode(2);
        ToolbarManager.toggleMode4.onclick = () => ToolbarManager.doToggleMode(4);
        ToolbarManager.toggleEventZones.onclick = ToolbarManager.doToggleEventZones;
        ToolbarManager.togglePause.onclick = ToolbarManager.doTogglePause;
        ToolbarManager.toggleShift.onclick = ToolbarManager.doToggleShift;
        ToolbarManager.doReloadBtn.onclick = ToolbarManager.doReload;
        if(ToolbarManager.doVideoBtn) ToolbarManager.doVideoBtn.onclick = () => ToolbarManager.doVideo();
        if(ToolbarManager.doScreenshotBtn) ToolbarManager.doScreenshotBtn.onclick = () => ToolbarManager.doScreenshot();
        ToolbarManager.doRotateBtn.onclick = ToolbarManager.doRotate;
        ToolbarManager.doBackBtn.onclick = ToolbarManager.doBack;
        ToolbarManager.doUpBtn.onclick = () => ToolbarManager.doScroll(-1);
        ToolbarManager.doDownBtn.onclick = () => ToolbarManager.doScroll(1);
        ToolbarManager.doRestartBtn.onclick = () => ToolbarManager.doRestart();

        ToolbarManager.bindKeyboard();

        // Add type class
        player.onProjectChanged.add(() => {
            document.getElementById("toolbar_side").className = player.appConfig.app.appType;
        })
    }

    static initProfileSelect(player) {
        const profiles = getDeviceProfiles();
        const picker = document.getElementById("player_profile_select");

        let current = "mi_band7";
        const savedProfile = readLocal("zp_profile_name", "");
        if(savedProfile && profiles[savedProfile]) {
            current = savedProfile;
        }

        for(const name in profiles) {
            const opt = document.createElement("option");
            opt.value = name;
            opt.innerText = name;
            picker.appendChild(opt);
        }
        picker.value = current;
        picker.onchange = async () => {
            writeLocal("zp_profile_name", picker.value);
            player.profileName = picker.value;
            player.imgCache = {};
            await player.overlayTool.init();
            await player.init();
            if(player.currentRuntime) {
                player.currentRuntime.refresh_required = "profile_ch";
            }
        };

        player.profileName = current;
    }

    static isTypingTarget(e) {
        let t = e && e.target;
        // Events forwarded from the main process have no target.
        if(!t || t === document || t === window) t = document.activeElement;
        if(!t) return false;
        const tag = (t.tagName || "").toUpperCase();
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable === true;
    }

    /* Resolve a keyboard event to one canonical token.
     * e.code is often empty in this Electron build, and an active CJK IME
     * rewrites e.key to "Process" (keyCode 229). The main-process forwarded
     * event keeps the real key, so it resolves correctly there. */
    static keyToken(e) {
        const code = e.code || "";
        if(code.length === 4 && code.indexOf("Key") === 0) {
            return code.charAt(3).toLowerCase();
        }
        if(code.length === 6 && code.indexOf("Digit") === 0) {
            return code.charAt(5);
        }
        switch(code) {
            case "Equal":
            case "NumpadAdd":
                return e.shiftKey ? "+" : "=";
            case "Minus":
            case "NumpadSubtract":
                return e.shiftKey ? "_" : "-";
            case "Slash":
                return e.shiftKey ? "?" : "/";
            case "Escape":
                return "Escape";
            case "F1":
                return "F1";
        }

        const key = e.key || "";
        if(!key || key === "Process" || key === "Unidentified" || key === "Dead") return "";
        if(key.length === 1) {
            const lower = key.toLowerCase();
            if("abcdefghijklmnopqrstuvwxyz".indexOf(lower) >= 0) return lower;
            return key;
        }
        return key;
    }

    static bindKeyboard() {
        if(ToolbarManager._keyBound) return;
        ToolbarManager._keyBound = true;

        /* Desktop: the main process forwards raw key events (see
         * electron_main.js), so shortcuts also work while an IME composes. */
        const bridge = window.zpDesktop;
        if(bridge && typeof bridge.onKeyEvent === "function") {
            try { bridge.onKeyEvent((payload) => ToolbarManager.onKeyEvent(payload)); } catch (e) {}
        }

        // Capture phase: a focused child must not be able to swallow shortcuts.
        document.addEventListener("keydown", (e) => {
            ToolbarManager.onKeyEvent({
                key: e.key,
                code: e.code,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                shiftKey: e.shiftKey,
                metaKey: e.metaKey,
                repeat: e.repeat,
                target: e.target,
                fromMain: false,
            });
        }, true);
    }

    static onKeyEvent(e) {
        if(!e || e.repeat) return;
        const token = ToolbarManager.keyToken(e);
        if(!token) return;

        const ctrl = !!e.ctrlKey, alt = !!e.altKey, shift = !!e.shiftKey, meta = !!e.metaKey;

        /* The same physical press can arrive twice (DOM + main-process
         * forwarding). Collapse the duplicate instead of toggling twice. */
        const sig = token + "|" + (ctrl ? "c" : "") + (alt ? "a" : "") + (shift ? "s" : "") + (meta ? "m" : "");
        const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
        if(sig === ToolbarManager._lastSig && now - ToolbarManager._lastAt < 150) return;
        ToolbarManager._lastSig = sig;
        ToolbarManager._lastAt = now;

        // --- Global shortcuts, also while typing in a field ---
        if(ctrl && alt && token === "s") {
            ToolbarManager.doScreenshot(shift);
            return;
        }
        if(ctrl && !alt && !shift && token === "p") {
            if(typeof window._setReactPane === "function") window._setReactPane("command_picker");
            return;
        }
        if(ctrl && !alt && !shift && token === "s") {
            ToolbarManager.doSaveCode();
            return;
        }

        // Leave every other OS/browser combo alone (Ctrl+C, Ctrl+V, Alt+Tab…)
        if(ctrl || alt || meta) return;

        if(token === "F1") {
            if(typeof window._setReactPane === "function") window._setReactPane("shortcuts");
            return;
        }

        const modalOpen = !!document.querySelector(".ui-backdrop__visible");

        if(token === "Escape") {
            if(document.body.classList.contains("zp-code-open")) {
                window.zpCloseCode();
            } else if(modalOpen) {
                window._setReactPane("");
            } else if(ToolbarManager.isTypingTarget(e)) {
                // Esc while editing should leave the field, not send "back"
                // to the simulated watch.
                const el = document.activeElement;
                if(el && typeof el.blur === "function") el.blur();
            } else {
                ToolbarManager.doBack();
            }
            return;
        }

        // Plain keys must not reach the simulator behind an open dialog or
        // while the user is typing.
        if(modalOpen) return;
        if(ToolbarManager.isTypingTarget(e)) return;

        switch(token) {
            case "1":
                ToolbarManager.doToggleMode(1);
                return;
            case "2":
                ToolbarManager.doToggleMode(2);
                return;
            case "3":
                ToolbarManager.doToggleMode(4);
                return;
            case "p":
                ToolbarManager.doTogglePause();
                return;
            case "s":
                if(shift) ToolbarManager.doToggleShift();
                return;
            case "z":
                if(shift) ToolbarManager.doToggleEventZones();
                return;
            case "w":
                if(shift) ToolbarManager.doReload();
                return;
            case "r":
                ToolbarManager.doRestart();
                return;
            case "c":
                window.zpPanelTab("view_console", null);
                return;
            case "e":
                window.zpPanelTab("view_edit", null);
                return;
            case "x":
                window.zpPanelTab("view_explorer", null);
                return;
            case "+":
            case "=":
                ToolbarManager.switchProject(1);
                return;
            case "_":
            case "-":
                ToolbarManager.switchProject(-1);
                return;
            case "?":
                if(typeof window._setReactPane === "function") window._setReactPane("shortcuts");
                return;
        }
    }

    static doSaveCode() {
        if(typeof window.zpSaveCode === "function") {
            try { window.zpSaveCode(); } catch (e) { console.error("Save code failed", e); }
        }
    }

    /**
     * Update buttons active/inactive states
     */
    static _refresh() {
        const runtime = ToolbarManager.player.currentRuntime
        const renderLevel = ToolbarManager.player.config.renderLevel;
        const data = [
            [ToolbarManager.toggleEventZones, ToolbarManager.player.config.showEventZones],
            [ToolbarManager.togglePause, runtime && runtime.uiPause],
            [ToolbarManager.toggleShift, ToolbarManager.player.config.withAutoIncrement],
            [ToolbarManager.toggleMode1, renderLevel === 1],
            [ToolbarManager.toggleMode2, renderLevel === 2],
            [ToolbarManager.toggleMode4, renderLevel === 4]
        ];

        for(let i in data) {
            const [button, enabled] = data[i];
            enabled ? button.classList.add("active") : button.classList.remove("active");
        }
    }

    static hasRuntime() {
        return !!ToolbarManager.player && !!ToolbarManager.player.currentRuntime;
    }

    static async doRestart() {
        if(!ToolbarManager.player || !ToolbarManager.player.projectPath) return;
        try {
            await ToolbarManager.player.restart();
        } catch(e) {
            console.error("Restart failed", e);
        }
    }

    static doScroll(d) {
        if(!ToolbarManager.player) return;
        ToolbarManager.player.config.renderScroll += d * 40;
    }

    static doBack() {
        if(!ToolbarManager.hasRuntime()) return;
        ToolbarManager.player.back();
    }

    static switchProject(delta) {
        const picker = document.getElementById("project_select");
        if(!picker || !picker.options.length) return;
        const current = picker.value;

        let index = -1;
        for(let i = 0; i < picker.options.length; i++) {
            if(picker.options[i].value === current) {
                index = i;
                break;
            }
        }
        if(index < 0) index = 0;

        const count = picker.options.length;
        for(let step = 1; step <= count; step++) {
            const i = ((index + delta * step) % count + count) % count;
            if(i === index) return;
            const next = picker.options[i].value;
            // Skip pseudo options that only open dialogs.
            if(!next || next.charAt(0) === "<") continue;

            picker.value = next;
            // noinspection JSCheckFunctionSignatures
            if(typeof picker.onchange === "function") picker.onchange();
            return;
        }
    }

    static doRotate() {
        const player = ToolbarManager.player;
        if(!player) return;
        player.rotation = (player.rotation + 90) % 360;
        writeLocal("zepp_player_rotation", player.rotation);
        if(player.currentRuntime) player.currentRuntime.refresh_required = "ui";
    }

    static doToggleMode(val) {
        const player = ToolbarManager.player;
        if(!player || !player.appConfig) return;
        if(player.appConfig.app.appType !== "watchface") {
            showToast(I18n.t("shortcuts.modeWatchfaceOnly"), false, 2600);
            return;
        }
        player.setRenderLevel(val)
            .then(() => ToolbarManager._refresh())
            .catch((e) => console.warn("Set render level failed", e));
    }

    static doTogglePause() {
        const player = ToolbarManager.player;
        if(!player || !player.currentRuntime) return;
        player.currentRuntime.setPause(!player.currentRuntime.uiPause);
        ToolbarManager._refresh();
    }

    static doToggleEventZones() {
        if(!ToolbarManager.player || !ToolbarManager.player.config) return;
        const config = ToolbarManager.player.config;
        config.showEventZones = !config.showEventZones;
        ToolbarManager._refresh();
    }

    static doToggleShift() {
        if(!ToolbarManager.player || !ToolbarManager.player.config) return;
        const config = ToolbarManager.player.config;
        config.withAutoIncrement = !config.withAutoIncrement;
        ToolbarManager._refresh();
    }

    static doReload() {
        const player = ToolbarManager.player;
        if(!player || !player.currentRuntime) return;
        player.currentRuntime.persistent.wipe();
        player.init();
    }

    static _videoRecorder = null;

    /* First click starts the recording, the next one stops and saves it. */
    static async doVideo() {
        if(!ToolbarManager.hasRuntime()) return;

        const current = ToolbarManager._videoRecorder;
        try {
            if(current && current.isRecording()) {
                ToolbarManager._setVideoRecording(false);
                await current.stop();
                ToolbarManager._videoRecorder = null;
                await current.export();
                return;
            }
            if(current && current.isBusy()) return;

            const recorder = new VideoRecorder(ToolbarManager.player);
            await recorder.start();
            ToolbarManager._videoRecorder = recorder;
            ToolbarManager._setVideoRecording(true);
            showToast(I18n.t("dialog.recordingStarted", "Recording… click again to stop"), false, 3200);
        } catch(e) {
            ToolbarManager._videoRecorder = null;
            ToolbarManager._setVideoRecording(false);
            console.error("Video recording failed", e);
            showToast(String(e && e.message || e), true);
        }
    }

    static _setVideoRecording(on) {
        const btn = ToolbarManager.doVideoBtn;
        if(btn) {
            btn.classList.toggle("active", on);
            btn.textContent = on ? "stop_circle" : "videocam";
        }
        // The grouped phone button mirrors the recording state.
        const toggle = document.getElementById("zp_capture_toggle");
        if(toggle) toggle.textContent = on ? "stop_circle" : "videocam";
    }

    static async doScreenshot(toProject) {
        await ScreenshotManager.captureAndNotify(ToolbarManager.player, {
            dest: toProject ? "project" : "pictures",
        });
    }
}
