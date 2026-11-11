/*
    Huami account login by pasting a browser cookie.

    zeus only stores three values (`token`, `userid`, `cname`) in
    ~/.zepp/.zeus, so the desktop shell can write them directly and skip the
    whole browser round-trip `zeus login` performs.
*/

import I18n from "../zepp_player/i18n.js";
import {showToast} from "../zepp_player/zpToast.js";
import {zeusLogin} from "./ZeusClient.js";
import "./NewProjectDialog.css";
import "./HuamiLoginDialog.css";

let overlay = null;
let escHandler = null;
let onDoneCb = null;

function t(key, fallback) {
    return I18n.t(key, fallback);
}

function setStatus(text, isError) {
    if (!overlay) return;
    const el = overlay.querySelector(".zp-np__status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("error", !!isError);
}

function setBusy(value) {
    if (!overlay) return;
    overlay.classList.toggle("zp-np--busy", value);
    for (const sel of ['[data-act="login"]', '[data-act="cancel"]', '[data-act="close"]']) {
        const el = overlay.querySelector(sel);
        if (el) el.disabled = value;
    }
}

export function closeHuamiLoginDialog() {
    if (!overlay) return;
    if (escHandler) {
        document.removeEventListener("keydown", escHandler);
        escHandler = null;
    }
    overlay.remove();
    overlay = null;
    onDoneCb = null;
}

async function handleLogin() {
    if (!overlay) return;
    const cookie = overlay.querySelector(".zp-hl__cookie").value.trim();
    const cname = overlay.querySelector(".zp-hl__cname").value.trim();
    if (!cookie) {
        setStatus(t("zeus.login.empty", "请先粘贴 Cookie"), true);
        return;
    }

    setBusy(true);
    setStatus(t("zeus.login.working", "正在写入登录态…"));
    try {
        const res = await zeusLogin(cookie, cname);
        if (!res || !res.ok) {
            setStatus((res && res.msg) || t("zeus.login.failed", "登录失败"), true);
            setBusy(false);
            return;
        }
        const done = onDoneCb;
        closeHuamiLoginDialog();
        showToast(t("zeus.login.ok", "华米账号已登录"), false);
        if (done) done(res.login);
    } catch (e) {
        setStatus(String(e && e.message || e), true);
        setBusy(false);
    }
}

export function openHuamiLoginDialog(onDone) {
    if (overlay) return;
    onDoneCb = onDone || null;

    const root = document.createElement("div");
    root.id = "zp-huami-login-overlay";
    root.className = "zp-np";
    root.innerHTML = `
        <div class="zp-np__dialog" role="dialog" aria-modal="true">
            <div class="zp-np__head">
                <span class="material-symbols-outlined zp-np__headIcon">account_circle</span>
                <h2 class="zp-np__title">${t("zeus.login.title", "华米账号登录")}</h2>
                <button type="button" class="zp-np__close material-symbols-outlined" data-act="close">close</button>
            </div>
            <div class="zp-np__body">
                <ol class="zp-hl__steps">
                    <li>${t("zeus.login.step1", "在浏览器打开 user.zepp.com 并登录你的华米账号")}</li>
                    <li>${t("zeus.login.step2", "按 F12 打开开发者工具，切到 Console（控制台）")}</li>
                    <li>${t("zeus.login.step3", "输入 document.cookie 回车，复制输出的整行内容")}</li>
                    <li>${t("zeus.login.step4", "把内容粘贴到下面，点击登录")}</li>
                </ol>
                <p class="zp-hl__hint">${t("zeus.login.hint",
                    "若 Cookie 中没有 apptoken，可改为粘贴登录后的跳转地址（含 apptoken=…&userid=…&cname=…）。")}</p>
                <div class="zp-np__label">${t("zeus.login.cookie", "Cookie")}</div>
                <textarea class="zp-hl__cookie" spellcheck="false"
                    placeholder="apptoken=...; userid=..."></textarea>
                <div class="zp-np__label">${t("zeus.login.cname", "服务器域名（可选）")}</div>
                <input class="zp-hl__cname" type="text" spellcheck="false" placeholder="api-mifit.huami.com" />
                <div class="zp-np__status" role="status"></div>
            </div>
            <div class="zp-np__foot">
                <button type="button" class="zp-np__btn" data-act="cancel">${t("newProject.cancel", "取消")}</button>
                <button type="button" class="zp-np__btn primary" data-act="login">${t("zeus.login.submit", "登录")}</button>
            </div>
        </div>`;

    root.querySelector('[data-act="close"]').onclick = closeHuamiLoginDialog;
    root.querySelector('[data-act="cancel"]').onclick = closeHuamiLoginDialog;
    root.querySelector('[data-act="login"]').onclick = handleLogin;
    root.addEventListener("mousedown", (e) => {
        if (e.target === root) closeHuamiLoginDialog();
    });
    escHandler = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            closeHuamiLoginDialog();
        }
    };
    document.addEventListener("keydown", escHandler);

    document.body.appendChild(root);
    overlay = root;
    root.querySelector(".zp-hl__cookie").focus();
}
