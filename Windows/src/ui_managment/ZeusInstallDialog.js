/*
    Zeus runtime installer.

    The Android client ships a real Node.js + @zeppos/zeus-cli payload (~100 MB
    unpacked). Unpacking it costs disk and time, so it only happens when the
    user agrees: this dialog shows up once per app version, reports live
    progress from /api/zeus/install_progress, and can be reopened from
    Settings later.
*/

import I18n from "../zepp_player/i18n.js";

const SKIP_KEY = "zp_zeus_install_skip";
const POLL_INTERVAL = 400;

let overlay = null;
let timer = null;

function t(key, fallback) {
    return I18n.t(key, fallback);
}

function formatMb(bytes) {
    return (Math.max(0, Number(bytes) || 0) / 1048576).toFixed(1);
}

function close(remember) {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    if (remember && overlay) {
        const version = overlay.getAttribute("data-app-version") || "";
        try { localStorage.setItem(SKIP_KEY, version); } catch (e) {}
    }
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
}

async function refreshMenu() {
    try {
        const mod = await import("./ZeusMenu.js");
        if (mod && mod.initZeusMenu) mod.initZeusMenu();
    } catch (e) {}
}

export function openZeusInstallDialog(options) {
    const opts = options || {};
    if (overlay) return;

    const version = opts.appVersion || "";
    const totalMb = formatMb(opts.runtimeBytes);

    const root = document.createElement("div");
    root.className = "zp-np";
    root.id = "zp-zeus-install-overlay";
    root.setAttribute("data-app-version", version);
    root.innerHTML = `
        <div class="zp-np__dialog" role="dialog" aria-modal="true">
            <div class="zp-np__head">
                <span class="material-symbols-outlined zp-np__headIcon">memory</span>
                <h2 class="zp-np__title">${t("zeus.install.title", "安装 Zeus 运行时")}</h2>
                <button type="button" class="zp-np__close material-symbols-outlined" data-act="close">close</button>
            </div>
            <div class="zp-np__body">
                <p class="zp-hl__hint" style="margin-top:0">
                    ${t("zeus.install.desc",
                        "手机端内置的是真正的 Node.js 与 @zeppos/zeus-cli，而不是用脚本模拟的替代品。")}
                </p>
                <p class="zp-hl__hint">
                    ${t("zeus.install.size", "需要解压约 {size} MB 到应用私有目录，只在本机进行，不消耗流量。")
                        .replace("{size}", totalMb)}
                </p>
                <div class="zp-zi__bar" style="height:6px;border-radius:3px;background:rgba(127,127,127,.25);overflow:hidden">
                    <div class="zp-zi__fill" style="height:100%;width:0%;background:#4c8dff;transition:width .2s"></div>
                </div>
                <div class="zp-np__status zp-zi__status" role="status" style="margin-top:8px;word-break:break-all"></div>
            </div>
            <div class="zp-np__foot">
                <button type="button" class="zp-np__btn" data-act="later">
                    ${t("zeus.install.later", "稍后")}
                </button>
                <button type="button" class="zp-np__btn primary" data-act="install">
                    ${t("zeus.install.start", "安装")}
                </button>
            </div>
        </div>`;

    const fill = root.querySelector(".zp-zi__fill");
    const status = root.querySelector(".zp-zi__status");
    const installBtn = root.querySelector('[data-act="install"]');
    const laterBtn = root.querySelector('[data-act="later"]');

    const setProgress = (p) => {
        fill.style.width = Math.max(0, Math.min(100, p.percent || 0)) + "%";
        if (p.state === "installing") {
            status.textContent = t("zeus.install.progress", "正在解压 {done} / {total} MB")
                .replace("{done}", formatMb(p.bytes))
                .replace("{total}", formatMb(p.total));
        } else if (p.state === "done") {
            status.textContent = t("zeus.install.done", "安装完成，zeus 菜单已可用");
            installBtn.disabled = false;
            installBtn.textContent = t("zeus.install.close", "完成");
            installBtn.setAttribute("data-act", "close");
        } else if (p.state === "failed") {
            if (timer) { clearInterval(timer); timer = null; }
            status.textContent = t("zeus.install.failed", "安装失败：{msg}")
                .replace("{msg}", p.error || "unknown");
            installBtn.disabled = false;
        }
    };

    const poll = () => {
        fetch("/api/zeus/install_progress")
            .then((r) => r.json())
            .then((p) => {
                setProgress(p || {});
                if (p && p.state === "done") {
                    if (timer) { clearInterval(timer); timer = null; }
                    refreshMenu();
                }
            })
            .catch(() => {});
    };

    const start = () => {
        installBtn.disabled = true;
        status.textContent = t("zeus.install.starting", "正在准备…");
        fetch("/api/zeus/install", { method: "POST", headers: {"Content-Type": "application/json"}, body: "{}" })
            .then((r) => r.json())
            .then((res) => {
                if (!res || !res.ok) {
                    status.textContent = (res && res.msg) || t("zeus.install.failed", "安装失败：{msg}").replace("{msg}", "");
                    installBtn.disabled = false;
                    return;
                }
                if (timer) clearInterval(timer);
                timer = setInterval(poll, POLL_INTERVAL);
                poll();
            })
            .catch((e) => {
                status.textContent = t("zeus.install.failed", "安装失败：{msg}").replace("{msg}", String(e && e.message || e));
                installBtn.disabled = false;
            });
    };

    installBtn.onclick = () => {
        if (installBtn.getAttribute("data-act") === "close") {
            close(false);
            return;
        }
        start();
    };
    laterBtn.onclick = () => close(true);
    root.querySelector('[data-act="close"]').onclick = () => close(false);
    root.addEventListener("mousedown", (e) => {
        if (e.target === root && !timer) close(true);
    });

    document.body.appendChild(root);
    overlay = root;

    /* If an install is already running (dialog reopened, or the activity was
     * recreated), pick up its progress instead of starting over. */
    fetch("/api/zeus/install_progress")
        .then((r) => r.json())
        .then((p) => {
            setProgress(p || {});
            if (p && p.state === "installing") {
                installBtn.disabled = true;
                timer = setInterval(poll, POLL_INTERVAL);
            }
        })
        .catch(() => {});
}

/** Called once at boot; asks only when the runtime is missing. */
export function maybePromptZeusInstall() {
    fetch("/api/zeus/info")
        .then((r) => {
            const type = r.headers.get("content-type") || "";
            return (r.ok && type.indexOf("application/json") > -1) ? r.json() : null;
        })
        .then((info) => {
            if (!info || !info.ok || !info.supported) return;
            if (!info.needsInstall) return;
            let skipped = "";
            try { skipped = localStorage.getItem(SKIP_KEY) || ""; } catch (e) {}
            if (skipped === info.appVersion) return;
            openZeusInstallDialog({
                appVersion: info.appVersion,
                runtimeBytes: info.runtimeBytes,
            });
        })
        .catch(() => {});
}

export function forceZeusInstallDialog() {
    fetch("/api/zeus/info")
        .then((r) => r.json())
        .then((info) => openZeusInstallDialog({
            appVersion: info && info.appVersion,
            runtimeBytes: info && info.runtimeBytes,
        }))
        .catch(() => {});
}
