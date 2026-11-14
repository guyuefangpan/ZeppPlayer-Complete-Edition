/*
    Minimal ES module bundler for ZeppOS project scripts.

    ZeppOS sources are written as ES modules (`import`/`export`), while the
    simulator executes a single script per page/watchface. This module rewrites
    the whole dependency graph into a CommonJS-like registry so the existing
    eval-based runtime can run it unchanged.

    It is intentionally small: no transpiling of modern syntax (the runtime is
    a modern browser / Node), only module syntax rewriting plus resolution of
    relative paths, `zosLoader:` build-time imports and `@zos/*` system modules.
*/

const SYS_PREFIX = "@zos/";
const LOADER_PREFIX = "zosLoader:";

/* System modules are mapped onto the objects the runtime already injects into
 * the script scope (hmUI, hmFS, ...). The expressions below are emitted inside
 * the script wrapper, so they can see those identifiers. */
const SYS_MODULES = {
    "@zos/ui": `(typeof hmUI !== "undefined" ? hmUI : null)`,
    "@zos/utils": `{ log: (typeof Logger !== "undefined" && Logger) || (typeof DeviceRuntimeCore !== "undefined" && DeviceRuntimeCore.HmLogger) || { getLogger: function () { return console; } }, buffer: (typeof Buffer !== "undefined" ? Buffer : null), px: __zp_px }`,
    "@zos/app": `__zp_scene`,
    "@zos/device": `{ getDeviceInfo: function () { return (typeof hmSetting !== "undefined" && hmSetting.getDeviceInfo) ? hmSetting.getDeviceInfo() : { width: 480, height: 480, screenShape: 1, deviceName: "", keyNumber: 0 }; } }`,
    "@zos/router": `(typeof hmApp !== "undefined" ? hmApp : {})`,
    "@zos/display": `(typeof hmSetting !== "undefined" ? hmSetting : {})`,
    "@zos/settings": `(typeof hmSetting !== "undefined" ? hmSetting : {})`,
    "@zos/fs": `(typeof hmFS !== "undefined" ? hmFS : {})`,
    "@zos/timer": `(typeof timer !== "undefined" ? timer : {})`,
    "@zos/sensor": `(typeof hmSensor !== "undefined" ? hmSensor : {})`,
    "@zos/ble": `(typeof hmBle !== "undefined" ? hmBle : {})`,
    "@zos/interaction": `(typeof hmUI !== "undefined" ? hmUI : {})`,
    "@zos/storage": `{ localStorage: (typeof localStorage !== "undefined" ? localStorage : null) }`,
    "@zos/i18n": `{ getText: __zp_gettext, gettext: __zp_gettext }`,
    "@zos/notification": `{}`,
    "@zos/app-service": `{}`,
    "@zos/media": `{}`,
    "@zos/share": `{}`,
    "@zos/alarm": `{}`,
    "@zos/power": `{}`,
    "@zos/user-feedback": `{}`,

    /* ZeppOS apps built with @zeppos/zml. */
    "@zeppos/zml/base-side": `{ BaseSideService: __zp_base_side, BaseSideService_: __zp_base_side }`,
    "@zeppos/zml/base-page": `{ BasePage: __zp_base_page, BasePageService: __zp_base_page }`,
    "@zeppos/zml/base-service": `{ BaseSideService: __zp_base_side }`,
    "@zeppos/zml": `{ BaseSideService: __zp_base_side, BasePage: __zp_base_page }`,

    /* ZeppOS 1.x samples import system modules by bare name. */
    "i18n": `{ gettext: __zp_gettext, getText: __zp_gettext }`,
    "hmUI": `(typeof hmUI !== "undefined" ? hmUI : {})`,
    "hmFS": `(typeof hmFS !== "undefined" ? hmFS : {})`,
    "hmApp": `(typeof hmApp !== "undefined" ? hmApp : {})`,
    "hmSetting": `(typeof hmSetting !== "undefined" ? hmSetting : {})`,
    "hmSensor": `(typeof hmSensor !== "undefined" ? hmSensor : {})`,
    "hmBle": `(typeof hmBle !== "undefined" ? hmBle : {})`,
    "timer": `(typeof timer !== "undefined" ? timer : {})`,
};

function normalizePath(p) {
    const out = [];
    for (const part of String(p).split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") out.pop();
        else out.push(part);
    }
    return "/" + out.join("/");
}

