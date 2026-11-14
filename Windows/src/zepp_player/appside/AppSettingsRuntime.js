/*
    ZeppOS phone-side app settings page host.

    The page (`setting/index.js`) is bundled and then executed inside a real
    HTML document hosted by an iframe, exactly like the official client runs it
    in a WebView: AppSettingsPage + the component factories produce a plain DOM
    tree inside that document, and `settingsKey` controls are two-way bound to
    the settingsStorage the app-side companion reads.

    Everything inside the iframe talks to the simulator through postMessage:
      page  -> host: settings / asset / log / external
      host  -> page: settingsChanged / asset
*/

import { ZBuffer } from "./ZBuffer.js";

const TOKEN_SOURCE = "__ZP_PAGE_SOURCE__";
const TOKEN_VALUES = "__ZP_PAGE_VALUES__";
const TOKEN_I18N = "__ZP_PAGE_I18N__";
const TOKEN_LANGUAGE = "__ZP_PAGE_LANGUAGE__";
const TOKEN_APP_ID = "__ZP_PAGE_APP_ID__";

/* Strings are embedded into a <script> element, so `<` must never appear
 * literally or the parser would close the tag. */
function scriptJson(value) {
    return JSON.stringify(value).replace(/</g, "\\u003c");
}

function pageRuntime() {
    return String.raw`'use strict';
try {
function __zpDecode(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}
var __source = __zpDecode('${TOKEN_SOURCE}');
var __messages = ${TOKEN_I18N};
var __language = ${TOKEN_LANGUAGE};
var __values = new Map(Object.entries(${TOKEN_VALUES}));
var __appId = ${TOKEN_APP_ID};

function post(message) {
    try { parent.postMessage(message, '*'); } catch (e) {}
}
function fmt(args) {
    return args.map(function (v) {
        try {
            if (typeof v === 'string') return v;
            if (v instanceof Error) return v.stack || v.message || String(v);
            var json = JSON.stringify(v);
            return json === '{}' && v && v.message ? String(v.message) : (json === undefined ? String(v) : json);
        } catch (e) { return String(v); }
    }).join(' ');
}
globalThis.console = {};
['log', 'error', 'warn', 'info', 'debug'].forEach(function (level) {
    globalThis.console[level] = function () {
        post({type: 'log', level: level, message: fmt(Array.prototype.slice.call(arguments))});
    };
});

globalThis.userSettings = {lang: __language, language: __language};
class ZeppLang {
    constructor(lang) { this.lang = lang || __language; }
    getLang() { return this.lang; }
    setLang(lang) { this.lang = lang; }
}
function zeppFormat(text) {
    var args = Array.prototype.slice.call(arguments, 1);
    var index = 0;
    return String(text).replace(/%([%sdif])/g, function (all, type) {
        if (type === '%') return '%';
        var value = args[index++];
        if (type === 'd' || type === 'i') return String(parseInt(value, 10));
        if (type === 'f') return String(Number(value));
        return String(value === undefined || value === null ? '' : value);
    });
}
function gettext(id) {
    var text = Object.prototype.hasOwnProperty.call(__messages, id) ? __messages[id] : id;
    var args = [text].concat(Array.prototype.slice.call(arguments, 1));
    return zeppFormat.apply(null, args);
}
globalThis.gettext = gettext;
globalThis.__zp_i18n = __messages;
globalThis.HmUtils = {
    Lang: ZeppLang,
    gettextFactory: function () { return gettext; },
    getLanguage: function () { return __language; },
    getSideLanguage: function () { return __language; },
    getDeviceLanguage: function () { return __language; },
    format: zeppFormat,
    formatStrict: zeppFormat,
    printf: function (message) { console.log(zeppFormat.apply(null, arguments)); },
    sprintf: zeppFormat
};

var listeners = [];
function notify(change) {
    listeners.slice().forEach(function (fn) {
        try { fn(change); } catch (e) { showError(e); }
    });
}
var settingsStorage = {
    get length() { return __values.size; },
    getItem: function (key) {
        key = String(key);
        return __values.has(key) ? __values.get(key) : null;
    },
    setItem: function (key, value) {
        key = String(key);
        value = String(value);
        var oldValue = __values.get(key);
        __values.set(key, value);
        post({type: 'settings', operation: 'set', key: key, value: value});
        notify({key: key, oldValue: oldValue, newValue: value});
    },
    removeItem: function (key) {
        key = String(key);
        if (!__values.has(key)) return;
        var oldValue = __values.get(key);
        __values.delete(key);
        post({type: 'settings', operation: 'remove', key: key});
        notify({key: key, oldValue: oldValue, newValue: undefined});
    },
    clear: function () {
        var old = Array.from(__values);
        __values.clear();
        post({type: 'settings', operation: 'clear'});
        old.forEach(function (entry) {
            notify({key: entry[0], oldValue: entry[1], newValue: undefined});
        });
    },
    key: function (index) {
        var keys = Array.from(__values.keys());
        return keys[index] === undefined ? null : keys[index];
    },
    toObject: function () { return Object.fromEntries(__values); },
    addListener: function (event, callback) {
        if (event !== 'change' || typeof callback !== 'function') return;
        if (listeners.indexOf(callback) < 0) listeners.push(callback);
    },
    removeListener: function (event, callback) {
        if (event !== 'change') return;
        var index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
    }
};
globalThis.settingsStorage = settingsStorage;
globalThis.settings = {settingsStorage: settingsStorage};
globalThis.getApp = function () {
    return {port2: 1004, appId: __appId};
};

var pageOption = null;
function AppSettingsPage(option) {
    pageOption = option;
    rebuild();
}
globalThis.AppSettingsPage = AppSettingsPage;
function node(type, props, children) {
    props = props || {};
    if (children === undefined) children = props.children;
    if (children === undefined || children === null) children = [];
    return {type: type, props: props, children: Array.isArray(children) ? children : [children]};
}
['Auth', 'Button', 'Image', 'Link', 'Section', 'Select', 'Slider', 'Text', 'TextImageRow', 'TextInput', 'Toast', 'Toggle', 'View']
    .forEach(function (name) {
        globalThis[name] = function (props, children) { return node(name, props, children); };
    });

var __assetCache = {};
var __assetSeq = 0;
var __assetWaiters = {};
function loadAsset(src) {
    if (!src) return Promise.resolve('');
    var path = String(src).replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (/^(https?:|data:|blob:)/i.test(path)) return Promise.resolve(path);
    if (Object.prototype.hasOwnProperty.call(__assetCache, path)) return Promise.resolve(__assetCache[path]);
    return new Promise(function (resolve) {
        var id = ++__assetSeq;
        __assetWaiters[id] = resolve;
        post({type: 'asset', id: id, path: path});
    });
}

var unitlessStyle = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'zoom']);
function normalizedStyle(input) {
    var style = Object.assign({}, input);
    Object.keys(style).forEach(function (key) {
        if (typeof style[key] === 'number' && style[key] !== 0 && !unitlessStyle.has(key)) style[key] = style[key] + 'px';
    });
    return style;
}
function apply(el, props) {
    if (!props.style || typeof props.style !== 'object') return;
    var style = normalizedStyle(props.style);
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'scroll')
        && (style.height === '100vh' || style.maxHeight === '100vh' || style.minHeight === '100vh')) {
        delete style.height;
        delete style.maxHeight;
        style.overflow = 'visible';
        style.overflowY = 'visible';
    }
    if (style.flexDirection === 'row') el.classList.add('responsive-row');
    Object.assign(el.style, style);
}
function textValue(children) {
    return (children || []).flat(Infinity)
        .filter(function (v) { return v !== null && v !== undefined && typeof v !== 'object'; })
        .map(String).join('');
}
function bound(props, fallback) {
    if (props.settingsKey && __values.has(String(props.settingsKey))) return __values.get(String(props.settingsKey));
    return props.value === undefined ? fallback : props.value;
}
function change(props, value, rebuildAfter) {
    if (props.settingsKey) settingsStorage.setItem(String(props.settingsKey), Array.isArray(value) ? JSON.stringify(value) : String(value));
    if (typeof props.onChange === 'function') props.onChange(value);
    if (rebuildAfter !== false) queueMicrotask(rebuild);
}
function invoke(handler) {
    try { return handler ? handler() : undefined; } finally { queueMicrotask(rebuild); }
}
function labeled(props, control) {
    if (!props.label && !props.title) return control;
    var row = document.createElement('label');
    row.className = 'row';
    var main = document.createElement('span');
    main.className = 'row-main';
    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = props.label === undefined ? props.title : props.label;
    if (props.labelStyle && typeof props.labelStyle === 'object') Object.assign(label.style, normalizedStyle(props.labelStyle));
    main.append(label);
    if (props.sublabel) {
        var sub = document.createElement('span');
        sub.className = 'sublabel';
        sub.textContent = props.sublabel;
        main.append(sub);
    }
    row.append(main, control);
    return row;
}

function render(item) {
    if (item === null || item === undefined || item === false) return document.createTextNode('');
    if (typeof item === 'string' || typeof item === 'number') return document.createTextNode(String(item));
    if (Array.isArray(item)) {
        var fragment = document.createDocumentFragment();
        item.forEach(function (child) { fragment.append(render(child)); });
        return fragment;
    }
    var props = item.props || {};
    var children = item.children || [];
    var el;
    switch (item.type) {
        case 'Text':
            el = document.createElement('span');
            el.textContent = props.text !== undefined ? props.text : (props.label !== undefined ? props.label : textValue(children));
            break;
        case 'Button':
            el = document.createElement('button');
            el.type = 'button';
            el.textContent = props.label !== undefined ? props.label : (props.text !== undefined ? props.text : textValue(children));
            el.onclick = function () { invoke(props.onClick); };
            break;
        case 'View':
            el = document.createElement('div');
            if (props.onClick) el.onclick = function () { invoke(props.onClick); };
            el.append(render(children));
            if (children.some && children.some(function (c) { return c && c.type === 'Select'; })
                && children.some && children.some(function (c) { return c && c.type === 'Text'; })) {
                el.classList.add('custom-select');
            }
            break;
        case 'Section':
            el = document.createElement('section');
            el.className = 'section';
            if (props.title) {
                var heading = document.createElement('h2');
                heading.textContent = props.title;
                el.append(heading);
            }
            if (props.description) {
                var description = document.createElement('p');
                description.textContent = props.description;
                el.append(description);
            }
            el.append(render(children));
            break;
        case 'Image':
            el = document.createElement('img');
            el.alt = props.alt || '';
            if (props.width) el.width = Number(props.width);
            if (props.height) el.height = Number(props.height);
            loadAsset(props.src === undefined ? props.source : props.src).then(function (url) {
                if (url) el.src = url;
            });
            break;
        case 'Link':
            el = document.createElement('a');
            el.href = props.source || props.url || '#';
            el.textContent = props.label !== undefined ? props.label : (textValue(children) || el.href);
            el.onclick = function (event) {
                event.preventDefault();
                post({type: 'external', url: props.source || props.url || ''});
            };
            break;
        case 'Toggle': {
            var checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = String(bound(props, false)) === 'true';
            checkbox.onchange = function () { change(props, checkbox.checked); };
            if (props.subStyle) Object.assign(checkbox.style, normalizedStyle(props.subStyle));
            el = labeled(props, checkbox);
            if (children.length) el.prepend(render(children));
            break;
        }
        case 'TextInput': {
            var input = document.createElement(props.multiline ? 'textarea' : 'input');
            input.value = String(bound(props, ''));
            input.placeholder = props.placeholder === undefined ? '' : props.placeholder;
            input.disabled = !!props.disabled;
            if (props.rows) input.rows = Number(props.rows);
            if (props.subStyle) Object.assign(input.style, normalizedStyle(props.subStyle));
            input.onchange = function () { change(props, input.value, false); };
            el = labeled(props, input);
            break;
        }
        case 'Slider': {
            var range = document.createElement('input');
            range.type = 'range';
            range.min = props.min === undefined ? 0 : props.min;
            range.max = props.max === undefined ? 100 : props.max;
            range.step = props.step === undefined ? 1 : props.step;
            range.value = Number(bound(props, props.min === undefined ? 0 : props.min));
            if (props.subStyle) Object.assign(range.style, normalizedStyle(props.subStyle));
            range.oninput = function () { change(props, Number(range.value)); };
            el = labeled(props, range);
            break;
        }
        case 'Select': {
            var select = document.createElement('select');
            select.multiple = !!props.multiple;
            (props.options || []).forEach(function (option) {
                var entry = document.createElement('option');
                entry.value = String(option.value);
                entry.textContent = option.name === undefined
                    ? (option.label === undefined ? option.value : option.label) : option.name;
                select.append(entry);
            });
            var value = bound(props, props.multiple ? [] : '');
            if (select.multiple) {
                if (typeof value === 'string') {
                    try { value = JSON.parse(value); } catch (e) { value = value.split(','); }
                }
                var selected = Array.isArray(value) ? value.map(String) : [];
                Array.from(select.options).forEach(function (option) { option.selected = selected.indexOf(option.value) >= 0; });
            } else {
                select.value = String(value === null || value === undefined ? '' : value);
            }
            if (props.subStyle) Object.assign(select.style, normalizedStyle(props.subStyle));
            select.onchange = function () {
                change(props, select.multiple ? Array.from(select.selectedOptions).map(function (o) { return o.value; }) : select.value);
            };
            el = labeled(props, select);
            break;
        }
        case 'TextImageRow': {
            el = document.createElement('div');
            el.className = 'row';
            var image = document.createElement('img');
            image.width = 40;
            image.height = 40;
            if (props.rounded) image.style.borderRadius = '50%';
            loadAsset(props.icon).then(function (url) { if (url) image.src = url; });
            var main = document.createElement('span');
            main.className = 'row-main';
            var text = document.createElement('span');
            text.textContent = props.label || '';
            main.append(text);
            if (props.sublabel) {
                var sub = document.createElement('span');
                sub.className = 'sublabel';
                sub.textContent = props.sublabel;
                main.append(sub);
            }
            if (props.iconRight) el.append(main, image);
            else el.append(image, main);
            break;
        }
        case 'Toast': {
            el = document.createElement('div');
            el.className = 'toast ' + (props.vertical === 'bottom' ? 'bottom' : 'top');
            el.textContent = props.message !== undefined ? props.message
                : (props.content !== undefined ? props.content : (props.text !== undefined ? props.text : textValue(children)));
            if (props.visible === false) el.hidden = true;
            else {
                setTimeout(function () {
                    el.remove();
                    if (typeof props.onClose === 'function') props.onClose();
                }, props.duration === undefined ? 2000 : props.duration);
            }
            break;
        }
        case 'Auth':
            el = document.createElement('div');
            el.className = 'error';
            el.textContent = 'OAuth (Auth) is not available inside ZeppPlayer.';
            break;
        default:
            el = document.createElement('div');
            el.append(render(children));
    }
    apply(el, props);
    return el;
}

function showError(error) {
    var root = document.getElementById('root');
    root.replaceChildren();
    var box = document.createElement('pre');
    box.className = 'error';
    box.textContent = String(error && (error.stack || error.message) || error);
    root.append(box);
    post({type: 'log', level: 'error', message: box.textContent});
}
function rebuild() {
    if (!pageOption) return;
    try {
        var tree = pageOption.build.call(pageOption, {
            settingsStorage: settingsStorage,
            settings: settingsStorage,
            gettext: gettext,
            appId: __appId
        });
        document.getElementById('root').replaceChildren(render(tree));
    } catch (e) {
        showError(e);
    }
}

window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'settingsChanged') {
        var next = message.values || {};
        var old = new Map(__values);
        __values.clear();
        Object.keys(next).forEach(function (key) { __values.set(key, String(next[key])); });
        var keys = new Set(Array.from(old.keys()).concat(Array.from(__values.keys())));
        keys.forEach(function (key) {
            if (old.get(key) !== __values.get(key)) notify({key: key, oldValue: old.get(key), newValue: __values.get(key)});
        });
        rebuild();
    } else if (message.type === 'asset') {
        __assetCache[message.path] = message.url || '';
        var waiter = __assetWaiters[message.id];
        if (waiter) {
            delete __assetWaiters[message.id];
            waiter(message.url || '');
        }
    }
});
window.onerror = function (message, source, line, column, error) {
    showError(error || new Error(String(message)));
    return true;
};
window.onunhandledrejection = function (event) { showError(event.reason); };

/* The page is laid out for a 250px-wide phone screen. When the simulator
 * gives the phone a bigger screen (maximized window), zoom the whole document
 * so the page grows proportionally like a scaled phone instead of stretching
 * its layout to the wider viewport. */
var __zpDesignWidth = 250;
function __zpFit() {
    var width = document.documentElement.clientWidth || window.innerWidth || __zpDesignWidth;
    var scale = Math.max(1, width / __zpDesignWidth);
    document.body.style.zoom = String(scale);
}
__zpFit();
window.addEventListener('resize', __zpFit);

try {
    var script = document.createElement('script');
    script.textContent = __source;
    document.head.append(script);
} catch (e) {
    showError(e);
}
queueMicrotask(function () {
    if (!pageOption) showError(new Error('setting/index.js did not register AppSettingsPage'));
});
} catch (e) {
    document.getElementById('root').textContent = 'Settings page runtime error: ' + (e && (e.stack || e.message) || e);
}
`;
}

