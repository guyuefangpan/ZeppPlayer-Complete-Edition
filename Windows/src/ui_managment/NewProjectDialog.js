/*
    New project wizard.

    On the desktop shell the wizard drives the official `zeus create` command:
    the same questions the CLI asks in a terminal (type, API level, template,
    app-side/settings, device shape) are asked here, and the answers are passed
    as flags. The CLI output is streamed into the dialog so the progress that
    would normally scroll by in cmd stays visible.

    Phones (and desktops without zeus-cli) keep the old behaviour: an official
    sample is pulled from GitHub and imported through /api/import_zip_upload.
*/

import {zipSync} from "fflate";
import I18n from "../zepp_player/i18n.js";
import {zeusInfo, zeusTemplates, zeusRun, zeusStop, watchZeusJob} from "./ZeusClient.js";
import "./NewProjectDialog.css";

const REPO = "zepp-health/zeppos-samples";
const BRANCH = "main";
const API_TREE = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const CDN_BASE = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/`;
const TREE_CACHE_KEY = "zp_tpl_tree_v1";
const TREE_TTL = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 45000;
const CONCURRENCY = 6;
/* The same official templates are shipped with the app so project creation
 * still works when GitHub is blocked (the usual case in mainland China). */
const BUNDLED_BASE = "/app/templates/";

const TEMPLATES = {
    app: {
        versions: ["1.0", "2.0", "3.0", "4.0"],
        path: (v) => `application/${v}/hello-world`,
        name: (v) => `hello-world-${v}`,
    },
    watchface: {
        versions: ["1.0", "3.0"],
        path: (v) => `watchface/${v}/timer`,
        name: (v) => `timer-${v}`,
    },
};

const SHAPES = ["r", "s", "b"];

let overlay = null;
let busy = false;
let onDoneCb = null;
let escHandler = null;
let watcher = null;
let jobId = "";
/* null while zeus is still being probed, {installed:false} when unavailable. */
let zeus = null;
let templates = [];
let devices = [];

const state = {
    appType: "app",
    apiLevel: "3.0",
    template: "",
    shapes: ["r"],
    devices: [],
    withAppSide: false,
    withSettings: false,
    name: "",
    nameTouched: false,
};

function t(key, fallback) {
    return I18n.t(key, fallback);
}

function isZeus() {
    return !!(zeus && zeus.installed);
}

function levels() {
    if (zeus && zeus.types && Array.isArray(zeus.types[state.appType])) {
        return zeus.types[state.appType];
    }
    if (state.appType === "workout_extension") return ["3.5"];
    return (TEMPLATES[state.appType] && TEMPLATES[state.appType].versions) || ["3.0"];
}

function defaultName() {
    if (state.appType === "watchface") return "zepp-watchface";
    if (state.appType === "workout_extension") return "zepp-workout";
    return "zepp-app";
}

function appTypes() {
    const list = [
        {id: "app", icon: "apps", key: "newProject.app", hint: "newProject.appHint"},
        {id: "watchface", icon: "watch", key: "newProject.watchface", hint: "newProject.watchfaceHint"},
    ];
    if (isZeus()) {
        list.push({
            id: "workout_extension",
            icon: "directions_run",
            key: "newProject.workout",
            hint: "newProject.workoutHint",
        });
    }
    return list;
}

async function loadTemplates() {
    if (!isZeus()) {
        templates = [];
        state.template = "";
        return;
    }
    try {
        const r = await zeusTemplates(state.appType, state.apiLevel);
        templates = (r && r.templates) || [];
    } catch (e) {
        templates = [];
    }
    if (templates.indexOf(state.template) < 0) state.template = templates[0] || "";
}

/* ------------------------------------------------------------------ *
 * GitHub fallback (phones, or a desktop without zeus-cli)
 * ------------------------------------------------------------------ */

async function fetchWithTimeout(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
        return await fetch(url, Object.assign({}, opts || {}, {signal: ctrl.signal}));
    } finally {
        clearTimeout(timer);
    }
}

function readTreeCache() {
    try {
        const raw = localStorage.getItem(TREE_CACHE_KEY);
        if (!raw) return null;
        const cache = JSON.parse(raw);
        if (!cache || !Array.isArray(cache.paths)) return null;
        if (Date.now() - (cache.ts || 0) > TREE_TTL) return null;
        return cache;
    } catch (e) {
        return null;
    }
}

function writeTreeCache(cache) {
    try { localStorage.setItem(TREE_CACHE_KEY, JSON.stringify(cache)); } catch (e) {}
}

/* One listing call per six hours is enough; the raw file downloads are not
 * rate limited the same way. jsDelivr only steps in when the GitHub API is
 * unavailable (offline cache, rate limit, corporate proxy). */
async function loadTree() {
    const cached = readTreeCache();
    if (cached) return cached;

    let paths = null;
    let base = RAW_BASE;

    try {
        const r = await fetchWithTimeout(API_TREE, {
            headers: {"Accept": "application/vnd.github+json"},
        });
        if (r.ok) {
            const j = await r.json();
            if (j && Array.isArray(j.tree)) {
                paths = j.tree.filter((x) => x.type === "blob").map((x) => x.path);
            }
        }
    } catch (e) {
        console.warn("GitHub tree unavailable, trying jsDelivr", e);
    }

    if (!paths) {
        const r = await fetchWithTimeout(
            `https://data.jsdelivr.com/v1/packages/gh/${REPO}@${BRANCH}?structure=flat`
        );
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        if (!j || !Array.isArray(j.files)) throw new Error("template list unavailable");
        paths = j.files.map((f) => String(f.name || "").replace(/^\/+/, ""));
        base = CDN_BASE;
    }

    const cache = {ts: Date.now(), paths, base};
    writeTreeCache(cache);
    return cache;
}

