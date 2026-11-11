/*
    Modal that streams the output of a zeus command. `zeus dev` / `bridge`
    never exit on their own, so the dialog doubles as the way to stop them;
    the same window shows the one-shot commands (status, prune, config, cache).
*/

import I18n from "../zepp_player/i18n.js";
import {showToast} from "../zepp_player/zpToast.js";
import {zpAlert} from "../zepp_player/zpDialogs.js";
import {ConsoleManager} from "./ConsoleManager.js";
import {zeusRun, zeusStop, watchZeusJob} from "./ZeusClient.js";
import "./NewProjectDialog.css";

const ACTION_KEYS = {
    preview: "zeus.preview",
    bridge: "zeus.bridge",
    prune: "zeus.prune",
    status: "zeus.status",
    config: "zeus.config",
    "cache-update": "zeus.cacheUpdate",
    "cache-clean": "zeus.cacheClean",
};

let overlay = null;
let watcher = null;
let currentJobId = "";
let escHandler = null;

function t(key, fallback) {
    return I18n.t(key, fallback);
}

function actionTitle(action) {
    const key = ACTION_KEYS[action] || "zeus.title";
    return t(key, action);
}

function appendLines(log, lines) {
    if (!log || !lines || !lines.length) return;
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    for (const line of lines) {
        const div = document.createElement("div");
        div.textContent = line;
        log.appendChild(div);
    }
    while (log.childElementCount > 800) log.removeChild(log.firstChild);
    if (atBottom) log.scrollTop = log.scrollHeight;

    if (ConsoleManager.instance) {
        try { ConsoleManager.instance.write("Zeus", [lines.join("\n")]); } catch (e) {}
    }
}

function setStatus(text, isError) {
    if (!overlay) return;
    const el = overlay.querySelector(".zp-np__status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("error", !!isError);
}

function setRunning(running) {
    if (!overlay) return;
    const stop = overlay.querySelector('[data-act="stop"]');
    if (stop) stop.disabled = !running;
}

export function closeZeusJobDialog() {
    if (!overlay) return;
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
    currentJobId = "";
}

export function openZeusJobDialog(action) {
    if (overlay) return;

    const root = document.createElement("div");
    root.id = "zp-zeus-job-overlay";
    root.className = "zp-np zp-np--job";
    root.innerHTML = `
        <div class="zp-np__dialog" role="dialog" aria-modal="true">
            <div class="zp-np__head">
                <span class="material-symbols-outlined zp-np__headIcon">terminal</span>
                <h2 class="zp-np__title"></h2>
                <button type="button" class="zp-np__close material-symbols-outlined" data-act="close">close</button>
            </div>
            <div class="zp-np__body">
                <div class="zp-np__source">zeus ${action}</div>
                <pre class="zp-zjob__log"></pre>
                <div class="zp-np__status" role="status"></div>
            </div>
            <div class="zp-np__foot">
                <button type="button" class="zp-np__btn" data-act="stop" disabled>${t("zeus.stop", "停止")}</button>
                <button type="button" class="zp-np__btn primary" data-act="close">${t("zeus.close", "关闭")}</button>
            </div>
        </div>`;

    root.querySelector(".zp-np__title").textContent = actionTitle(action);
    root.querySelector('[data-act="close"].zp-np__close').onclick = closeZeusJobDialog;
    root.querySelector('.zp-np__foot [data-act="close"]').onclick = closeZeusJobDialog;
    root.querySelector('[data-act="stop"]').onclick = async () => {
        if (!currentJobId) return;
        try {
            await zeusStop(currentJobId);
            setStatus(t("zeus.stopping", "正在停止…"));
        } catch (e) {
            setStatus(String(e && e.message || e), true);
        }
    };
    root.addEventListener("mousedown", (e) => {
        if (e.target === root) closeZeusJobDialog();
    });
    escHandler = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            closeZeusJobDialog();
        }
    };
    document.addEventListener("keydown", escHandler);

    document.body.appendChild(root);
    overlay = root;
    setStatus(t("zeus.starting", "正在启动 zeus…"));
}

/* status / config / cache are not tied to a project. */
const GLOBAL_ACTIONS = ["status", "config", "cache-update", "cache-clean"];

/* Runs a zeus command and streams it into the dialog. */
export async function runZeusProjectAction(action, projectUrl) {
    if (!projectUrl && GLOBAL_ACTIONS.indexOf(action) < 0) {
        await zpAlert(t("zeus.noProject", "请先选择一个项目"));
        return;
    }
    openZeusJobDialog(action);
    const log = overlay.querySelector(".zp-zjob__log");

    let res;
    try {
        res = await zeusRun({action, projectUrl});
    } catch (e) {
        closeZeusJobDialog();
        await zpAlert(String(e && e.message || e));
        return;
    }

    if (!res || !res.ok) {
        closeZeusJobDialog();
        if (res && res.code === "login_required") {
            await zpAlert(res.msg);
            if (typeof window._setReactPane === "function") window._setReactPane("settings");
            return;
        }
        await zpAlert((res && res.msg) || t("zeus.failed", "zeus 执行失败"));
        return;
    }

    currentJobId = res.jobId;
    setRunning(true);
    setStatus(t("zeus.running", "正在执行…"));

    watcher = watchZeusJob(res.jobId, {
        onLines: (lines) => appendLines(log, lines),
        onDone: (job) => {
            setRunning(false);
            watcher = null;
            if (job.code === 0) {
                setStatus(t("zeus.done", "已完成"));
                showToast(actionTitle(action) + " " + t("zeus.done", "已完成"), false);
            } else {
                setStatus(t("zeus.exitCode", "失败（退出码 {code}）").replace("{code}", String(job.code)), true);
            }
        },
        onError: (e) => {
            setRunning(false);
            watcher = null;
            setStatus(String(e && e.message || e), true);
        },
    });
}
