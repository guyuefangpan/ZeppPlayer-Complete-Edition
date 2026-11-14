/*
    AppSide panel - the phone-side view of the loaded project.

    The project's `setting/index.js` is executed inside an iframe, the same way
    a phone client runs it in a WebView, so the page renders itself from its own
    code instead of being re-created by the simulator.
*/

import I18n from "../zepp_player/i18n.js";
import { buildSettingsHtml } from "../zepp_player/appside/AppSettingsRuntime.js";

function t(key, fallback) {
    try {
        return I18n.t(key, fallback);
    } catch (e) {
        return fallback;
    }
}

export default class AppSidePanel {
    static init(player) {
        if (!player || !player.appSideManager) return false;
        if (AppSidePanel.instance && AppSidePanel.instance.player === player) return true;
        AppSidePanel.instance = new AppSidePanel(player);
        return true;
    }

    constructor(player) {
        this.player = player;
        this.manager = player.appSideManager;
        this.root = document.getElementById("view_appside");
        this.iframe = null;
        this.pageKey = null;
        if (!this.root) return;
        this.renderFrame();

        this.manager.onStateChanged.add(() => {
            this.renderStatus();
            this.renderPage();
        });
        this.manager.onSettingsChanged.add((values, origin) => {
            // The page is the one that changed them; anything else (app-side,
            // the clear button) has to be pushed into the running page.
            if (origin !== "settings-page") this.postToPage({ type: "settingsChanged", values });
        });
        player.onProjectChanged.add(() => {
            this.renderStatus();
            this.renderPage();
        });

        this.onMessage = (event) => this.handlePageMessage(event);
        window.addEventListener("message", this.onMessage);

        this.renderStatus();
        this.renderPage();
    }

    // ------------------------------------------------------------ chrome
    renderFrame() {
        this.root.innerHTML = "";

        this.panel = document.createElement("div");
        this.panel.className = "appside_panel";

        const head = document.createElement("div");
        head.className = "appside_head";

        this.dot = document.createElement("span");
        this.dot.className = "appside_dot";

        const titles = document.createElement("div");
        titles.className = "appside_titles";
        const title = document.createElement("strong");
        title.textContent = "app-side";
        this.stateLabel = document.createElement("small");
        titles.append(title, this.stateLabel);

        this.closeButton = this.iconButton("close", t("appSide.close", "Close"), () => {
            if (window.zpCloseAppSide) window.zpCloseAppSide();
        });
        this.closeButton.classList.add("appside_close");
        this.restartButton = this.iconButton("refresh", t("appSide.restart", "Restart app-side"), () => {
            this.manager.restart();
        });
        this.clearButton = this.iconButton("delete_sweep", t("appSide.clear", "Clear settings"), () => {
            this.manager.writeSettings({}, "panel");
            this.pageKey = null;
            this.renderStatus();
            this.renderPage();
        });

        head.append(this.dot, titles, this.closeButton, this.restartButton, this.clearButton);

        const body = document.createElement("div");
        body.className = "appside_body";

        const phone = document.createElement("div");
        phone.className = "appside_phone";
        const bar = document.createElement("div");
        bar.className = "appside_phone_bar";
        const time = document.createElement("span");
        time.textContent = "9:41";
        const notch = document.createElement("span");
        notch.className = "appside_phone_notch";
        const signal = document.createElement("span");
        signal.className = "material-symbols-outlined";
        signal.textContent = "signal_cellular_alt";
        bar.append(time, notch, signal);

        this.screen = document.createElement("div");
        this.screen.className = "appside_screen";

        phone.append(bar, this.screen);
        body.appendChild(phone);

        this.footer = document.createElement("div");
        this.footer.className = "appside_foot";

        this.panel.append(head, body, this.footer);
        this.root.appendChild(this.panel);
    }

