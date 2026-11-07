/*
    AppSideManager - owns the companion (side-service) runtime for the
    currently loaded project and bridges it with the device-side app through
    an in-process VirtualLink. This replaces the real Bluetooth endpoint
    0x00a0 (app-side) of OronBox with a plain JS bus inside the simulator.
*/

import { createAppSideSandbox, runAppSideSource } from "./AppSideRuntime.js";
import { PersistentStorage } from "../PersistentStorage.js";

export default class AppSideManager {
    constructor(player) {
        this.player = player;
        this.persistent = new PersistentStorage(
            player.config?.persistentKeyName ?? "zp_appdata"
        );
        this.env = null;
        this.serviceDef = null;
        this.enabled = false;
        this.sourceUrl = null;

        // Device-side receivers of messages coming FROM the companion.
        // (MessagingMock registers one per page runtime.)
        this.deviceReceivers = new Set();

        // Companion-side session state, mirroring Zepp OS appId/ports.
        this.session = null;
    }

    get appId() {
        return this.player.appConfig?.app?.appId ?? null;
    }

    get appName() {
        return this.player.appConfig?.app?.name ?? "unknown";
    }

    get storageKey() {
        return this.appId !== null ? String(this.appId) : "appside";
    }

    /**
     * Detects & boots the companion script for a project. No-op when absent.
     */
    async loadProject(projectPath) {
        if (this.env) this.stop();

        let source = null;
        this.sourceUrl = projectPath + "/app-side.js";
        const candidates = ["/app-side.js", "/app-side/main.js", "/app_side.js"];
        for (const rel of candidates) {
            const p = (projectPath + rel).replace(/\/+/g, "/");
            source = await this._tryLoad(p);
            if (source) { this.sourceUrl = p; break; }
        }
        if (source === null) {
            // companion script not present -> nothing to run
            this.enabled = false;
            this.session = null;
            return false;
        }

        this.enabled = true;
        this.session = {
            appId: this.appId,
            version: this.player.appConfig?.app?.version?.name ?? null,
            port1: 1004,
            port2: 1005
        };

        this.env = createAppSideSandbox(this);
        runAppSideSource(this.env, source, this.sourceUrl);
        this.serviceDef = this.env.__zbGetServiceDef();
        if (!this.serviceDef) {
            this.player.onConsole("AppSide", ["No AppSideService exported by app-side.js"]);
        }
        try { await this.env.__zbStart(); } catch (e) {
            this.player.onConsole("AppSide", ["start failed", e]);
        }
        return true;
    }

    async _tryLoad(path) {
        try {
            const data = await this.player.loadFile(path, true);
            if (!data || data.byteLength === 0) return null;
            return new TextDecoder().decode(data);
        } catch (e) {
            return null;
        }
    }

    // ------------------------------------------------------------ VirtualLink
    /**
     * Device-side app -> companion. Called by MessagingMock.
     */
    injectFromDevice(bytes) {
        if (!this.env) return;
        try { this.env.__zbInjectPeer(bytes); }
        catch (e) { this.player.onConsole("AppSide", ["injectFromDevice failed", e]); }
    }

    /**
     * Companion -> device-side app. Called by the sandbox host bridge.
     */
    sendToDevice(bytes) {
        for (const fn of this.deviceReceivers) {
            try { fn(bytes); } catch (e) {
                this.player.onConsole("AppSide", ["device receiver error", e]);
            }
        }
    }

    registerDeviceReceiver(fn) { this.deviceReceivers.add(fn); }
    unregisterDeviceReceiver(fn) { this.deviceReceivers.delete(fn); }

    // ------------------------------------------------------------ host bridge
    onConsole(tag, args) {
        this.player.onConsole(tag, args, { runtimeID: "AppSide" });
    }

    readSettings() {
        const v = this.persistent.get("appside_settings", this.storageKey);
        return (v && typeof v === "object") ? v : {};
    }

    writeSettings(obj) {
        this.persistent.set("appside_settings", this.storageKey, obj || {});
    }

    fetchFn(url, opts) {
        if (typeof fetch !== "function") {
            return Promise.reject(new Error("fetch unavailable in this environment"));
        }
        return fetch(url, opts);
    }

    // ------------------------------------------------------------ lifecycle
    async stop() {
        if (this.env) {
            try { await this.env.__zbStop(); } catch (e) {}
        }
        this.env = null;
        this.serviceDef = null;
        this.deviceReceivers.clear();
        this.session = null;
    }
}