function dirname(p) {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.substring(0, i);
}

function isRelative(spec) {
    return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
}

function quote(str) {
    return JSON.stringify(str);
}

/* Finds the end of a statement so `export const a = ..., b = ...` can be
 * rewritten without a real parser. Tracks strings, comments and brackets. */
function findStatementEnd(src, from) {
    let depth = 0;
    let quoteChar = null;
    let lineComment = false;
    let blockComment = false;

    for (let i = from; i < src.length; i++) {
        const c = src[i];
        const n = src[i + 1];

        if (lineComment) {
            if (c === "\n") lineComment = false;
            continue;
        }
        if (blockComment) {
            if (c === "*" && n === "/") { blockComment = false; i++; }
            continue;
        }
        if (quoteChar) {
            if (c === "\\") { i++; continue; }
            if (c === quoteChar) quoteChar = null;
            continue;
        }
        if (c === "/" && n === "/") { lineComment = true; i++; continue; }
        if (c === "/" && n === "*") { blockComment = true; i++; continue; }
        if (c === '"' || c === "'" || c === "`") { quoteChar = c; continue; }

        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") depth--;
        else if (depth === 0 && c === ";") return i;
        else if (depth === 0 && c === "\n") return i - 1;
    }
    return src.length - 1;
}

function splitTopLevel(text, separator) {
    const out = [];
    let depth = 0;
    let quoteChar = null;
    let current = "";

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoteChar) {
            current += c;
            if (c === "\\") { current += text[++i] || ""; continue; }
            if (c === quoteChar) quoteChar = null;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") { quoteChar = c; current += c; continue; }
        if (c === "(" || c === "{" || c === "[") depth++;
        if (c === ")" || c === "}" || c === "]") depth--;
        if (c === separator && depth === 0) {
            out.push(current);
            current = "";
            continue;
        }
        current += c;
    }
    out.push(current);
    return out;
}

function declaredNames(declaration) {
    const names = [];
    for (const rawPart of splitTopLevel(declaration, ",")) {
        const part = rawPart.trim();
        if (!part) continue;

        const ident = part.match(/^([\w$]+)/);
        if (ident) { names.push(ident[1]); continue; }

        const obj = part.match(/^\{([\s\S]*?)\}/);
        if (obj) {
            for (const entry of splitTopLevel(obj[1], ",")) {
                const m = entry.trim().match(/(?:^|\s)([\w$]+)(?:\s*:\s*([\w$]+))?\s*$/);
                if (m) names.push(m[2] || m[1]);
            }
            continue;
        }

        const arr = part.match(/^\[([\s\S]*?)\]/);
        if (arr) {
            for (const entry of splitTopLevel(arr[1], ",")) {
                const m = entry.trim().match(/([\w$]+)\s*$/);
                if (m) names.push(m[1]);
            }
        }
    }
    return names;
}

function buildImportClause(clause, requireExpr, counter) {
    const tmp = "__zp_m" + (counter.value++);
    const lines = ["const " + tmp + " = " + requireExpr + ";"];
    let rest = clause.trim();

    const defaultOnly = rest.match(/^([\w$]+)\s*(?:,\s*([\s\S]+))?$/);
    if (defaultOnly && rest.charAt(0) !== "{" && rest.charAt(0) !== "*") {
        lines.push("const " + defaultOnly[1] + " = " + tmp + ".default;");
        rest = (defaultOnly[2] || "").trim();
    }

    if (rest) {
        const ns = rest.match(/^\*\s*as\s+([\w$]+)$/);
        if (ns) {
            lines.push("const " + ns[1] + " = " + tmp + ";");
        } else {
            const named = rest.match(/^\{([\s\S]*)\}$/);
            if (named) {
                const bindings = splitTopLevel(named[1], ",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map((part) => {
                        const as = part.split(/\s+as\s+/);
                        return as.length === 2 ? as[0] + ": " + as[1] : part;
                    });
                if (bindings.length) lines.push("const { " + bindings.join(", ") + " } = " + tmp + ";");
            }
        }
    }

    return lines.join(" ");
}

