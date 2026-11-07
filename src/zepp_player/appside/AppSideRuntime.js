/*
    ZeppPlayer - app-side (companion / side-service) sandbox runtime
    Runs the phone-side companion script (app-side.js) of a ZeppOS app
    inside the simulator, so it talks to the device-side app through an
    in-process virtual link (no Bluetooth / no physical watch).
    Part of the "last dance" ZeppPlayer extension. GPL-3.0 compatible.
*/

import { ZBuffer } from "./ZBuffer.js";

function toBytes(data) {
    if (data instanceof ZBuffer) return data;
    if (data instanceof Uint8Array) return new ZBuffer(data);
    if (data instanceof ArrayBuffer) return new ZBuffer(new Uint8Array(data));
    if (Array.isArray(data)) return new ZBuffer(Uint8Array.from(data));
    if (typeof data === "string") return ZBuffer.from(data, "utf8");
    return ZBuffer.from(JSON.stringify(data), "utf8");
}

/**
 * Builds an isolated sandbox environment (its own keys are the parameter
 * names injected into the companion script, same trick as the device env).
 *
 * @param {object} host AppSideManager bridge:
 *   onConsole(tag, args), readSettings(), writeSettings(obj),
 *   sendToDevice(ZBuffer), appName
 */
export function createAppSideSandbox(host) {
    const env = {};

    // console ----------------------------------------------------------
    env.console = new Proxy({}, {
        get(_t, level) {
            return (...args) => host.onConsole(String(level), args);
        }
    });

    // messaging / peerSocket -------------------------------------------
    const peerSocket = {
        _listeners: [],
        addListener(event, cb) {
            if (event !== "message") return;
            if (!this._listeners.includes(cb)) this._listeners.push(cb);
        },
        removeListener(event, cb) {
            if (event !== "message") return;
            this._listeners = this._listeners.filter(l => l !== cb);
        },
        send(data) {
            try { host.sendToDevice(toBytes(data)); }
            catch (e) { host.onConsole("error", ["peerSocket.send failed", e]); }
        },
        __receive(bytes) {
            const buf = toBytes(bytes);
            for (const cb of this._listeners.slice()) {
                try { cb(buf); } catch (e) {
                    host.onConsole("error", ["peerSocket listener error", e]);
                }
            }
            if (typeof this.onmessage === "function") {
                try { this.onmessage({ data: buf }); } catch (e) {
                    host.onConsole("error", ["peerSocket.onmessage error", e]);
                }
            }
        }
    };
    env.messaging = { peerSocket };
    env.peerSocket = peerSocket;

    // settings ----------------------------------------------------------
    const settingsStorage = {
        _onchange: [],
        read() { return host.readSettings(); },
        write(v) { host.writeSettings(v || {}); },
        getItem(key) {
            const d = host.readSettings();
            return (d && Object.prototype.hasOwnProperty.call(d, key)) ? d[key] : null;
        },
        setItem(key, value) {
            const d = host.readSettings();
            d[key] = value;
            host.writeSettings(d);
            for (const cb of this._onchange.slice()) {
                try { cb({ key, newValue: value }); } catch (e) {}
            }
        },
        removeItem(key) {
            const d = host.readSettings();
            delete d[key];
            host.writeSettings(d);
        },
        clear() { host.writeSettings({}); },
        addListener(cb) { this._onchange.push(cb); },
        removeListener(cb) {
            this._onchange = this._onchange.filter(l => l !== cb);
        },
        onchange: undefined
    };
    env.settings = { settingsStorage };
    env.settingsStorage = settingsStorage;

    // AppSideService lifecycle ------------------------------------------
    let serviceDef = null;
    env.AppSideService = (def) => { serviceDef = def || {}; };
    env.registerApp = () => {};
    env.surround = () => {};

    env.__zbStart = async () => {
        if (!serviceDef) return;
        const hooks = ["onInit", "onStart", "onRun", "onInstanceStart"];
        for (const h of hooks) {
            if (typeof serviceDef[h] !== "function") continue;
            try { await serviceDef[h](); }
            catch (e) { host.onConsole("error", [`AppSideService.${h} failed`, e]); }
        }
    };
    env.__zbStop = async () => {
        if (!serviceDef) return;
        if (typeof serviceDef.onDestroy === "function") {
            try { await serviceDef.onDestroy(); }
            catch (e) { host.onConsole("error", ["AppSideService.onDestroy failed", e]); }
        }
    };
    env.__zbInjectPeer = (bytes) => peerSocket.__receive(bytes);
    env.__zbGetServiceDef = () => serviceDef;

    // misc globals -------------------------------------------------------
    env.getApp = () => ({
        name: host.appName || "unknown",
        displayName: host.appName || "unknown"
    });
    env.Buffer = ZBuffer;
    env.btoa = (s) => (typeof btoa === "function" ? btoa(s) : "");
    env.atob = (s) => (typeof atob === "function" ? atob(s) : "");
    env.fetch = host.fetchFn || (typeof fetch === "function" ? fetch.bind(window) : undefined);
    env.globalThis = env;
    env.window = env;

    return env;
}

/**
 * Executes the companion source inside the sandbox env via `new Function`,
 * mirroring ZeppPlayer's device-side eval injection.
 */
export function runAppSideSource(env, source, sourceUrl) {
    const keys = Object.keys(env);
    const fn = new Function(...keys, source + (sourceUrl ? `\n//# sourceURL=${sourceUrl}` : ""));
    fn.apply(null, keys.map(k => env[k]));
    return env;
}