async function downloadTemplate(prefix, onProgress) {
    const tree = await loadTree();
    const files = tree.paths
        .filter((p) => p.indexOf(prefix + "/") === 0)
        .map((p) => p.substring(prefix.length + 1));
    if (!files.length) throw new Error("template not found: " + prefix);

    const out = {};
    const queue = files.slice();
    let done = 0;
    let failed = null;

    const worker = async () => {
        while (queue.length && !failed) {
            const name = queue.shift();
            try {
                const url = tree.base + name.split("/").map(encodeURIComponent).join("/");
                const r = await fetchWithTimeout(url);
                if (!r.ok) throw new Error("HTTP " + r.status + " " + name);
                out[name] = new Uint8Array(await r.arrayBuffer());
                done++;
                if (onProgress) onProgress(done, files.length);
            } catch (e) {
                failed = e;
            }
        }
    };

    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, files.length); i++) workers.push(worker());
    await Promise.all(workers);
    if (failed) throw failed;
    return out;
}

async function downloadBundled(type, version) {
    const r = await fetchWithTimeout(`${BUNDLED_BASE}${type}-${version}.zip`);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return new Uint8Array(await r.arrayBuffer());
}

async function createFromTemplate(type, version, onProgress) {
    const tpl = TEMPLATES[type];
    if (!tpl || tpl.versions.indexOf(version) < 0) throw new Error("unknown template");

    if (onProgress) onProgress("list");
    let zip;
    try {
        const files = await downloadTemplate(tpl.path(version), (done, total) => {
            if (onProgress) onProgress("download", done, total);
        });
        zip = zipSync(files, {level: 6});
    } catch (e) {
        /* GitHub stays the first choice because it can carry upstream fixes;
         * the bundled copy is only a safety net. */
        console.warn("GitHub template unavailable, using the bundled copy", e);
        if (onProgress) onProgress("bundled");
        zip = await downloadBundled(type, version);
    }

    if (onProgress) onProgress("import");
    const r = await fetchWithTimeout("/api/import_zip_upload", {
        method: "POST",
        headers: {
            "Content-Type": "application/zip",
            "X-File-Name": encodeURIComponent(tpl.name(version) + ".zip"),
        },
        body: new Blob([zip], {type: "application/zip"}),
    });
    const j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.msg) || "import failed");
    return j;
}