function collectSpecifiers(src) {
    const specs = new Set();
    const fromRe = /(?:^|[\n;])[ \t]*import[ \t]+[\s\S]*?[ \t]+from[ \t]*(['"])([^'"\n]+)\1/g;
    const sideRe = /(?:^|[\n;])[ \t]*import[ \t]*(['"])([^'"\n]+)\1/g;
    const exportFromRe = /(?:^|[\n;])[ \t]*export[ \t]*(?:\*|\{[\s\S]*?\})[ \t]*from[ \t]*(['"])([^'"\n]+)\1/g;

    let m;
    while ((m = fromRe.exec(src))) specs.add(m[2]);
    while ((m = sideRe.exec(src))) specs.add(m[2]);
    while ((m = exportFromRe.exec(src))) specs.add(m[2]);
    return Array.from(specs);
}

/* Rewrites module syntax. `exprFor(spec)` returns the JS expression that loads
 * the imported module. */
function transformModule(src, exprFor) {
    const exported = [];
    const counter = {value: 0};

    src = src.replace(/(^|[\n;])([ \t]*)import[ \t]+([\s\S]*?)[ \t]+from[ \t]*(['"])([^'"\n]+)\4[ \t]*;?/g,
        (match, lead, indent, clause, q, spec) =>
            lead + indent + buildImportClause(clause, exprFor(spec), counter));

    src = src.replace(/(^|[\n;])([ \t]*)import[ \t]*(['"])([^'"\n]+)\3[ \t]*;?/g,
        (match, lead, indent, q, spec) =>
            lead + indent + exprFor(spec) + ";");

    /* export * from 'x' */
    src = src.replace(/(^|[\n;])([ \t]*)export[ \t]*\*[ \t]*from[ \t]*(['"])([^'"\n]+)\3[ \t]*;?/g,
        (match, lead, indent, q, spec) =>
            lead + indent + "Object.assign(__zp_exports, " + exprFor(spec) + ");");

    /* export { a, b as c } [from 'x'] */
    src = src.replace(/(^|[\n;])([ \t]*)export[ \t]*\{([^}]*)\}[ \t]*(?:from[ \t]*(['"])([^'"\n]+)\4)?[ \t]*;?/g,
        (match, lead, indent, list, q, spec) => {
            const parts = splitTopLevel(list, ",").map((s) => s.trim()).filter(Boolean);
            if (spec) {
                const tmp = "__zp_re" + (counter.value++);
                const out = [lead + indent + "const " + tmp + " = " + exprFor(spec) + ";"];
                for (const part of parts) {
                    const as = part.split(/\s+as\s+/);
                    const local = as[0];
                    const external = as.length === 2 ? as[1] : local;
                    out.push("__zp_exports." + external + " = " + tmp + "." + local + ";");
                }
                return out.join(" ");
            }
            const out = [];
            for (const part of parts) {
                const as = part.split(/\s+as\s+/);
                const local = as[0];
                const external = as.length === 2 ? as[1] : local;
                out.push("__zp_exports." + external + " = " + local + ";");
            }
            return lead + indent + out.join(" ");
        });

    /* export default ... */
    src = src.replace(/(^|[\n;])([ \t]*)export[ \t]+default[ \t]+/g,
        (match, lead, indent) => lead + indent + "__zp_exports.default = ");

    /* export function/class */
    src = src.replace(/(^|[\n;])([ \t]*)export[ \t]+((?:async[ \t]+)?function[ \t]*\*?[ \t]*([\w$]+)|class[ \t]+([\w$]+))/g,
        (match, lead, indent, decl, fnName, clsName) => {
            const name = fnName || clsName;
            if (name) exported.push(name);
            return lead + indent + decl;
        });

    /* export const/let/var */
    const declRe = /(^|[\n;])([ \t]*)export[ \t]+(const|let|var)[ \t]+/g;
    const edits = [];
    let m;
    while ((m = declRe.exec(src))) {
        const bodyStart = m.index + m[0].length;
        const end = findStatementEnd(src, bodyStart);
        const declaration = src.substring(bodyStart, end + 1);
        for (const name of declaredNames(declaration)) exported.push(name);
        /* Keep const/let/var: destructuring exports such as
         * `export const { a } = getDeviceInfo()` are invalid without it. */
        edits.push({from: m.index + m[1].length, to: bodyStart, text: m[2] + m[3] + " "});
        declRe.lastIndex = end + 1;
    }
    for (let i = edits.length - 1; i >= 0; i--) {
        const e = edits[i];
        src = src.substring(0, e.from) + e.text + src.substring(e.to);
    }

    if (exported.length) {
        const tail = exported.map((name) => "__zp_exports." + name + " = " + name + ";").join(" ");
        src += "\n" + tail;
    }

    return src;
}

const HEADER = `
const __zp_defs = Object.create(null);
const __zp_cache = Object.create(null);

/* Design-pixel helper. The simulator renders at the emulated screen size while
 * ZeppOS sources use the target's designWidth, so scale when both are known. */
function __zp_px(__zp_v) {
    if (typeof __zp_design_width === "number" && __zp_design_width > 0
        && typeof __zp_screen_width === "number" && __zp_screen_width > 0)
        return Math.round(__zp_v * __zp_screen_width / __zp_design_width);
    return __zp_v;
}

/* Translation lookup backed by the project's app.json i18n tables. */
function __zp_gettext(__zp_key) {
    return (typeof __zp_i18n !== "undefined" && __zp_i18n && __zp_i18n[__zp_key]) || __zp_key;
}

/* Wraps a system object so it can be imported as a module namespace. A Proxy
 * keeps method calls bound to the real object instead of a derived copy. */
function __zp_ns(__zp_target) {
    if (!__zp_target) return {};
    if (typeof Proxy === "undefined") return __zp_target;
    return new Proxy(__zp_target, {
        get: function (__zp_t, __zp_k) {
            if (__zp_k === "default") return __zp_t;
            return __zp_t[__zp_k];
        },
        has: function (__zp_t, __zp_k) {
            return __zp_k === "default" || __zp_k in __zp_t;
        },
    });
}

const __zp_scene = {
    SCENE_NORMAL: 0,
    SCENE_AOD: 1,
    SCENE_APP: 2,
    SCENE_WIDGET: 3,
    getScene: function () {
        try {
            if (typeof hmSetting === "undefined" || !hmSetting.getScreenType) return 0;
            return hmSetting.getScreenType() === hmSetting.screen_type.AOD ? 1 : 0;
        } catch (e) {
            return 0;
        }
    },
    getAppInfo: function () { return {appId: 0, appName: ""}; },
};

/* ---------------------------- ZML (zml.js) compatibility ------------------
 * ZeppOS apps built with @zeppos/zml talk JSON envelopes over peerSocket.
 * The real library ships a binary protocol for Bluetooth; inside the
 * simulator both sides share this lightweight, wire-compatible-with-itself
 * version so requests/calls still work end to end. */
function __zp_zmlListen(__zp_cb) {
    const __zp_fn = function (__zp_raw) {
        let __zp_text = __zp_raw;
        if (__zp_text && typeof __zp_text === "object" && !(typeof Uint8Array !== "undefined" && __zp_text instanceof Uint8Array)) {
            if (__zp_text.data !== undefined) __zp_text = __zp_text.data;
        }
        if (typeof __zp_text !== "string") {
            try {
                __zp_text = (typeof __zp_text.toString === "function")
                    ? __zp_text.toString("utf-8")
                    : String(__zp_text);
            } catch (e) { return; }
        }
        let __zp_msg = null;
        try { __zp_msg = JSON.parse(__zp_text); } catch (e) { return; }
        if (!__zp_msg || typeof __zp_msg !== "object" || !__zp_msg.__zp_zml) return;
        __zp_cb(__zp_msg);
    };
    try { messaging.peerSocket.addListener("message", __zp_fn); } catch (e) {}
    return __zp_fn;
}

function __zp_zmlUnlisten(__zp_fn) {
    try { messaging.peerSocket.removeListener("message", __zp_fn); } catch (e) {}
}

function __zp_zmlSend(__zp_msg) {
    __zp_msg.__zp_zml = 1;
    try { messaging.peerSocket.send(JSON.stringify(__zp_msg)); } catch (e) {}
}

function __zp_base_side(__zp_opts) {
    __zp_opts = __zp_opts || {};
    const __zp_pending = Object.create(null);
    let __zp_seq = 0;
    let __zp_listener = null;

    const __zp_respond = function (__zp_id, __zp_error, __zp_result) {
        const __zp_payload = {type: "response", id: __zp_id, result: __zp_result};
        if (__zp_error) __zp_payload.error = String(__zp_error.message || __zp_error);
        __zp_zmlSend(__zp_payload);
    };

    return Object.assign({}, __zp_opts, {
        onInit: function () {
            __zp_listener = __zp_zmlListen(function (__zp_msg) {
                if (__zp_msg.type === "response") {
                    const __zp_wait = __zp_pending[__zp_msg.id];
                    if (!__zp_wait) return;
                    delete __zp_pending[__zp_msg.id];
                    if (__zp_msg.error) __zp_wait.reject(new Error(__zp_msg.error));
                    else __zp_wait.resolve(__zp_msg.result);
                    return;
                }
                if (__zp_msg.type === "call") {
                    if (typeof __zp_opts.onCall === "function") {
                        try { __zp_opts.onCall(__zp_msg.payload, __zp_msg.method); } catch (e) {}
                    }
                    return;
                }
                if (__zp_msg.type === "request") {
                    const __zp_req = Object.assign({}, __zp_msg.payload || {}, {
                        method: __zp_msg.method,
                        params: (__zp_msg.payload && __zp_msg.payload.params) || __zp_msg.params,
                    });
                    try {
                        if (typeof __zp_opts.onRequest === "function") {
                            __zp_opts.onRequest(__zp_req, function (__zp_err, __zp_res) {
                                __zp_respond(__zp_msg.id, __zp_err, __zp_res);
                            });
                        } else {
                            __zp_respond(__zp_msg.id, new Error("no onRequest handler"));
                        }
                    } catch (e) {
                        __zp_respond(__zp_msg.id, e);
                    }
                }
            });
            try {
                if (typeof settings !== "undefined" && settings.settingsStorage
                    && typeof settings.settingsStorage.addListener === "function") {
                    settings.settingsStorage.addListener("change", function () {
                        if (typeof __zp_opts.onSettingsChange !== "function") return;
                        try {
                            __zp_opts.onSettingsChange(settings.settingsStorage.toObject
                                ? settings.settingsStorage.toObject()
                                : {});
                        } catch (e) {}
                    });
                }
            } catch (e) {}
            if (typeof __zp_opts.onInit === "function") return __zp_opts.onInit();
        },
        onDestroy: function () {
            if (__zp_listener) __zp_zmlUnlisten(__zp_listener);
            __zp_listener = null;
            if (typeof __zp_opts.onDestroy === "function") return __zp_opts.onDestroy();
        },
        call: function (__zp_payload, __zp_method) {
            __zp_zmlSend({type: "call", method: __zp_method, payload: __zp_payload});
        },
        request: function (__zp_payload, __zp_method) {
            return new Promise(function (__zp_resolve, __zp_reject) {
                const __zp_id = ++__zp_seq;
                __zp_pending[__zp_id] = {resolve: __zp_resolve, reject: __zp_reject};
                __zp_zmlSend({type: "request", id: __zp_id, method: __zp_method, payload: __zp_payload});
            });
        },
    });
}

function __zp_base_page(__zp_cfg) {
    __zp_cfg = __zp_cfg || {};
    const __zp_pending = Object.create(null);
    let __zp_seq = 0;
    __zp_zmlListen(function (__zp_msg) {
        if (__zp_msg.type !== "response") return;
        const __zp_wait = __zp_pending[__zp_msg.id];
        if (!__zp_wait) return;
        delete __zp_pending[__zp_msg.id];
        if (__zp_msg.error) __zp_wait.reject(new Error(__zp_msg.error));
        else __zp_wait.resolve(__zp_msg.result);
    });
    return Object.assign({}, __zp_cfg, {
        call: function (__zp_payload, __zp_method) {
            __zp_zmlSend({type: "call", method: __zp_method, payload: __zp_payload});
        },
        request: function (__zp_payload, __zp_callback, __zp_method) {
            const __zp_promise = new Promise(function (__zp_resolve, __zp_reject) {
                const __zp_id = ++__zp_seq;
                __zp_pending[__zp_id] = {resolve: __zp_resolve, reject: __zp_reject};
                __zp_zmlSend({type: "request", id: __zp_id, method: __zp_method, payload: __zp_payload});
            });
            if (typeof __zp_callback === "function") {
                __zp_promise.then(function (__zp_res) { __zp_callback(null, __zp_res); },
                    function (__zp_err) { __zp_callback(__zp_err); });
                return;
            }
            return __zp_promise;
        },
    });
}

function __zp_sys(__zp_id) {
    switch (__zp_id) {
__ZP_SYS_CASES__
    }
    console.warn("[ZeppPlayer] Unknown ZeppOS module: " + __zp_id);
    return {};
}

function __zp_require(__zp_id) {
    if (__zp_id in __zp_cache) return __zp_cache[__zp_id].exports;
    const __zp_def = __zp_defs[__zp_id];
    if (!__zp_def) throw new Error("Module not found: " + __zp_id);
    const __zp_mod = {exports: {}};
    __zp_cache[__zp_id] = __zp_mod;
    __zp_def(__zp_mod, __zp_mod.exports, __zp_require);
    return __zp_mod.exports;
}
`;

function buildSystemCases() {
    return Object.keys(SYS_MODULES)
        .map((id) => `        case ${quote(id)}: return __zp_ns(${SYS_MODULES[id]});`)
        .join("\n");
}

/**
 * Builds the executable body for an entry module.
 *
 * @param {string} entryPath  Project path of the entry script (e.g. /projects/x/app.js)
 * @param {{loadText: (path: string) => Promise<string|null>, platform?: "r"|"s"}} options
 * @returns {Promise<string>} code to embed inside the runtime's script wrapper
 */
export async function bundleModule(entryPath, options) {
    const loadText = options.loadText;
    const platform = options.platform === "s" ? "s" : "r";

    const textCache = new Map();
    const modules = new Map();
    const pending = new Set();
    const order = [];

    const readText = async (path) => {
        if (textCache.has(path)) return textCache.get(path);
        let text = null;
        try {
            text = await loadText(path);
        } catch (e) {
            text = null;
        }
        textCache.set(path, text);
        return text;
    };

    const tryFiles = async (candidates) => {
        for (const candidate of candidates) {
            const text = await readText(candidate);
            if (text !== null && text !== undefined) return {path: candidate, text};
        }
        return null;
    };

    const resolve = async (spec, fromPath) => {
        if (spec.startsWith(SYS_PREFIX)) return {sys: spec};

        if (spec.startsWith(LOADER_PREFIX)) {
            const rel = spec.substring(LOADER_PREFIX.length);
            const base = normalizePath(dirname(fromPath) + "/" + rel.replace(/\[pf\]/g, platform));
            const other = platform === "r" ? "s" : "r";
            const alt = normalizePath(dirname(fromPath) + "/" + rel.replace(/\[pf\]/g, other));
            const found = await tryFiles(base === alt ? [base] : [base, alt]);
            if (!found) throw new Error("Cannot resolve build-time import " + spec + " from " + fromPath);
            return {path: found.path, text: found.text};
        }

        if (!isRelative(spec)) {
            /* Bare specifiers are either system modules or npm packages, which
             * ZeppOS resolves at build time. Treat them as system modules. */
            return {sys: spec};
        }

        const base = normalizePath(dirname(fromPath) + "/" + spec);
        const candidates = [];
        if (/\.js$/.test(base)) candidates.push(base);
        else {
            candidates.push(base + ".js");
            candidates.push(base + "/index.js");
        }
        const found = await tryFiles(candidates);
        if (!found) throw new Error("Cannot resolve import '" + spec + "' from " + fromPath);
        return {path: found.path, text: found.text};
    };

    const compile = async (path, text) => {
        if (modules.has(path) || pending.has(path)) return;
        pending.add(path);

        const specifiers = collectSpecifiers(text);
        const expressions = new Map();
        const deps = [];

        for (const spec of specifiers) {
            const resolved = await resolve(spec, path);
            if (resolved.sys) {
                expressions.set(spec, "__zp_sys(" + quote(resolved.sys) + ")");
            } else {
                expressions.set(spec, "__zp_require(" + quote(resolved.path) + ")");
                deps.push(resolved);
            }
        }

        const code = transformModule(text, (spec) => {
            const expr = expressions.get(spec);
            if (!expr) throw new Error("Unresolved import '" + spec + "' in " + path);
            return expr;
        });

        modules.set(path, code);
        order.push(path);
        pending.delete(path);

        for (const dep of deps) await compile(dep.path, dep.text);
    };

    const entryText = await readText(entryPath);
    if (entryText === null || entryText === undefined) throw new Error("Cannot load script " + entryPath);
    await compile(entryPath, entryText);

    const defs = order
        .map((path) =>
            "__zp_defs[" + quote(path) + "] = function (__zp_module, __zp_exports, __zp_require) {\n"
            + modules.get(path)
            + "\n};")
        .join("\n\n");

    return HEADER.replace("__ZP_SYS_CASES__", buildSystemCases())
        + "\n" + defs
        + "\n\n__zp_require(" + quote(entryPath) + ");\n";
}
