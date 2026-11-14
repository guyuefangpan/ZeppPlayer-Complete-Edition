/*
    ZeppPlayer - app-side (companion / side-service) sandbox runtime
    Runs the phone-side companion script of a ZeppOS app inside the simulator,
    so it can talk to the device-side app through an in-process virtual link
    (no Bluetooth / no physical watch).

    The host surface mirrors what a real phone-side runtime exposes
    (and what OronBox implements): messaging, settings, sideService, getApp,
    fetch, Buffer, Logger/HmUtils and the AppSideService entry point.
    Part of the "last dance" ZeppPlayer extension. GPL-3.0 compatible.
*/

import { ZBuffer } from "./ZBuffer.js";

function toBytes(data) {
    if (data instanceof ZBuffer) return data;
    if (data instanceof Uint8Array) return new ZBuffer(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new ZBuffer(data);
    if (Array.isArray(data)) return new ZBuffer(Uint8Array.from(data));
    if (data == null) return ZBuffer.alloc(0);
    if (typeof data === "string") return ZBuffer.from(data, "utf8");
    return ZBuffer.from(JSON.stringify(data), "utf8");
}

function toText(data) {
    if (data == null) return "";
    if (typeof data === "string") return data;
    if (data instanceof ZBuffer || data instanceof Uint8Array) {
        return typeof data.toString === "function" ? data.toString("utf-8") : "";
    }
    try { return JSON.stringify(data); } catch (e) { return String(data); }
}

function zeppFormat(text, ...args) {
    let index = 0;
    return String(text).replace(/%([%sdif])/g, (all, type) => {
        if (type === "%") return "%";
        const value = args[index++];
        if (type === "d" || type === "i") return String(parseInt(value, 10));
        if (type === "f") return String(Number(value));
        return String(value == null ? "" : value);
    });
}

/**
 * Builds an isolated sandbox environment (its own keys are the parameter
 * names injected into the companion script, same trick as the device env).
 *
 * @param {object} host AppSideManager bridge:
 *   onConsole(tag, args), readSettings(), writeSettings(obj, origin),
 *   sendToDevice(ZBuffer), appName, appId, appVersion, i18nTable,
 *   screenWidth, designWidth
 */
export function createAppSideSandbox(host) {
    const env = {};

    // console ----------------------------------------------------------
    env.console = new Proxy({}, {
        get(_t, level) {
            if (level === "debug") level = "log";
            return (...args) => host.onConsole(String(level), args);
        }
    });

    // Logger / HmUtils --------------------------------------------------
    const logger = {
        log: (...args) => host.onConsole("log", args),
        debug: (...args) => host.onConsole("log", args),
        info: (...args) => host.onConsole("info", args),
        warn: (...args) => host.onConsole("warn", args),
        error: (...args) => host.onConsole("error", args),
    };
    const loggerFactory = {
        getLogger: () => logger,
        ...logger,
    };
    env.Logger = loggerFactory;
    env.HmLogger = logger;
    env.DeviceRuntimeCore = { HmLogger: loggerFactory };

    class ZeppLang {
        constructor(lang) { this.lang = lang || "en-US"; }
        getLang() { return this.lang; }
        setLang(lang) { this.lang = lang; }
    }
    const i18nTable = host.i18nTable || {};
    const defaultLang = host.defaultLanguage || "en-US";
    const langOf = (settings) => (settings && settings.lang) || defaultLang;

    function gettextFactory(table, current, fallback) {
        let lang = current instanceof ZeppLang ? current : new ZeppLang(current);
        const pick = (l) => (table && (table[l] || table[String(l).split("-")[0]])) || {};
        let messages = Object.assign({}, pick(defaultLang), pick(fallback), pick(lang.getLang()));
        const gettext = (id, ...args) => zeppFormat(messages[id] === undefined ? id : messages[id], ...args);
        gettext.locale = (locale) => {
            lang.setLang(locale);
            messages = Object.assign({}, pick(defaultLang), pick(fallback), pick(locale));
        };
        return gettext;
    }
    env.HmUtils = {
        Lang: ZeppLang,
        gettextFactory,
        getLanguage: (settings) => langOf(settings),
        getSideLanguage: (settings) => langOf(settings),
        getDeviceLanguage: () => defaultLang,
        format: zeppFormat,
        formatStrict: zeppFormat,
        printf: (message, ...args) => host.onConsole("log", [zeppFormat(message, ...args)]),
        sprintf: zeppFormat,
    };
    env.userSettings = { lang: defaultLang, language: defaultLang };

    // messaging / peerSocket -------------------------------------------
    const listeners = [];
    const peerSocket = {
        addListener(event, callback) {
            if (typeof callback !== "function") throw new TypeError("peerSocket listener must be a function");
            if (event === "message" && !listeners.includes(callback)) listeners.push(callback);
        },
        removeListener(event, callback) {
            if (event !== "message") return;
            const index = listeners.indexOf(callback);
            if (index !== -1) listeners.splice(index, 1);
        },
        send(data) {
            try { host.sendToDevice(toBytes(data)); }
            catch (e) { host.onConsole("error", ["peerSocket.send failed", e]); }
        }
    };
    env.messaging = { peerSocket };
    env.peerSocket = peerSocket;

    // sideService / getApp ---------------------------------------------
    env.sideService = {
        appInfo: {
            app: {
                appId: host.appId,
                appName: host.appName,
                appVersion: host.appVersion,
            }
        },
        launchReasons: host.launchReasons || {},
        launchArgs: host.launchArgs || {},
    };
    // A real companion always sits on the well-known side port 1004.
    env.getApp = () => ({
        port2: 1004,
        appId: host.appId,
        appName: host.appName,
        appVersion: host.appVersion,
    });

    // fetch -------------------------------------------------------------
    /* On a real watch the companion service talks to the network directly,
     * without the browser's CORS rules. Desktop and Android expose the same
     * origin-local /api/proxy endpoint; when it is missing (plain browser
     * build) the runtime falls back to window.fetch. */
    const decodeBase64 = (value) => {
        try {
            const binary = atob(value || "");
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes.buffer;
        } catch (e) {
            return new ArrayBuffer(0);
        }
    };

    /* ZeppOS defaults `response.body` to a parsed object for JSON payloads and
     * keeps plain text as a string. Text is therefore parsed opportunistically
     * unless the caller explicitly asked for another responseType. */
    const shapeBody = (request, text) => {
        const type = request.responseType;
        if (type === "text" || type === "arraybuffer") return text;
        const trimmed = String(text).trim();
        if (!trimmed || (trimmed.charAt(0) !== "{" && trimmed.charAt(0) !== "[")) return text;
        try { return JSON.parse(trimmed); } catch (e) { return text; }
    };

    const describeProxyResponse = (request, data) => {
        let body = data.body;
        if (data.base64) body = data.base64;
        else if (typeof body === "string") body = shapeBody(request, body);
        const asText = () => (typeof body === "string" ? body : JSON.stringify(body));
        return {
            url: data.url,
            status: data.status,
            statusText: data.statusText || "",
            headers: data.headers || {},
            body,
            redirected: false,
            type: "basic",
            ok: data.status >= 200 && data.status < 300,
            text: async () => asText(),
            json: async () => JSON.parse(asText()),
            arrayBuffer: async () => decodeBase64(data.base64 || ""),
            clone: function () { return describeProxyResponse(request, data); },
        };
    };

    const directFetch = (request) => {
        const init = Object.assign({}, request);
        delete init.url;
        delete init.responseType;
        return Promise.resolve(window.fetch(request.url, init)).then(async (response) => {
            const headers = {};
            try { response.headers.forEach((v, k) => { headers[k] = v; }); } catch (e) {}
            const text = await response.text();
            const body = shapeBody(request, text);
            return {
                url: response.url || request.url,
                status: response.status,
                statusText: response.statusText,
                headers,
                body,
                redirected: !!response.redirected,
                type: response.type || "basic",
                ok: response.status >= 200 && response.status < 300,
                text: async () => text,
                json: async () => JSON.parse(text),
                arrayBuffer: async () => {
                    try { return await response.arrayBuffer(); } catch (e) { return new ArrayBuffer(0); }
                },
                clone: () => response.clone ? response.clone() : response,
            };
        });
    };

    env.fetch = (input, options) => {
        const request = typeof input === "string" ? Object.assign({}, options || {}, { url: input }) : (input || {});
        if (!request.url) return Promise.reject(new Error("fetch: missing url"));
        const payload = {
            url: request.url,
            method: request.method || "GET",
            headers: request.headers || {},
            // Flat string form, for servers that parse JSON without nesting.
            headersJson: JSON.stringify(request.headers || {}),
            body: (request.body && typeof request.body === "object") ? JSON.stringify(request.body) : request.body,
        };
        return window.fetch("/api/proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }).then(async (response) => {
            if (!response.ok) throw new Error("proxy status " + response.status);
            const data = await response.json();
            if (!data || !data.ok) throw new Error((data && data.msg) || "proxy request failed");
            return describeProxyResponse(request, data);
        }).catch(() => directFetch(request));
    };

    // settings ----------------------------------------------------------
    const values = new Map();
    const initial = host.readSettings ? host.readSettings() : {};
    for (const key of Object.keys(initial || {})) {
        if (initial[key] !== undefined && initial[key] !== null) values.set(String(key), String(initial[key]));
    }
    const storageListeners = [];
    const persist = () => {
        const snapshot = {};
        for (const [k, v] of values) snapshot[k] = v;
        host.writeSettings(snapshot, "app-side");
    };
    const notify = (change) => {
        for (const callback of [...storageListeners]) {
            try { callback(change); } catch (e) { host.onConsole("error", [e]); }
        }
    };
    const settingsStorage = {
        get length() { return values.size; },
        getItem(key) {
            key = String(key);
            return values.has(key) ? values.get(key) : undefined;
        },
        setItem(key, value) {
            key = String(key);
            value = String(value);
            const oldValue = values.has(key) ? values.get(key) : undefined;
            values.set(key, value);
            persist();
            notify({ key, oldValue, newValue: value });
        },
        removeItem(key) {
            key = String(key);
            if (!values.has(key)) return;
            const oldValue = values.get(key);
            values.delete(key);
            persist();
            notify({ key, oldValue, newValue: undefined });
        },
        clear() {
            const entries = Array.from(values.entries());
            values.clear();
            persist();
            for (const [key, oldValue] of entries) notify({ key, oldValue, newValue: undefined });
        },
        key: (index) => Array.from(values.keys())[index] === undefined
            ? null
            : Array.from(values.keys())[index],
        toObject: () => Object.fromEntries(values),
        addListener(event, callback) {
            if (event !== "change") return;
            if (typeof callback !== "function") throw new TypeError("settingsStorage listener must be a function");
            if (!storageListeners.includes(callback)) storageListeners.push(callback);
        },
        removeListener(event, callback) {
            if (event !== "change") return;
            if (typeof callback !== "function") {
                storageListeners.length = 0;
                return;
            }
            const index = storageListeners.indexOf(callback);
            if (index !== -1) storageListeners.splice(index, 1);
        }
    };
    env.settings = { settingsStorage };
    env.settingsStorage = settingsStorage;

    /** The settings page (or the host) changed the stored values. */
    env.__zbSettingsChanged = (next) => {
        const previous = new Map(values);
        values.clear();
        for (const key of Object.keys(next || {})) {
            const value = next[key];
            if (value !== undefined && value !== null) values.set(String(key), String(value));
        }
        for (const key of new Set([...previous.keys(), ...values.keys()])) {
            const oldValue = previous.get(key);
            const newValue = values.get(key);
            if (oldValue !== newValue) notify({ key, oldValue, newValue });
        }
    };

    // AppSideService lifecycle ------------------------------------------
    let service = null;
    env.AppSideService = (def) => {
        service = def || {};
        env.appSideService = service;
    };
    env.registerApp = () => {};
    env.surround = () => {};

    env.__zbStart = async () => {
        if (!service) return;
        if (typeof service.onInit === "function") {
            try { await service.onInit(); }
            catch (e) { host.onConsole("error", ["AppSideService.onInit failed", e]); }
        }
        if (typeof service.onRun === "function") {
            try { await service.onRun(); }
            catch (e) { host.onConsole("error", ["AppSideService.onRun failed", e]); }
        }
    };
    env.__zbStop = async () => {
        if (!service) return;
        if (typeof service.onDestroy === "function") {
            try { await service.onDestroy(); }
            catch (e) { host.onConsole("error", ["AppSideService.onDestroy failed", e]); }
        }
        listeners.length = 0;
    };
    env.__zbInjectPeer = (bytes) => {
        const message = toBytes(bytes);
        for (const callback of listeners.slice()) {
            try { callback(message); }
            catch (e) { host.onConsole("error", ["peerSocket listener error", e]); }
        }
    };
    env.__zbGetServiceDef = () => service;

    // misc globals -------------------------------------------------------
    env.Buffer = ZBuffer;
    env.btoa = (s) => ZBuffer.from(String(s), "latin1").toString("base64");
    env.atob = (s) => ZBuffer.fromBase64(String(s)).toString("latin1");
    env.transferFile = undefined;

    /* The companion can download files into the watch storage and convert
     * images there. There is no phone<->watch file channel in the simulator,
     * so downloads are kept in memory and conversions are pass-through
     * copies. This keeps apps that fetch images working instead of throwing. */
    const downloadedFiles = new Map();
    env.network = {
        downloader: {
            downloadFile: async (options) => {
                const url = options && options.url;
                if (!url) throw new Error("downloadFile: missing url");
                const response = await env.fetch(url, { method: "GET" });
                const buffer = await response.arrayBuffer();
                const filePath = options.filePath || ("data://download/" + Date.now());
                downloadedFiles.set(filePath, new Uint8Array(buffer));
                return { status: response.status, filePath };
            },
        },
    };
    env.image = {
        convert: async (options) => {
            const source = options && options.filePath;
            const target = options && options.targetFilePath;
            if (source && target) downloadedFiles.set(target, downloadedFiles.get(source) || new Uint8Array(0));
            return { filePath: target };
        },
    };

    // Translation table consumed by the bundled `i18n` module helper.
    env.__zp_i18n = Object.assign(
        {},
        i18nTable["en-US"] || {},
        i18nTable[String(defaultLang).split("-")[0]] || {},
        i18nTable[defaultLang] || {}
    );
    env.__zp_screen_width = host.screenWidth || 0;
    env.__zp_design_width = host.designWidth || 0;

    env.globalThis = env;
    env.window = env;
    env.self = env;

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

export { toBytes, toText };