/* ------------------------------------------------------------------ *
 * Dialog chrome
 * ------------------------------------------------------------------ */

function setStatus(text, isError) {
    if (!overlay) return;
    const el = overlay.querySelector(".zp-np__status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("error", !!isError);
}

function appendLog(lines) {
    if (!overlay || !lines || !lines.length) return;
    const log = overlay.querySelector(".zp-np__log");
    if (!log) return;
    log.hidden = false;
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    for (const line of lines) {
        const div = document.createElement("div");
        div.textContent = line;
        log.appendChild(div);
    }
    while (log.childElementCount > 600) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;
}

function clearLog() {
    if (!overlay) return;
    const log = overlay.querySelector(".zp-np__log");
    if (!log) return;
    log.innerHTML = "";
    log.hidden = true;
}

function setBusy(value) {
    busy = value;
    if (!overlay) return;
    overlay.classList.toggle("zp-np--busy", value);
    const create = overlay.querySelector('[data-act="create"]');
    const cancel = overlay.querySelector('[data-act="cancel"]');
    const close = overlay.querySelector('[data-act="close"]');
    if (create) {
        create.disabled = value;
        create.textContent = value
            ? t("newProject.creating", "创建中...")
            : t("newProject.create", "创建并打开");
    }
    if (cancel) {
        cancel.disabled = false;
        cancel.textContent = value ? t("zeus.stop", "停止") : t("newProject.cancel", "取消");
        cancel.onclick = value ? stopCreate : () => closeNewProjectDialog();
    }
    if (close) close.disabled = value;
}

async function stopCreate() {
    if (!jobId) return;
    try {
        await zeusStop(jobId);
        setStatus(t("zeus.stopping", "正在停止…"));
    } catch (e) {
        setStatus(String(e && e.message || e), true);
    }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function chipRow(container, values, isActive, onPick) {
    const row = document.createElement("div");
    row.className = "zp-np__versions";
    for (const value of values) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "zp-np__ver" + (isActive(value) ? " active" : "");
        btn.textContent = value;
        btn.onclick = () => {
            if (busy) return;
            onPick(value);
        };
        row.appendChild(btn);
    }
    container.appendChild(row);
}

function label(text) {
    const el = document.createElement("div");
    el.className = "zp-np__label";
    el.textContent = text;
    return el;
}

function toggleRow(container, items) {
    const row = document.createElement("div");
    row.className = "zp-np__versions";
    for (const item of items) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "zp-np__ver" + (item.active() ? " active" : "");
        btn.textContent = item.label;
        btn.onclick = () => {
            if (busy) return;
            item.toggle();
            renderBody();
        };
        row.appendChild(btn);
    }
    container.appendChild(row);
}