    iconButton(icon, title, handler) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "appside_icon";
        button.title = title;
        const glyph = document.createElement("span");
        glyph.className = "material-symbols-outlined";
        glyph.textContent = icon;
        button.appendChild(glyph);
        button.onclick = handler;
        return button;
    }

    // ------------------------------------------------------------ state
    renderStatus() {
        if (!this.stateLabel) return;
        const running = this.manager.enabled && this.manager.status === "running";
        this.dot.classList.toggle("on", running);
        this.dot.classList.toggle("error", this.manager.status === "error");

        let text = running ? t("appSide.running", "Running") : t("appSide.stopped", "Not running");
        if (this.manager.appId !== null && this.manager.appId !== undefined) {
            text += " · 0x" + String(this.manager.appId).replace(/^0x/i, "").toUpperCase();
        }
        this.stateLabel.textContent = text;

        const hasProject = !!this.manager.projectPath;
        this.restartButton.disabled = !hasProject;
        this.clearButton.disabled = !hasProject;

        if (this.footer) {
            this.footer.textContent = this.manager.settingSource
                ? t("appSide.hint", "Settings are stored per app and shared with app-side.")
                : "";
        }
    }

    // ------------------------------------------------------------ page
    renderPage() {
        if (!this.screen) return;

        if (!this.manager.projectPath) {
            this.showEmpty(t("appSide.missing", "This project has no app-side component."));
            return;
        }
        if (this.manager.settingError) {
            this.showEmpty(t("appSide.error", "Failed to load") + ": " + (this.manager.settingError.message || this.manager.settingError));
            return;
        }
        if (!this.manager.settingSource) {
            this.showEmpty(t("appSide.noSettings", "This project has no phone settings page."));
            return;
        }

        const key = this.manager.settingRevision + "|" + this.manager.projectPath;
        if (this.pageKey === key && this.iframe && this.iframe.isConnected) return;
        this.mountPage(key);
    }

    mountPage(key) {
        this.iframe = null;
        this.screen.innerHTML = "";

        const frame = document.createElement("iframe");
        frame.className = "appside_frame";
        frame.setAttribute("sandbox", "allow-scripts");
        frame.title = "app-side settings";
        frame.srcdoc = buildSettingsHtml({
            source: this.manager.settingSource,
            values: this.manager.readSettings(),
            messages: this.flatMessages(),
            language: this.manager.defaultLanguage,
            appId: this.manager.appId,
        });

        this.iframe = frame;
        this.pageKey = key;
        this.screen.appendChild(frame);
    }

    flatMessages() {
        const table = this.manager.i18nTable || {};
        const language = this.manager.defaultLanguage;
        return Object.assign(
            {},
            table["en-US"] || {},
            table[String(language).split("-")[0]] || {},
            table[language] || {}
        );
    }

    postToPage(message) {
        if (!this.iframe || !this.iframe.isConnected || !this.iframe.contentWindow) return;
        try { this.iframe.contentWindow.postMessage(message, "*"); } catch (e) {}
    }

    handlePageMessage(event) {
        if (!this.iframe || event.source !== this.iframe.contentWindow) return;
        const message = event.data;
        if (!message || typeof message !== "object") return;

        switch (message.type) {
            case "settings":
                this.applyPageSettings(message);
                break;
            case "asset":
                Promise.resolve(this.manager.loadAsset(message.path)).then((url) => {
                    this.postToPage({ type: "asset", id: message.id, path: message.path, url: url || "" });
                }).catch(() => {});
                break;
            case "log":
                this.manager.onConsole(message.level || "log", [message.message]);
                break;
            case "external":
                if (message.url) {
                    try { window.open(message.url, "_blank", "noopener"); } catch (e) {}
                }
                break;
        }
    }

    applyPageSettings(message) {
        const values = this.manager.readSettings();
        if (message.operation === "set" && message.key !== undefined) {
            values[String(message.key)] = String(message.value);
        } else if (message.operation === "remove" && message.key !== undefined) {
            delete values[String(message.key)];
        } else if (message.operation === "clear") {
            for (const key of Object.keys(values)) delete values[key];
        }
        this.manager.writeSettings(values, "settings-page");
        this.renderStatus();
    }

    showEmpty(message) {
        this.iframe = null;
        this.pageKey = null;
        this.screen.innerHTML = "";
        const box = document.createElement("div");
        box.className = "appside_empty";
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined";
        icon.textContent = "phonelink_erase";
        const text = document.createElement("p");
        text.textContent = message;
        box.append(icon, text);
        this.screen.appendChild(box);
    }
}