const PAGE_STYLE = `
:root{color-scheme:dark;font:16px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:Canvas;color:CanvasText}
*,*::before,*::after{box-sizing:border-box}
.root{width:100%;height:100%;overflow:auto;overscroll-behavior:contain;padding:4px}
.root>div{width:100%;margin-inline:auto}
.section{padding:16px;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:16px}
.section+.section{margin-top:12px}
.section h2{font-size:18px;margin:0 0 4px}
.section p{opacity:.7;margin:0 0 12px}
.row{display:flex;align-items:center;gap:12px;min-height:44px}
.row-main{display:flex;flex:1 1 auto;flex-direction:column;min-width:48px}
.label{font-weight:600;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row input:not([type=checkbox]):not([type=range]),.row select,.row textarea{flex:0 1 130px;width:130px;min-width:0}
.row input[type=range]{flex:1 1 90px;min-width:60px;max-width:130px}
.sublabel{opacity:.7;font-size:.9em}
button,input,select,textarea{font:inherit;padding:10px 12px;border-radius:12px;border:1px solid color-mix(in srgb,CanvasText 30%,transparent);max-width:100%;background:transparent;color:inherit}
button{cursor:pointer;padding-inline:20px}
img{max-width:100%}
.custom-select{position:relative}
.custom-select>select{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;opacity:0;cursor:pointer;z-index:2}
.custom-select>span{position:relative;z-index:1;pointer-events:none}
.responsive-row{min-width:0}
.responsive-row>*{min-width:0}
.error{white-space:pre-wrap;background:#b3261e;color:white;padding:16px;border-radius:12px;font-size:13px}
.toast{position:fixed;left:50%;transform:translateX(-50%);padding:12px 20px;border-radius:999px;background:#323232;color:white;z-index:10}
.toast.top{top:24px}
.toast.bottom{bottom:24px}
`;