function renderBody() {
    if (!overlay) return;
    const box = overlay.querySelector(".zp-np__dyn");
    if (!box) return;
    box.innerHTML = "";

    if (isZeus()) {
        box.appendChild(label(t("newProject.name", "项目名称")));
        const input = document.createElement("input");
        input.className = "zp-np__input";
        input.type = "text";
        input.spellcheck = false;
        input.value = state.name;
        input.placeholder = defaultName();
        input.oninput = () => {
            state.name = input.value;
            state.nameTouched = true;
        };
        box.appendChild(input);
    }

    box.appendChild(label(t("newProject.type", "项目类型")));
    const types = document.createElement("div");
    types.className = "zp-np__types";
    for (const item of appTypes()) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "zp-np__type" + (item.id === state.appType ? " active" : "");
        btn.innerHTML = `<span class="material-symbols-outlined"></span>
            <span class="zp-np__typeText"><b></b><small></small></span>`;
        btn.querySelector(".material-symbols-outlined").textContent = item.icon;
        btn.querySelector("b").textContent = t(item.key, item.id);
        btn.querySelector("small").textContent = t(item.hint, "");
        btn.onclick = () => {
            if (busy || item.id === state.appType) return;
            pickType(item.id);
        };
        types.appendChild(btn);
    }
    box.appendChild(types);

    box.appendChild(label(t("newProject.version", "系统版本")));
    chipRow(box, levels(), (v) => v === state.apiLevel, (v) => pickLevel(v));

    if (isZeus()) {
        box.appendChild(label(t("newProject.template", "模板")));
        if (templates.length) {
            chipRow(box, templates, (v) => v === state.template, (v) => {
                state.template = v;
                renderBody();
            });
        } else {
            const empty = document.createElement("div");
            empty.className = "zp-np__source";
            empty.textContent = t("newProject.noTemplates", "当前版本没有可用模板");
            box.appendChild(empty);
        }

        if (state.appType === "app" && state.template === "Empty") {
            box.appendChild(label(t("newProject.extras", "附加组件")));
            toggleRow(box, [
                {
                    label: t("newProject.appSide", "包含 app-side 组件"),
                    active: () => state.withAppSide,
                    toggle: () => {
                        state.withAppSide = !state.withAppSide;
                        if (!state.withAppSide) state.withSettings = false;
                    },
                },
                {
                    label: t("newProject.settings", "包含设置页"),
                    active: () => state.withSettings,
                    toggle: () => {
                        if (!state.withAppSide) return;
                        state.withSettings = !state.withSettings;
                    },
                },
            ]);

            /* Same split as the official prompts: API 1.0/2.0 asks which
             * devices to build for, 3.0 and above asks for screen shapes. */
            if (parseFloat(state.apiLevel) > 2) {
                box.appendChild(label(t("newProject.shapes", "设备形状")));
                toggleRow(box, SHAPES.map((shape) => ({
                    label: t("newProject.shape." + shape, shape),
                    active: () => state.shapes.indexOf(shape) > -1,
                    toggle: () => {
                        const at = state.shapes.indexOf(shape);
                        if (at > -1) {
                            if (state.shapes.length > 1) state.shapes.splice(at, 1);
                        } else {
                            state.shapes.push(shape);
                        }
                    },
                })));
            } else {
                renderDevices(box);
            }
        }
    }

    const source = document.createElement("div");
    source.className = "zp-np__source";
    source.textContent = isZeus()
        ? t("newProject.zeusSource", "由官方命令行 zeus create 创建")
            + (zeus && zeus.version ? " · zeus-cli " + zeus.version : "")
        : t("newProject.source", "模板来源：GitHub · zepp-health/zeppos-samples");
    box.appendChild(source);
}

/* Device picker for API 1.0/2.0 projects: the official CLI lists every cached
 * device and builds one target per selected one. */
function devicesForLevel() {
    /* An API 2.0 project only lists the devices that still support OS 2.0,
     * exactly like the CLI does; fall back instead of showing nothing. */
    if (parseFloat(state.apiLevel) < 2) return devices;
    const v2 = devices.filter((d) => d.osV2);
    return v2.length ? v2 : devices;
}

