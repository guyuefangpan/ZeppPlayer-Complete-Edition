/*
    AppSideManager - owns the companion (side-service) runtime for the
    currently loaded project and bridges it with the device-side app through
    an in-process VirtualLink. This replaces the real Bluetooth endpoint
    0x00a0 (app-side) of OronBox with a plain JS bus inside the simulator.

    It also hosts the phone-side "app settings" page (`setting/index.js`),
    which reads and writes the same settingsStorage the companion sees.
*/

import { MiniSignal } from "mini-signals";
import { createAppSideSandbox, runAppSideSource } from "./AppSideRuntime.js";
import { bufferToDataUrl } from "./AppSettingsRuntime.js";
import { PersistentStorage } from "../PersistentStorage.js";

function joinPath(base, rel) {
    return (String(base) + "/" + String(rel)).replace(/\/+/g, "/");
}

/* The legacy `hmBle` channel (used by the MessageBuilder helper shipped with
 * almost every ZeppOS sample) frames every packet with a 16 byte header:
 * flag(1) version(1) type(2) port1(2) port2(2) appId(4) extra(4).
 * On a real watch the phone firmware strips that header before handing the
 * payload to the companion's `messaging.peerSocket`, and adds it back on the
 * way down. Without the same translation the companion's readPayload() would
 * treat header bytes as a traceId and every single request would be garbage. */
const HEADER_SIZE = 16;
const PACKET_FLAG_APP = 0x1;
const PACKET_VERSION_1 = 0x1;
const PACKET_SHAKE = 0x1;
const PACKET_CLOSE = 0x2;
const PACKET_DATA = 0x4;
const PACKET_DATA_SYSTEM = 0x5;
const PACKET_LOG = 0x6;
const SIDE_PORT = 1004;
const DEFAULT_DEVICE_PORT = 20;

function toView(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return null;
}

function readPacketHeader(view) {
    if (!view || view.length < HEADER_SIZE) return null;
    if (view[0] !== PACKET_FLAG_APP || view[1] !== PACKET_VERSION_1) return null;
    const type = view[2] | (view[3] << 8);
    if (type !== PACKET_SHAKE && type !== PACKET_CLOSE && type !== PACKET_DATA
        && type !== PACKET_DATA_SYSTEM && type !== PACKET_LOG) return null;
    return {
        type,
        port1: view[4] | (view[5] << 8),
        port2: view[6] | (view[7] << 8),
        appId: (view[8] | (view[9] << 8) | (view[10] << 16) | (view[11] << 24)) >>> 0,
        payload: view.subarray(HEADER_SIZE),
    };
}

function writeHeader(out, type, port1, port2, appId) {
    out[0] = PACKET_FLAG_APP;
    out[1] = PACKET_VERSION_1;
    out[2] = type & 0xff;
    out[3] = (type >> 8) & 0xff;
    out[4] = port1 & 0xff;
    out[5] = (port1 >> 8) & 0xff;
    out[6] = port2 & 0xff;
    out[7] = (port2 >> 8) & 0xff;
    out[8] = appId & 0xff;
    out[9] = (appId >> 8) & 0xff;
    out[10] = (appId >> 16) & 0xff;
    out[11] = (appId >> 24) & 0xff;
}

export default class AppSideManager {
    constructor(player) {
        this.player = player;
        this.persistent = new PersistentStorage(
            player.config?.persistentKeyName ?? "zp_appdata"
        );
        this.env = null;
        this.serviceDef = null;
        this.pendingDevice = [];
        this.pendingCompanion = [];
        /* Set once the device app used the legacy hmBle framing, so replies can
         * be wrapped the way the watch firmware wraps them. */
        this.legacyFraming = false;
        this.devicePort = DEFAULT_DEVICE_PORT;
        this.deviceAppId = 0;
        this.enabled = false;
        this.sourceUrl = null;
        this.lastError = null;
        this.status = "idle"; // idle | running | missing | error

        // Phone-side settings page (bundled source, executed by the panel's
        // WebView-like iframe, so it renders exactly like the phone client).
        this.settingSource = null;
        this.settingSourceUrl = null;
        this.settingError = null;
        this.settingRevision = 0;

        // Device-side receivers of messages coming FROM the companion.
        // (MessagingMock registers one per page runtime.)
        this.deviceReceivers = new Set();

        // Companion-side session state, mirroring Zepp OS appId/ports.
        this.session = null;

        this.onStateChanged = new MiniSignal();
        this.onSettingsChanged = new MiniSignal();

        this._assetCache = new Map();
        this._pending = null;
    }

