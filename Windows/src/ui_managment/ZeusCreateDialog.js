/*
    Phone-side "new project": asks the bare minimum and then lets the real
    `zeus create` on the device do the work.

    zeus asks a chain of questions (app type, API level, template, app-side,
    settings, build targets) and those prompts need a TTY, which an Android
    WebView cannot provide. Passing every answer up front skips all of them:
    non-empty templates never trigger the app-side/settings/build-target
    questions, and the template name is matched by zeus itself.
*/

import I18n from "../zepp_player/i18n.js";
import {runZeusProjectAction} from "./ZeusJobDialog.js";
import "./NewProjectDialog.css";
import "./HuamiLoginDialog.css";
import "./ZeusCreateDialog.css";

let overlay = null;
let escHandler = null;

function t(key, fallback) {
    return I18n.t(key, fallback);
}

/* Template folders bundled with zeus, per API level. The value is what zeus
 * expects on the command line (its "Hello World" folder is matched as
 * "Hello_World"). */
const TEMPLATES = {
    "1.0": [
        {value: "Hello_World", label: "Hello World"},
        {value: "Todo List", label: "Todo List"},
        {value: "Fetch Api", label: "Fetch Api"},
        {value: "Calories", label: "Calories"},
    ],
    "2.0": [
        {value: "Hello_World", label: "Hello World"},
        {value: "Todo List", label: "Todo List"},
        {value: "Fetch Api", label: "Fetch Api"},
        {value: "Calories", label: "Calories"},
        {value: "Showcase", label: "Showcase"},
    ],
    "3.0": [
        {value: "Hello_World", label: "Hello World"},
        {value: "Todo List", label: "Todo List"},
        {value: "Fetch Api", label: "Fetch Api"},
        {value: "Calories", label: "Calories"},
        {value: "Notification", label: "Notification"},
        {value: "Download", label: "Download"},
    ],
    "4.0": [
        {value: "Hello_World", label: "Hello World"},
        {value: "Todo List", label: "Todo List"},
        {value: "Fetch Api", label: "Fetch Api"},
        {value: "Calories", label: "Calories"},
        {value: "Showcase", label: "Showcase"},
    ],
};

const LEVELS = ["1.0", "2.0", "3.0", "4.0"];

let state = {level: "3.0", template: "Hello_World"};

function setStatus(text, isError) {
    if (!overlay) return;
    const el = overlay.querySelector(".zp-zc__status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("error", !!isError);
}

function renderTemplates() {
    const box = overlay.querySelector(".zp-zc__templates");
    if (!box) return;
    box.textContent = "";
    const list = TEMPLATES[state.level] || [];
    if (!list.some((item) => item.value === state.template)) {
        state.template = list.length ? list[0].value : "";
    }
    for (const item of list) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "zp-np__ver" + (item.value === state.template ? " active" : "");
        btn.textContent = item.label;
        btn.onclick = () => {
            state.template = item.value;
            renderTemplates();
        };
        box.appendChild(btn);
    }
}

function renderLevels() {
    const box = overlay.querySelector(".zp-zc__levels");
    if (!box) return;
    box.textContent = "";
    for (const level of LEVELS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "zp-np__ver" + (level === state.level ? " active" : "");
        btn.textContent = level;
        btn.onclick = () => {
            state.level = level;
            renderLevels();
            renderTemplates();
        };
        box.appendChild(btn);
    }
}

function submit() {
    if (!overlay) return;
    const name = overlay.querySelector(".zp-zc__name").value.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name)) {
        setStatus(t("zeus.create.badName",
            "项目名需以字母开头，只能包含字母、数字、下划线或短横线"), true);
        return;
    }
    if (!state.template) {
        setStatus(t("zeus.create.noTemplate", "请选择项目模板"), true);
        return;
    }

    const payload = {
        name,
        apiLevel: state.level,
        appType: "app",
        template: state.template,
    };
    closeZeusCreateDialog();
    runZeusProjectAction("create", "", payload);
}

export function closeZeusCreateDialog() {
    if (!overlay) return;
    if (escHandler) {
        document.removeEventListener("keydown", escHandler);
        escHandler = null;
    }
    overlay.remove();
    overlay = null;
}

export function openZeusCreateDialog() {
    if (overlay) return;
    state = {level: "3.0", template: "Hello_World"};

    const root = document.createElement("div");
    root.id = "zp-zeus-create-overlay";
    root.className = "zp-np";
    root.innerHTML = `
        <div class="zp-np__dialog" role="dialog" aria-modal="true">
            <div class="zp-np__head">
                <span class="material-symbols-outlined zp-np__headIcon">note_add</span>
                <h2 class="zp-np__title">${t("zeus.create.title", "新建项目（zeus create）")}</h2>
                <button type="button" class="zp-np__close material-symbols-outlined" data-act="close">close</button>
            </div>
            <div class="zp-np__body">
                <div class="zp-np__label">${t("zeus.create.name", "项目名称")}</div>
                <input class="zp-zc__name zp-hl__cname" type="text" spellcheck="false"
                    autocapitalize="off" autocomplete="off" placeholder="MyApp" />
                <div class="zp-np__label">${t("zeus.create.level", "API Level")}</div>
                <div class="zp-zc__levels zp-np__versions"></div>
                <div class="zp-np__label">${t("zeus.create.template", "模板")}</div>
                <div class="zp-zc__templates zp-np__versions"></div>
                <p class="zp-zc__hint">${t("zeus.create.hint",
                    "项目会创建在应用的项目目录里，完成后自动打开。")}</p>
                <div class="zp-zc__status zp-np__status" role="status"></div>
            </div>
            <div class="zp-np__foot">
                <button type="button" class="zp-np__btn" data-act="cancel">${t("newProject.cancel", "取消")}</button>
                <button type="button" class="zp-np__btn primary" data-act="create">${t("zeus.create.submit", "创建")}</button>
            </div>
        </div>`;

    root.querySelector('[data-act="close"]').onclick = closeZeusCreateDialog;
    root.querySelector('[data-act="cancel"]').onclick = closeZeusCreateDialog;
    root.querySelector('[data-act="create"]').onclick = submit;
    root.querySelector(".zp-zc__name").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            submit();
        }
    });
    root.addEventListener("mousedown", (e) => {
        if (e.target === root) closeZeusCreateDialog();
    });
    escHandler = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            closeZeusCreateDialog();
        }
    };
    document.addEventListener("keydown", escHandler);

    document.body.appendChild(root);
    overlay = root;
    renderLevels();
    renderTemplates();
    root.querySelector(".zp-zc__name").focus();
}