function renderDevices(box) {
    box.appendChild(label(t("newProject.devices", "适配设备")));

    const available = devicesForLevel();
    if (!available.length) {
        const empty = document.createElement("div");
        empty.className = "zp-np__source";
        empty.textContent = t("newProject.noDevices", "没有设备缓存，请先在 zeus 菜单里更新设备缓存");
        box.appendChild(empty);
        return;
    }

    const keys = available.map((d) => d.key);
    state.devices = state.devices.filter((k) => keys.indexOf(k) > -1);
    if (!state.devices.length) state.devices = [keys[0]];

    const list = document.createElement("div");
    list.className = "zp-np__devices";
    for (const dev of available) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "zp-np__device" + (state.devices.indexOf(dev.key) > -1 ? " active" : "");
        row.innerHTML = `<span class="material-symbols-outlined">watch</span>
            <span class="zp-np__deviceName"></span>
            <span class="zp-np__deviceMeta"></span>`;
        row.querySelector(".zp-np__deviceName").textContent = dev.name;
        const meta = [];
        if (dev.width && dev.height) meta.push(dev.width + "×" + dev.height);
        meta.push(t("newProject.shape." + dev.shape, dev.shape));
        row.querySelector(".zp-np__deviceMeta").textContent = meta.join(" · ");
        row.onclick = () => {
            const at = state.devices.indexOf(dev.key);
            if (at > -1) {
                if (state.devices.length > 1) {
                    state.devices.splice(at, 1);
                    row.classList.remove("active");
                }
            } else {
                state.devices.push(dev.key);
                row.classList.add("active");
            }
        };
        list.appendChild(row);
    }
    box.appendChild(list);
}

function defaultDevice() {
    state.devices = [];
}

async function pickType(id) {
    state.appType = id;
    const list = levels();
    if (list.indexOf(state.apiLevel) < 0) state.apiLevel = list[list.length - 1] || "3.0";
    state.template = "";
    state.withAppSide = false;
    state.withSettings = false;
    if (!state.nameTouched) state.name = defaultName();
    renderBody();
    setStatus("");
    await loadTemplates();
    renderBody();
}

