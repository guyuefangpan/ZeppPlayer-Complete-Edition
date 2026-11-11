/*
    Thin client for the zeus bridge the desktop shell exposes under
    /api/zeus/*. Every call fails fast when the bridge is missing (phone
    WebView, plain browser, the Python dev server) so the UI can tell the
    user that the zeus toolkit needs the desktop app.
*/

import I18n from "../zepp_player/i18n.js";

const POLL_INTERVAL = 600;

function bridgeMissing() {
    const err = new Error(I18n.t("zeus.missing",
        "未检测到 zeus。请安装命令行工具：npm i -g @zeppos/zeus-cli"));
    err.code = "zeus_missing";
    return err;
}

async function getJson(url) {
    let r;
    try {
        r = await fetch(url);
    } catch (e) {
        throw bridgeMissing();
    }
    // A missing route answers with the SPA fallback (HTML) or a 404.
    const type = r.headers.get("content-type") || "";
    if (!r.ok || type.indexOf("application/json") < 0) throw bridgeMissing();
    return r.json();
}

async function postJson(url, payload) {
    let r;
    try {
        r = await fetch(url, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload || {}),
        });
    } catch (e) {
        throw bridgeMissing();
    }
    const type = r.headers.get("content-type") || "";
    if (type.indexOf("application/json") < 0) throw bridgeMissing();
    return r.json();
}

export function zeusInfo() {
    return getJson("/api/zeus/info");
}

export function zeusTemplates(appType, apiLevel) {
    const q = "?appType=" + encodeURIComponent(appType)
        + "&apiLevel=" + encodeURIComponent(apiLevel);
    return getJson("/api/zeus/templates" + q);
}

export function zeusRun(payload) {
    return postJson("/api/zeus/run", payload);
}

export function zeusJob(id, from) {
    return getJson("/api/zeus/job?id=" + encodeURIComponent(id)
        + "&from=" + String(from || 0));
}

export function zeusStop(id) {
    return postJson("/api/zeus/stop", {id});
}

export function zeusLogin(cookie, cname) {
    return postJson("/api/zeus/login", {cookie, cname});
}

export function zeusLogout() {
    return postJson("/api/zeus/logout", {});
}

/* Polls a job until it finishes. Returns a handle so the dialog can stop
 * polling when the user closes it. */
export function watchZeusJob(jobId, handlers) {
    let cursor = 0;
    let stopped = false;
    let timer = null;

    const tick = async () => {
        if (stopped) return;
        try {
            const j = await zeusJob(jobId, cursor);
            if (stopped) return;
            if (j && j.lines && j.lines.length) {
                cursor = j.next;
                if (handlers.onLines) handlers.onLines(j.lines);
            }
            if (j && !j.running) {
                stopped = true;
                if (handlers.onDone) handlers.onDone(j);
                return;
            }
        } catch (e) {
            stopped = true;
            if (handlers.onError) handlers.onError(e);
            return;
        }
        timer = setTimeout(tick, POLL_INTERVAL);
    };

    timer = setTimeout(tick, POLL_INTERVAL);

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        },
    };
}
