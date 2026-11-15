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
    "@zos/router": `__zp_router`,
    "@zos/display": `(typeof hmSetting !== "undefined" ? hmSetting : {})`,
    "@zos/settings": `(typeof hmSetting !== "undefined" ? hmSetting : {})`,
    "@zos/fs": `(typeof hmFS !== "undefined" ? hmFS : {})`,
    "@zos/timer": `(typeof timer !== "undefined" ? timer : {})`,
    "@zos/sensor": `(typeof hmSensor !== "undefined" ? hmSensor : {})`,
    "@zos/ble": `(typeof hmBle !== "undefined" ? hmBle : {})`,
    "@zos/interaction": `(typeof hmUI !== "undefined" ? hmUI : {})`,
    "@zos/page": `__zp_page`,
    "@zos/storage": `{ localStorage: __zp_local_storage, LocalStorage: __zp_LocalStorage, TypedStorage: __zp_TypedStorage, sessionStorage: __zp_local_storage }`,
    "@zos/share-storage": `__zp_share_storage`,
    "@zos/crypto": `__zp_crypto`,
    "@zos/user": `__zp_user`,
    "@zos/app-access": `__zp_app_access`,
    "@zos/transfer-file": `{ TransferFile: __zp_TransferFile }`,
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
    "@zeppos/zml/base-app": `{ BaseApp: __zp_base_app, default: __zp_base_app }`,
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
    const fromRe = /(?:^|[\n;])[ \t]*import[ \t]+((?:[^'"\n]|\{[^}]*\})*?)[ \t]+from[ \t]*(['"])([^'"\n]+)\2/g;
    const sideRe = /(?:^|[\n;])[ \t]*import[ \t]*(['"])([^'"\n]+)\1/g;
    const exportFromRe = /(?:^|[\n;])[ \t]*export[ \t]*(?:\*|\{[\s\S]*?\})[ \t]*from[ \t]*(['"])([^'"\n]+)\1/g;

    let m;
    /* fromRe: (1) clause (2) quote (3) spec */
    while ((m = fromRe.exec(src))) specs.add(m[3]);
    while ((m = sideRe.exec(src))) specs.add(m[2]);
    while ((m = exportFromRe.exec(src))) specs.add(m[2]);
    return Array.from(specs);
}

/* Rewrites module syntax. `exprFor(spec)` returns the JS expression that loads
 * the imported module. */
function transformModule(src, exprFor) {
    const exported = [];
    const counter = {value: 0};

    /* The import clause may wrap lines only inside `{ ... }`. Allowing a bare
     * newline here made the match swallow a preceding side-effect import
     * (`import './buffer'`), which silently dropped the following named
     * imports (`import { EventBus } from './event'`). */
    src = src.replace(/(^|[\n;])([ \t]*)import[ \t]+((?:[^'"\n]|\{[^}]*\})*?)[ \t]+from[ \t]*(['"])([^'"\n]+)\4[ \t]*;?/g,
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

/* ------------------------- @zos/storage --------------------------------
 * The device exposes a LocalStorage constructor plus a ready-made
 * localStorage instance. Both share one store per project, mirroring the
 * per-app sandbox on a real watch. */
const __zp_project_scope = (typeof __zp_project_url === "string" ? __zp_project_url : "")
    .split("/").filter(function (__zp_part) { return !!__zp_part; })[1] || "";

function __zp_storage_key(__zp_k) {
    return "__zp_ls:" + __zp_project_scope + ":" + String(__zp_k);
}

/* Official LocalStorage keeps JSON values, not just strings: apps store
 * arrays/objects directly and expect them back after a page switch. Raw
 * strings saved by older builds are still decoded correctly. */
function __zp_lsDecode(__zp_raw, __zp_default) {
    if (__zp_raw === null || __zp_raw === undefined) return __zp_default;
    try {
        return JSON.parse(__zp_raw);
    } catch (e) {
        return __zp_raw;
    }
}

function __zp_LocalStorage() {
    this.getItem = function (__zp_k, __zp_default) {
        let __zp_raw = null;
        try { __zp_raw = window.localStorage.getItem(__zp_storage_key(__zp_k)); } catch (e) {}
        return __zp_lsDecode(__zp_raw, __zp_default);
    };
    this.setItem = function (__zp_k, __zp_v) {
        try {
            let __zp_text;
            try {
                __zp_text = JSON.stringify(__zp_v);
            } catch (e) {
                __zp_text = String(__zp_v);
            }
            window.localStorage.setItem(__zp_storage_key(__zp_k), __zp_text === undefined ? "" : __zp_text);
        } catch (e) {}
    };
    this.removeItem = function (__zp_k) {
        try { window.localStorage.removeItem(__zp_storage_key(__zp_k)); } catch (e) {}
    };
    this.clear = function () {
        try {
            const __zp_store = window.localStorage;
            const __zp_prefix = "__zp_ls:" + __zp_project_scope + ":";
            const __zp_keys = [];
            for (let __zp_i = 0; __zp_i < __zp_store.length; __zp_i++) {
                const __zp_k = __zp_store.key(__zp_i);
                if (__zp_k && __zp_k.indexOf(__zp_prefix) === 0) __zp_keys.push(__zp_k);
            }
            for (const __zp_k of __zp_keys) __zp_store.removeItem(__zp_k);
        } catch (e) {}
    };
    this.getAllKeys = function () {
        const __zp_out = [];
        try {
            const __zp_store = window.localStorage;
            const __zp_prefix = "__zp_ls:" + __zp_project_scope + ":";
            for (let __zp_i = 0; __zp_i < __zp_store.length; __zp_i++) {
                const __zp_k = __zp_store.key(__zp_i);
                if (__zp_k && __zp_k.indexOf(__zp_prefix) === 0) __zp_out.push(__zp_k.substring(__zp_prefix.length));
            }
        } catch (e) {}
        return __zp_out;
    };
}

const __zp_local_storage = new __zp_LocalStorage();

/* --------------------------- @zos/router ------------------------------- */
const __zp_router = {
    push: function (__zp_conf) {
        try {
            __zp_conf = __zp_conf || {};
            /* @zos/router calls it params, hmApp.gotoPage calls it param. */
            const __zp_param = __zp_conf.params !== undefined ? __zp_conf.params : __zp_conf.param;
            if (typeof hmApp !== "undefined" && hmApp.gotoPage) {
                hmApp.gotoPage({url: __zp_conf.url, param: __zp_param});
            }
        } catch (e) {}
    },
    replace: function (__zp_conf) { __zp_router.push(__zp_conf); },
    back: function () { try { if (typeof hmApp !== "undefined" && hmApp.goBack) hmApp.goBack(); } catch (e) {} },
    home: function () { try { if (typeof hmApp !== "undefined" && hmApp.gotoHome) hmApp.gotoHome(); } catch (e) {} },
    relaunch: function () { try { if (typeof hmApp !== "undefined" && hmApp.reloadPage) hmApp.reloadPage({url: ""}); } catch (e) {} },
    getPages: function () { return []; },
    exit: function () { try { if (typeof hmApp !== "undefined" && hmApp.exit) hmApp.exit(); } catch (e) {} },
    launchApp: function (__zp_conf) {
        try {
            __zp_conf = __zp_conf || {};
            if (typeof hmApp !== "undefined" && hmApp.gotoPage) {
                hmApp.gotoPage({url: __zp_conf.url, param: __zp_conf.params});
            }
        } catch (e) {}
    },
    getAppIdByName: function () { return 0; },
    checkSystemApp: function () { return false; },
    setLaunchAppTimeout: function () { return 0; },
    clearLaunchAppTimeout: function () { return 0; },
};

/* ---------------------------- @zos/page --------------------------------
 * Page-level switches have no visual effect inside the simulator, but the
 * calls must exist so pages importing them do not crash. */
const __zp_page = {
    setScrollLock: function () {},
    getScrollLock: function () { return false; },
    setPageBrightTime: function () {},
    setScreenKeep: function () {},
    pauseDropWristScreenOff: function () {},
    resetDropWristScreenOff: function () {},
    setStatusBarVisible: function () {},
    setNavigationBarVisible: function () {},
    scrollTo: function (__zp_conf) {
        try {
            __zp_conf = __zp_conf || {};
            if (typeof hmUI !== "undefined" && hmUI.setScrollView) {
                hmUI.setScrollView(true, __zp_conf.y || 0, 1);
            }
        } catch (e) {}
    },
    getScrollTop: function () { return 0; },
    setScrollMode: function () {},
    getSwiperIndex: function () { return 0; },
    swipeToIndex: function () {},
};

/* ---------------------------- @zos/user -------------------------------- */
const __zp_user = {
    getProfile: function () {
        try {
            if (typeof hmSetting !== "undefined" && hmSetting.getUserData) return hmSetting.getUserData();
        } catch (e) {}
        return {age: 20, height: 180, weight: 55.5, gender: 0, nickName: "", region: "cn"};
    },
    addHealthData: function () { return true; },
    getStep: function () { return 0; },
};

/* ------------------------- @zos/app-access ----------------------------- */
const __zp_app_access = {
    getSportData: function () { return {}; },
    getPackageInfo: function () { return {appId: 0, appName: "", version: "1.0.0"}; },
    getAppInfo: function () { return {appId: 0, appName: ""}; },
};

/* --------------------------- @zos/storage ------------------------------ */
function __zp_TypedStorage(__zp_conf) {
    __zp_conf = __zp_conf || {};
    const __zp_ns = __zp_conf.name || __zp_conf.namespace || "typed";
    const __zp_inner = new __zp_LocalStorage();
    const __zp_prefix = __zp_ns + ":";
    this.setItem = function (__zp_k, __zp_v) { __zp_inner.setItem(__zp_prefix + __zp_k, __zp_v); };
    this.getItem = function (__zp_k, __zp_def) { return __zp_inner.getItem(__zp_prefix + __zp_k, __zp_def); };
    this.removeItem = function (__zp_k) { __zp_inner.removeItem(__zp_prefix + __zp_k); };
    this.clear = function () {
        const __zp_keys = this.getAllKeys();
        for (let __zp_i = 0; __zp_i < __zp_keys.length; __zp_i++) this.removeItem(__zp_keys[__zp_i]);
    };
    this.getAllKeys = function () {
        return __zp_inner.getAllKeys()
            .filter(function (__zp_k) { return __zp_k.indexOf(__zp_prefix) === 0; })
            .map(function (__zp_k) { return __zp_k.substring(__zp_prefix.length); });
    };
}

const __zp_share_storage = {
    LocalStorage: __zp_LocalStorage,
    TypedStorage: __zp_TypedStorage,
    FileSystem: (typeof hmFS !== "undefined" ? hmFS : null),
    getSharedLocalStorage: function () { return __zp_local_storage; },
};

/* ---------------------------- @zos/crypto ------------------------------
 * The simulator only needs the calls to exist and to round-trip their own
 * output, so a lightweight XOR "cipher" and FNV based digest are used. */
function __zp_toBytes(__zp_input) {
    if (__zp_input === null || __zp_input === undefined) return new Uint8Array(0);
    if (typeof __zp_input === "string") {
        if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(__zp_input);
        const __zp_out = new Uint8Array(__zp_input.length);
        for (let __zp_i = 0; __zp_i < __zp_input.length; __zp_i++) __zp_out[__zp_i] = __zp_input.charCodeAt(__zp_i) & 0xff;
        return __zp_out;
    }
    if (typeof __zp_input === "object" && __zp_input.buffer) {
        return new Uint8Array(__zp_input.buffer, __zp_input.byteOffset || 0, __zp_input.byteLength);
    }
    try {
        return new Uint8Array(__zp_input);
    } catch (e) {
        return new Uint8Array(0);
    }
}

function __zp_unwrap(__zp_data) {
    if (__zp_data && typeof __zp_data === "object" && __zp_data.data !== undefined) return __zp_data.data;
    return __zp_data;
}

function __zp_xorBytes(__zp_input, __zp_key) {
    const __zp_src = __zp_toBytes(__zp_input);
    const __zp_keyBytes = __zp_toBytes(__zp_key === undefined || __zp_key === null ? "" : __zp_key);
    const __zp_out = new Uint8Array(__zp_src.length);
    for (let __zp_i = 0; __zp_i < __zp_src.length; __zp_i++) {
        __zp_out[__zp_i] = __zp_src[__zp_i] ^ (__zp_keyBytes.length ? __zp_keyBytes[__zp_i % __zp_keyBytes.length] : 0);
    }
    return __zp_out;
}

function __zp_AESCrypto(__zp_conf) {
    __zp_conf = __zp_conf || {};
    const __zp_key = __zp_conf.key !== undefined ? __zp_conf.key : (__zp_conf.secretKey || __zp_conf.iv || "");
    this.encrypt = function (__zp_data) { return __zp_xorBytes(__zp_unwrap(__zp_data), __zp_key); };
    this.decrypt = function (__zp_data) { return __zp_xorBytes(__zp_unwrap(__zp_data), __zp_key); };
}

function __zp_digestHex(__zp_input) {
    const __zp_src = __zp_toBytes(__zp_unwrap(__zp_input));
    let __zp_h = 2166136261;
    let __zp_out = "";
    for (let __zp_round = 0; __zp_round < 4; __zp_round++) {
        for (let __zp_i = 0; __zp_i < __zp_src.length; __zp_i++) {
            __zp_h ^= __zp_src[__zp_i] + __zp_round;
            __zp_h = Math.imul(__zp_h, 16777619) >>> 0;
        }
        __zp_out += ("0000000" + __zp_h.toString(16)).slice(-8);
    }
    return __zp_out;
}

function __zp_DigestCrypto() {
    this.create = function () {
        return {
            digest: function (__zp_data) { return __zp_digestHex(__zp_data); },
            update: function () { return this; },
            reset: function () {},
        };
    };
    this.digest = function (__zp_data) { return __zp_digestHex(__zp_data); };
}

function __zp_CRCCrypto() {
    this.create = function () {
        return {
            calc: function (__zp_data) {
                const __zp_src = __zp_toBytes(__zp_unwrap(__zp_data));
                let __zp_crc = 0xffffffff;
                for (let __zp_i = 0; __zp_i < __zp_src.length; __zp_i++) {
                    __zp_crc ^= __zp_src[__zp_i];
                    for (let __zp_b = 0; __zp_b < 8; __zp_b++) {
                        __zp_crc = (__zp_crc >>> 1) ^ (__zp_crc & 1 ? 0xedb88320 : 0);
                    }
                }
                return (__zp_crc ^ 0xffffffff) >>> 0;
            },
        };
    };
    this.calc = function (__zp_data) { return this.create().calc(__zp_data); };
}

function __zp_ECDSACrypto(__zp_conf) {
    __zp_conf = __zp_conf || {};
    this.sign = function (__zp_data) { return __zp_digestHex(__zp_data); };
    this.verify = function () { return true; };
    this.getPublicKey = function () { return __zp_conf.publicKey || ""; };
}

const __zp_crypto = {
    AESCrypto: __zp_AESCrypto,
    DigestCrypto: __zp_DigestCrypto,
    CRCCrypto: __zp_CRCCrypto,
    ECDSACrypto: __zp_ECDSACrypto,
    Digest: {MD5: 0, SHA1: 1, SHA256: 2},
    CRC: {CRC16: 0, CRC32: 1},
    AES: {CBC: 0, ECB: 1, CTR: 2},
    encryptKey: function (__zp_key) { return String(__zp_key === undefined ? "" : __zp_key); },
    getRandomValues: function (__zp_array) {
        try {
            if (typeof crypto !== "undefined" && crypto.getRandomValues) return crypto.getRandomValues(__zp_array);
        } catch (e) {}
        for (let __zp_i = 0; __zp_i < __zp_array.length; __zp_i++) {
            __zp_array[__zp_i] = Math.floor(Math.random() * 256);
        }
        return __zp_array;
    },
};

/* ------------------------- @zos/transfer-file -------------------------- */
function __zp_TransferFile(__zp_conf) {
    this.conf = __zp_conf || {};
    this.listeners = {};
    this.init = function () { return 0; };
    this.send = function (__zp_data, __zp_cb) {
        if (typeof __zp_cb === "function") __zp_cb({success: false});
        return 0;
    };
    this.start = function (__zp_data, __zp_cb) { return this.send(__zp_data, __zp_cb); };
    this.cancel = function () { return 0; };
    this.on = function (__zp_event, __zp_cb) { this.listeners[__zp_event] = __zp_cb; };
    this.off = function (__zp_event) { delete this.listeners[__zp_event]; };
    this.getProgress = function () { return 0; };
}


/* --------------------------- @zeppos/zml/base-app ------------------------ */
function __zp_base_app(__zp_cfg) {
    return __zp_cfg || {};
}


/* ---------------------------- ZML (zml.js) compatibility ------------------
 * ZeppOS apps built with @zeppos/zml talk JSON envelopes over peerSocket.
 * The real library ships a binary protocol for Bluetooth; inside the
 * simulator both sides share this lightweight, wire-compatible-with-itself
 * version so requests/calls still work end to end. */
/* peerSocket delivers either a string, a typed array or a buffer object with a
 * utf-8 aware toString(). Plain Uint8Array#toString() joins byte values with
 * commas, which used to break JSON parsing. */
function __zp_zmlDecode(__zp_raw) {
    if (__zp_raw === null || __zp_raw === undefined) return "";
    if (typeof __zp_raw === "string") return __zp_raw;
    if (typeof __zp_raw === "object") {
        if (__zp_raw.data !== undefined && __zp_raw.data !== __zp_raw) {
            return __zp_zmlDecode(__zp_raw.data);
        }
        try {
            const __zp_isBuffer = (typeof ArrayBuffer !== "undefined")
                && (__zp_raw instanceof ArrayBuffer
                    || (typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(__zp_raw)));
            if (__zp_isBuffer && typeof TextDecoder !== "undefined") {
                const __zp_view = (__zp_raw instanceof ArrayBuffer)
                    ? new Uint8Array(__zp_raw)
                    : new Uint8Array(__zp_raw.buffer, __zp_raw.byteOffset, __zp_raw.byteLength);
                return new TextDecoder().decode(__zp_view);
            }
        } catch (e) {}
        try {
            if (typeof __zp_raw.toString === "function") {
                const __zp_value = __zp_raw.toString("utf-8");
                if (typeof __zp_value === "string") return __zp_value;
            }
        } catch (e) {}
    }
    try { return String(__zp_raw); } catch (e) { return ""; }
}

function __zp_zmlListen(__zp_cb) {
    const __zp_fn = function (__zp_raw) {
        const __zp_text = __zp_zmlDecode(__zp_raw);
        if (!__zp_text) return;
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
                        method: __zp_msg.method || (__zp_msg.payload && __zp_msg.payload.method),
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
            __zp_zmlSend({type: "call", method: __zp_method || (__zp_payload && __zp_payload.method), payload: __zp_payload});
        },
        request: function (__zp_payload, __zp_method) {
            return new Promise(function (__zp_resolve, __zp_reject) {
                const __zp_id = ++__zp_seq;
                __zp_pending[__zp_id] = {resolve: __zp_resolve, reject: __zp_reject};
                __zp_zmlSend({
                    type: "request",
                    id: __zp_id,
                    method: __zp_method || (__zp_payload && __zp_payload.method),
                    payload: __zp_payload,
                });
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
            __zp_zmlSend({type: "call", method: __zp_method || (__zp_payload && __zp_payload.method), payload: __zp_payload});
        },
        request: function (__zp_payload, __zp_callback, __zp_method) {
            const __zp_promise = new Promise(function (__zp_resolve, __zp_reject) {
                const __zp_id = ++__zp_seq;
                __zp_pending[__zp_id] = {resolve: __zp_resolve, reject: __zp_reject};
                __zp_zmlSend({
                    type: "request",
                    id: __zp_id,
                    method: __zp_method || (__zp_payload && __zp_payload.method),
                    payload: __zp_payload,
                });
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

    /* The project root is used by @zos/storage to namespace its keys. */
    const projectMatch = entryPath.match(/^\/projects\/([^/]+)/);
    const projectUrl = projectMatch ? "/projects/" + projectMatch[1] : "";

    return "const __zp_project_url = " + quote(projectUrl) + ";\n"
        + HEADER.replace("__ZP_SYS_CASES__", buildSystemCases())
        + "\n" + defs
        + "\n\n__zp_require(" + quote(entryPath) + ");\n";
}