    get appConfig() {
        return this.player.appConfig || {};
    }

    get appId() {
        return this.appConfig.app?.appId ?? null;
    }

    get appName() {
        return this.appConfig.app?.appName ?? this.appConfig.app?.name ?? "unknown";
    }

    get appVersion() {
        return this.appConfig.app?.version?.name ?? null;
    }

    get targetModule() {
        const targets = this.appConfig.targets || {};
        const first = Object.keys(targets)[0];
        const fromTarget = first && targets[first] ? (targets[first].module || {}) : {};
        return Object.assign({}, this.appConfig.module || {}, fromTarget);
    }

    get appSideEntry() {
        const entry = this.targetModule["app-side"];
        return (entry && entry.path) || null;
    }

    get settingEntry() {
        const entry = this.targetModule.setting;
        return (entry && entry.path) || null;
    }

    get defaultLanguage() {
        return this.appConfig.defaultLanguage || "en-US";
    }

    get i18nTable() {
        return this.appConfig.i18n || {};
    }

    get designWidth() {
        const targets = this.appConfig.targets || {};
        const first = Object.keys(targets)[0];
        return this.appConfig.designWidth
            || (first && targets[first] ? targets[first].designWidth : 0)
            || 0;
    }

    get screenWidth() {
        return this.player.profileData?.screenWidth || 0;
    }

    get storageKey() {
        return this.appId !== null ? String(this.appId) : "appside";
    }

    get projectPath() {
        return this.player.projectPath || "";
    }

    /**
     * Detects & boots the companion script + settings page for a project.
     */
    async loadProject(projectPath) {
        if (this._pending) {
            try { await this._pending; } catch (e) {}
        }
        this._pending = this._loadAll(projectPath);
        try {
            return await this._pending;
        } finally {
            this._pending = null;
        }
    }

    async _loadAll(projectPath) {
        await this.stop(true);

        this.lastError = null;
        this.settingError = null;
        this.settingSource = null;
        this._assetCache.clear();
        this.enabled = false;
        this.status = "missing";

        await this._loadAppSide(projectPath);
        await this._loadSettingPage(projectPath);
        this._emitState();
        return this.enabled;
    }

    async _loadAppSide(projectPath) {
        let source = null;
        const entry = this.appSideEntry;

        if (entry) {
            source = await this._loadBundled(projectPath, entry);
        }
        if (source === null) {
            // Legacy / hand-written companion kept as a single file.
            for (const rel of ["/app-side.js", "/app-side/main.js", "/app_side.js"]) {
                const path = joinPath(projectPath, rel);
                source = await this._tryLoad(path);
                if (source !== null) {
                    this.sourceUrl = path;
                    break;
                }
            }
        }
        if (source === null) return false;

        this.enabled = true;
        this.session = {
            appId: this.appId,
            version: this.appVersion,
            port1: 1004,
            port2: 1005
        };

        this.env = createAppSideSandbox(this);
        try {
            runAppSideSource(this.env, source, this.sourceUrl);
        } catch (e) {
            this.status = "error";
            this.lastError = e;
            this.enabled = false;
            this.player.onConsole("AppSide", ["Failed to evaluate app-side script", e]);
            return false;
        }

        this.serviceDef = this.env.__zbGetServiceDef();
        if (!this.serviceDef) {
            this.player.onConsole("AppSide", ["app-side script does not register AppSideService"]);
        }
        this.status = "running";
        try {
            await this.env.__zbStart();
        } catch (e) {
            this.status = "error";
            this.lastError = e;
            this.player.onConsole("AppSide", ["start failed", e]);
        }

        /* Replay what the device app sent before the companion was listening. */
        if (this.pendingDevice.length) {
            const backlog = this.pendingDevice;
            this.pendingDevice = [];
            this.player.onConsole("AppSide", ["Replaying " + backlog.length + " buffered packet(s)"]);
            for (const bytes of backlog) {
                try { this.env.__zbInjectPeer(bytes); } catch (e) {
                    this.player.onConsole("AppSide", ["replay failed", e]);
                }
            }
        }
        return true;
    }

