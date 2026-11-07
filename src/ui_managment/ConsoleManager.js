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

import I18n from "../zepp_player/i18n.js";
import { showToast } from "../zepp_player/zpToast.js";
import { isDesktopShell, isAndroidApp, triggerDownload } from "./ViewMode.js";

const MAX_ENTRIES = 3000;

function pad(value) {
    return String(value).padStart(2, "0");
}

function logStamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
        + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export class ConsoleManager {
    static instance = null;

    static init(player) {
        ConsoleManager.instance = new ConsoleManager(player);
    }

    colors = {
        ZeppPlayer: "#ff7043",
        device: "#96ffa0",
        SystemWarning: "#ff9900",
        ZeppPlayerFatalError: "#ff2222",
        runtime: "#4cf",
        error: "#f22",
        warn: "#ff6600"
    };

    constructor(player) {
        this.player = player;
        this.entries = [];
        this.autoScroll = true;

        this.view = document.getElementById("view_console");
        this.view.innerHTML = "";

        this.buildToolbar();

        this.output = document.createElement("div");
        this.output.className = "console_output";
        this.view.appendChild(this.output);

        player.onConsoleOutput.add((tag, data, extra) => {
            this.writeBrowserConsole(tag, data, extra);

            try {
                if(tag === "PlayerRestarted") return this.wipe();
                this.write(tag, data, extra);
            } catch(e) {
                console.warn("When writing UI console", e);
            }
        });
    }

    buildToolbar() {
        this.toolbar = document.createElement("div");
        this.toolbar.className = "console_toolbar";

        const addButton = (icon, titleKey, handler) => {
            const el = document.createElement("span");
            el.className = "material-symbols-outlined";
            el.textContent = icon;
            el.title = I18n.t(titleKey);
            el.onclick = handler;
            this.toolbar.appendChild(el);
            return el;
        };

        addButton("delete_sweep", "console.clear", () => this.wipe());
        addButton("content_copy", "console.copy", () => this.copyAll());
        addButton("download", "console.export", () => this.exportLog());
        this.autoScrollBtn = addButton("vertical_align_bottom", "console.autoscroll", () => {
            this.autoScroll = !this.autoScroll;
            this.autoScrollBtn.classList.toggle("active", this.autoScroll);
            if(this.autoScroll) this.scrollToBottom();
        });
        this.autoScrollBtn.classList.add("active");

        this.view.appendChild(this.toolbar);
    }

    wipe() {
        if(!this.output) return;
        this.output.innerHTML = "";
        this.entries = [];
    }

    scrollToBottom() {
        this.view.scrollTop = this.view.scrollHeight;
        this.output.scrollTop = this.output.scrollHeight;
    }

    getAllText() {
        return this.entries.map((e) => e.text).join("\n");
    }

    async copyAll() {
        const text = this.getAllText();
        if(!text) return;
        try {
            await navigator.clipboard.writeText(text);
            showToast(I18n.t("console.copied", "Console log copied"));
        } catch(e) {
            showToast(I18n.t("console.actionFailed", "Action failed") + ": " + (e && e.message || e), true);
        }
    }

    async exportLog() {
        const text = this.getAllText();
        if(!text) {
            showToast(I18n.t("console.empty", "Console is empty"), true);
            return;
        }

        // A plain browser cannot reach a native save dialog, download instead.
        if(!isDesktopShell() && !isAndroidApp()) {
            const name = `console_${logStamp()}.log`;
            const url = URL.createObjectURL(new Blob([text], {type: "text/plain"}));
            triggerDownload(url, name);
            setTimeout(() => URL.revokeObjectURL(url), 8000);
            showToast(I18n.t("console.exported", "Console log saved to") + " " + name);
            return;
        }

        try {
            const resp = await fetch("/api/save_text", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({text, name: `console_${logStamp()}.log`}),
            });
            const data = await resp.json();
            if(!resp.ok || !data || !data.ok) {
                throw new Error((data && data.msg) || ("HTTP " + resp.status));
            }
            showToast(I18n.t("console.exported", "Console log saved to") + " " + data.path);
        } catch(e) {
            showToast(I18n.t("console.actionFailed", "Action failed") + ": " + (e && e.message || e), true);
        }
    }

    writeBrowserConsole(level, data, extra) {
        const color = this.colors[level] ? this.colors[level] : "initial";
        const id = (extra && extra.runtimeID) ? extra.runtimeID : "";
        const args = [`%c[${level}] %c${id}`, `color: ${color}`, `color: #999`];

        if(['log', 'error', 'warn', 'info'].indexOf(level) > -1) {
            console[level](...args, ...data);
        } else {
            console.log(...args, ...data);
        }
    }

    formatValue(value) {
        if(value instanceof Error) return value.stack;
        if(value instanceof Object) {
            try {
                return JSON.stringify(value);
            } catch(e) {
                return value.toString();
            }
        }
        return String(value);
    }

    write(level, data, extra) {
        const div = document.createElement("div");
        div.className = "console_line";

        const lv = document.createElement("span");
        lv.style.color = this.colors[level] ? this.colors[level] : "#999";
        lv.innerText = level;
        div.appendChild(lv);

        if(extra && extra.runtimeID) {
            let arg = document.createElement("span");
            arg.style.opacity = "0.5";
            arg.innerText = extra.runtimeID;
            div.appendChild(arg);
        }

        const parts = [];
        for(let i in data) {
            const text = this.formatValue(data[i]);
            parts.push(text);

            let arg = document.createElement("span");
            arg.innerText = text;
            div.appendChild(arg);
        }

        const scriptPath = (extra && extra.scriptPath) ? extra.scriptPath : "";
        const text = `[${level}]${extra && extra.runtimeID ? " " + extra.runtimeID : ""} ${parts.join(" ")}`;

        if(scriptPath) {
            div.classList.add("console_line--link");
            div.title = I18n.t("console.jumpHint", "Open this script in the code panel");
            div.onclick = () => {
                if(typeof window.zpOpenCodeFile === "function") {
                    window.zpOpenCodeFile(scriptPath);
                }
            };
        }

        this.output.appendChild(div);
        this.entries.push({text, scriptPath});

        if(this.entries.length > MAX_ENTRIES) {
            this.entries.shift();
            if(this.output.firstChild) this.output.removeChild(this.output.firstChild);
        }

        if(this.autoScroll) this.scrollToBottom();
    }
}