async function pickLevel(version) {
    state.apiLevel = version;
    state.template = "";
    renderBody();
    setStatus("");
    await loadTemplates();
    renderBody();
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

async function handleCreate() {
    if (busy) return;

    if (!isZeus()) {
        await createGithub();
        return;
    }

    const name = String(state.name || "").trim();
    if (!name) {
        setStatus(t("newProject.nameRequired", "请填写项目名称"), true);
        return;
    }

    setBusy(true);
    clearLog();
    setStatus(t("newProject.creating", "创建中..."));

    let res;
    try {
        res = await zeusRun({
            action: "create",
            name,
            appType: state.appType,
            apiLevel: state.apiLevel,
            template: state.template,
            shapes: state.shapes,
            devices: state.devices,
            withAppSide: state.withAppSide,
            withSettings: state.withSettings,
        });
    } catch (e) {
        setStatus(String(e && e.message || e), true);
        setBusy(false);
        return;
    }

    if (!res || !res.ok) {
        setStatus((res && res.msg) || t("newProject.failed", "创建项目失败"), true);
        setBusy(false);
        return;
    }

    jobId = res.jobId;
    watcher = watchZeusJob(res.jobId, {
        onLines: appendLog,
        onDone: async (job) => {
            watcher = null;
            jobId = "";
            if (job.code !== 0) {
                setStatus(t("newProject.failed", "创建项目失败")
                    + " (" + t("zeus.exitCode", "退出码 {code}").replace("{code}", String(job.code)) + ")", true);
                setBusy(false);
                return;
            }
            /* closeNewProjectDialog() clears onDoneCb, so keep a local
             * reference: the new project still has to be opened. */
            const done = onDoneCb;
            closeNewProjectDialog(true);
            if (done) await done({ok: true, name: res.name});
        },
        onError: (e) => {
            watcher = null;
            jobId = "";
            setStatus(String(e && e.message || e), true);
            setBusy(false);
        },
    });
}

async function createGithub() {
    setBusy(true);
    setStatus(t("newProject.list", "正在获取模板列表..."));

    try {
        const result = await createFromTemplate(state.appType, state.apiLevel, (phase, done, total) => {
            if (phase === "list") {
                setStatus(t("newProject.list", "正在获取模板列表..."));
            } else if (phase === "download") {
                setStatus(t("newProject.download", "正在下载模板 {done}/{total}...")
                    .replace("{done}", String(done))
                    .replace("{total}", String(total)));
            } else if (phase === "bundled") {
                setStatus(t("newProject.bundled", "GitHub 不可达，改用内置模板..."));
            } else if (phase === "import") {
                setStatus(t("newProject.import", "正在创建项目..."));
            }
        });

        const done = onDoneCb;
        closeNewProjectDialog(true);
        if (done) await done(result);
    } catch (e) {
        console.error("Template project failed", e);
        setStatus(t("newProject.failed", "创建项目失败") + ": " + (e && (e.message || e)), true);
        setBusy(false);
    }
}

/* ------------------------------------------------------------------ *
 * Open / close
 * ------------------------------------------------------------------ */

export function closeNewProjectDialog(force) {
    if (!overlay) return false;
    if (busy && !force) return true;
    if (watcher) {
        watcher.stop();
        watcher = null;
    }
    if (escHandler) {
        document.removeEventListener("keydown", escHandler);
        escHandler = null;
    }
    overlay.remove();
    overlay = null;
    busy = false;
    jobId = "";
    onDoneCb = null;
    return true;
}

export function openNewProjectDialog(onDone) {
    if (overlay) return;
    onDoneCb = onDone || null;
    zeus = null;
    templates = [];
    devices = [];
    jobId = "";
    state.appType = "app";
    state.apiLevel = "3.0";
    state.template = "";
    state.shapes = ["r"];
    state.devices = [];
    state.withAppSide = false;
    state.withSettings = false;
    state.name = "";
    state.nameTouched = false;
    busy = false;

    const root = document.createElement("div");
    root.id = "zp-new-project-overlay";
    root.className = "zp-np";
    root.innerHTML = `
        <div class="zp-np__dialog" role="dialog" aria-modal="true" aria-labelledby="zp-np-title">
            <div class="zp-np__head">
                <span class="material-symbols-outlined zp-np__headIcon">note_add</span>
                <h2 class="zp-np__title" id="zp-np-title" data-i18n="newProject.title"></h2>
                <button type="button" class="zp-np__close material-symbols-outlined" data-act="close">close</button>
            </div>
            <div class="zp-np__body">
                <div class="zp-np__dyn"></div>
                <pre class="zp-np__log" hidden></pre>
                <div class="zp-np__status" role="status"></div>
            </div>
            <div class="zp-np__foot">
                <button type="button" class="zp-np__btn" data-act="cancel" data-i18n="newProject.cancel"></button>
                <button type="button" class="zp-np__btn primary" data-act="create" data-i18n="newProject.create"></button>
            </div>
        </div>`;

    I18n.apply(root);
    root.querySelector('[data-act="close"]').title = t("newProject.close", "Close");

    root.querySelector('[data-act="close"]').onclick = () => closeNewProjectDialog();
    root.querySelector('[data-act="cancel"]').onclick = () => closeNewProjectDialog();
    root.querySelector('[data-act="create"]').onclick = handleCreate;

    root.addEventListener("mousedown", (e) => {
        if (e.target === root) closeNewProjectDialog();
    });

    escHandler = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            closeNewProjectDialog();
        }
    };
    document.addEventListener("keydown", escHandler);

    document.body.appendChild(root);
    overlay = root;
    renderBody();
    setStatus(t("newProject.detect", "正在检测 zeus…"));
    root.querySelector('[data-act="create"]').focus();

    zeusInfo().then((info) => {
        zeus = info && info.installed ? info : {installed: false};
        devices = info && Array.isArray(info.devices) ? info.devices : [];
        defaultDevice();
        const list = levels();
        if (list.indexOf(state.apiLevel) < 0) state.apiLevel = list[list.length - 1] || "3.0";
        return loadTemplates();
    }).catch(() => {
        zeus = {installed: false};
    }).then(() => {
        if (!state.nameTouched) state.name = defaultName();
        renderBody();
        setStatus(isZeus()
            ? ""
            : t("newProject.noZeus", "未检测到 zeus-cli，将使用内置模板创建"));
    });
}