    async _loadSettingPage(projectPath) {
        let source = null;
        const entry = this.settingEntry;

        if (entry) {
            source = await this._loadBundled(projectPath, entry);
            if (source !== null) this.settingSourceUrl = joinPath(projectPath, this._sourceFile(entry));
        }
        if (source === null) {
            for (const rel of ["/setting/index.js", "/setting.js", "/setting/main.js"]) {
                const path = joinPath(projectPath, rel);
                source = await this._tryLoad(path);
                if (source !== null) {
                    this.settingSourceUrl = path;
                    break;
                }
            }
        }
        if (source === null) return false;

        this.settingSource = source;
        this.settingRevision++;
        return true;
    }

    _sourceFile(entry) {
        return /\.js$/.test(entry) ? entry : entry + ".js";
    }

    async _loadBundled(projectPath, entry) {
        const path = joinPath(projectPath, this._sourceFile(entry));
        try {
            const body = await this.player.buildScriptBody(path);
            this.sourceUrl = path;
            return body;
        } catch (e) {
            return null;
        }
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
     * Device-side app -> companion. Called by MessagingMock / HuamiBLEMock.
     */
    injectFromDevice(bytes) {
        const view = toView(bytes);
        if (!view) return;

        const packet = readPacketHeader(view);
        /* A MessageBuilder handshake is unmistakable: type Shake with the one
         * byte appId payload. Everything after it on that channel is framed. */
        if (packet && packet.type === PACKET_SHAKE && packet.payload.length === 1) {
            this.legacyFraming = true;
            if (packet.port1) this.devicePort = packet.port1;
            if (packet.appId) this.deviceAppId = packet.appId;
            this._replyShake();
            return;
        }

        if (packet && this.legacyFraming) {
            if (packet.type === PACKET_CLOSE) return;
            if (packet.type === PACKET_LOG) {
                this.onConsole("device-log", [new TextDecoder().decode(packet.payload)]);
                return;
            }
            this._deliverToCompanion(packet.payload);
            return;
        }

        // Plain `messaging.peerSocket` traffic: payload only, no framing.
        this._deliverToCompanion(view);
    }

    _deliverToCompanion(payload) {
        if (!this.env) {
            /* The device app boots before the companion here, so its first
             * packets would be dropped. Keep a short backlog and replay it
             * once app-side is running. */
            if (this.pendingDevice.length < 64)
                this.pendingDevice.push(payload.slice ? payload.slice() : payload);
            return;
        }
        try { this.env.__zbInjectPeer(payload); }
        catch (e) { this.player.onConsole("AppSide", ["injectFromDevice failed", e]); }
    }

    /**
     * The watch firmware answers the handshake with the side port; the device
     * app blocks every request on that reply (`waitingShakePromise`).
     */
    _replyShake() {
        const out = new Uint8Array(HEADER_SIZE + 1);
        writeHeader(out, PACKET_SHAKE, this.devicePort, SIDE_PORT, this.deviceAppId);
        out[HEADER_SIZE] = this.deviceAppId & 0xff;
        this._dispatchToDevice(out);
    }

    /**
     * Companion -> device-side app. Called by the sandbox host bridge.
     */
    sendToDevice(bytes) {
        const view = toView(bytes) || new Uint8Array(0);
        this._dispatchToDevice(this.legacyFraming ? this._wrapForDevice(view) : view);
    }

    _wrapForDevice(payload) {
        const out = new Uint8Array(HEADER_SIZE + payload.length);
        writeHeader(out, PACKET_DATA, SIDE_PORT, SIDE_PORT, this.deviceAppId);
        out.set(payload, HEADER_SIZE);
        return out;
    }

    _dispatchToDevice(bytes) {
        if (!this.deviceReceivers.size) {
            if (this.pendingCompanion.length < 64)
                this.pendingCompanion.push(bytes.slice ? bytes.slice() : bytes);
            return;
        }
        for (const fn of [...this.deviceReceivers]) {
            try { fn(bytes); } catch (e) {
                this.player.onConsole("AppSide", ["device receiver error", e]);
            }
        }
    }

    registerDeviceReceiver(fn) {
        this.deviceReceivers.add(fn);
        if (this.pendingCompanion.length) {
            const backlog = this.pendingCompanion;
            this.pendingCompanion = [];
            for (const bytes of backlog) {
                try { fn(bytes); } catch (e) {}
            }
        }
    }
    unregisterDeviceReceiver(fn) { this.deviceReceivers.delete(fn); }

    // ------------------------------------------------------------ host bridge
    onConsole(tag, args) {
        this.player.onConsole("AppSide", args, { runtimeID: "AppSide" });
    }

    gettext(key) {
        const table = this.i18nTable || {};
        const lang = this.defaultLanguage;
        const short = String(lang).split("-")[0];
        const messages = Object.assign(
            {},
            table["en-US"] || {},
            table[short] || {},
            table[lang] || {}
        );
        const value = messages[key];
        return value === undefined ? key : value;
    }

    readSettings() {
        const v = this.persistent.get("appside_settings", this.storageKey);
        if (!v || typeof v !== "object") return {};
        const out = {};
        for (const key of Object.keys(v)) {
            if (v[key] !== null && v[key] !== undefined) out[key] = String(v[key]);
        }
        return out;
    }

    writeSettings(obj, origin) {
        const next = {};
        for (const key of Object.keys(obj || {})) {
            if (obj[key] !== null && obj[key] !== undefined) next[key] = String(obj[key]);
        }
        this.persistent.set("appside_settings", this.storageKey, next);
        if (this.env && origin !== "app-side") {
            try { this.env.__zbSettingsChanged(next); } catch (e) {}
        }
        this.onSettingsChanged.dispatch(next, origin || "unknown");
    }

    /**
     * Loads a project file and returns it as a data URL (settings page images).
     */
    async loadAsset(src) {
        const cleaned = String(src)
            .replace(/\\/g, "/")
            .replace(/^(\.\/)+/, "")
            .replace(/^\/+/, "");
        if (!cleaned) return "";
        if (/^(https?:|data:)/i.test(cleaned)) return cleaned;
        if (this._assetCache.has(cleaned)) return this._assetCache.get(cleaned);

        const candidates = [
            joinPath(this.projectPath, cleaned),
            joinPath(this.projectPath, "assets/" + cleaned),
            joinPath(this.projectPath, "setting/" + cleaned),
            joinPath(this.projectPath, "setting/assets/" + cleaned),
        ];
        for (const path of candidates) {
            try {
                const data = await this.player.loadFile(path, true);
                if (data && data.byteLength) {
                    const url = bufferToDataUrl(cleaned, data);
                    this._assetCache.set(cleaned, url);
                    return url;
                }
            } catch (e) {}
        }
        this._assetCache.set(cleaned, "");
        return "";
    }

    // ------------------------------------------------------------ lifecycle
    /**
     * Stops the companion and its settings page. When `keepProject` is false
     * (or omitted) the manager can be restarted through {@link restart}.
     */
    async stop(keepProject) {
        const backlog = this.pendingDevice;
        if (this.env) {
            try { await this.env.__zbStop(); } catch (e) {}
        }
        this.env = null;
        this.serviceDef = null;
        /* While reloading the companion of the same project the device app is
         * still running, so keep the packets it already sent. */
        this.pendingDevice = keepProject ? backlog : [];
        this.pendingCompanion = [];
        this.settingSource = null;
        this.settingError = null;
        this.enabled = false;
        this.status = "idle";
        if (!keepProject) {
            this.deviceReceivers.clear();
            this.session = null;
            this._emitState();
        }
    }

    /**
     * Drops everything belonging to the previous project. Must run before the
     * new app.js boots: the device app starts sending its handshake right
     * away, and those packets have to reach the new companion - not the
     * sandbox of the project that was loaded before.
     */
    async reset() {
        if (this._pending) {
            try { await this._pending; } catch (e) {}
        }
        await this.stop();
        this.legacyFraming = false;
        this.devicePort = DEFAULT_DEVICE_PORT;
        this.deviceAppId = 0;
    }

    async restart() {
        const path = this.projectPath;
        if (!path) return false;
        // Keep the device receivers: the running page runtimes must stay
        // connected to the freshly started companion.
        return this.loadProject(path);
    }

    _emitState() {
        this.onStateChanged.dispatch(this.status, {
            enabled: this.enabled,
            hasSetting: !!this.settingSource,
            session: this.session,
            error: this.lastError,
        });
    }
}