/**
 * Builds the standalone settings page document for the phone screen.
 *
 * @param {object} options
 *   source:   bundled `setting/index.js` body (see EsmBundler)
 *   values:   initial settingsStorage contents ({[key]: string})
 *   messages: flat translation table for the current language
 *   language: current language code
 *   appId:    numeric app id
 */
export function buildSettingsHtml(options) {
    const source = String(options.source || "");
    const encoded = new ZBuffer(new TextEncoder().encode(source)).toString("base64");
    const html = `<!doctype html><html><head><meta charset="utf-8">`
        + `<meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<style>${PAGE_STYLE}</style></head><body><main id="root" class="root"></main>`
        + `<script>${pageRuntime()}</script></body></html>`;
    return html
        .split("'" + TOKEN_SOURCE + "'").join("'" + encoded + "'")
        .split(TOKEN_I18N).join(scriptJson(options.messages || {}))
        .split(TOKEN_LANGUAGE).join(scriptJson(options.language || "en-US"))
        .split(TOKEN_VALUES).join(scriptJson(options.values || {}))
        .split(TOKEN_APP_ID).join(String(Number(options.appId) || 0));
}

export function bufferToDataUrl(path, data) {
    if (!data) return "";
    const ext = String(path).split(".").pop().toLowerCase();
    const mime = ext === "png" ? "image/png"
        : (ext === "jpg" || ext === "jpeg") ? "image/jpeg"
            : ext === "gif" ? "image/gif"
                : ext === "webp" ? "image/webp"
                    : ext === "svg" ? "image/svg+xml"
                        : "application/octet-stream";
    return "data:" + mime + ";base64," + new ZBuffer(new Uint8Array(data)).toString("base64");
}
