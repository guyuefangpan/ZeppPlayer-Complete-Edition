/*
    Every zeus command behind one toolbar dropdown.

    The wide desktop toolbar shows the dropdown on its own; narrow windows and
    phones reuse the "project files" dropdown instead, so the same entries are
    injected there. Phones have no zeus bridge, so nothing is injected there.
*/

import I18n from "../zepp_player/i18n.js";
import {ProjectPicker} from "./ProjectPicker";
import {runZeusProjectAction} from "./ZeusJobDialog.js";
import {isDesktopShell} from "./ViewMode.js";

/* group: 1 = project, 2 = device, 3 = maintenance */
const ITEMS = [
    {kind: "new", icon: "note_add", key: "zeus.item.new", fallback: "新建项目（zeus create）", group: 1},
    {kind: "build", icon: "archive", key: "zeus.item.build", fallback: "构建打包（zeus build）", group: 1},
    {kind: "dev", icon: "bug_report", key: "zeus.dev", fallback: "模拟器调试（本机运行）", group: 2},
    {kind: "preview", icon: "smartphone", key: "zeus.preview", fallback: "真机预览（zeus preview）", group: 2},
    {kind: "bridge", icon: "link", key: "zeus.bridge", fallback: "真机联调（zeus bridge）", group: 2},
    {kind: "status", icon: "verified_user", key: "zeus.status", fallback: "账号与连接状态（zeus status）", group: 3},
    {kind: "config", icon: "tune", key: "zeus.config", fallback: "查看配置（zeus config list）", group: 3},
    {kind: "prune", icon: "cleaning_services", key: "zeus.prune", fallback: "清理构建产物（zeus prune）", group: 3},
    {kind: "cache-update", icon: "sync", key: "zeus.cacheUpdate", fallback: "更新设备缓存（zeus cache update）", group: 3},
    {kind: "cache-clean", icon: "delete_sweep", key: "zeus.cacheClean", fallback: "清空设备缓存（zeus cache clean）", group: 3},
];

function closeMenus() {
    const open = document.querySelectorAll(".zp-split.open");
    for (const el of open) el.classList.remove("open");
}

function makeSeparator() {
    const sep = document.createElement("div");
    sep.className = "zp-split__sep";
    return sep;
}

function makeItem(item) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "zp-split__item";
    btn.setAttribute("data-zeus", item.kind);

    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.textContent = item.icon;

    const label = document.createElement("span");
    label.textContent = I18n.t(item.key, item.fallback);

    btn.appendChild(icon);
    btn.appendChild(label);
    btn.onclick = () => {
        closeMenus();
        window.zpZeusAction(item.kind);
    };
    return btn;
}

function itemsOf(group) {
    return ITEMS.filter((item) => item.group === group);
}

function fillWide(menu) {
    let group = 0;
    for (const item of ITEMS) {
        if (item.group !== group) {
            group = item.group;
            if (menu.childElementCount) menu.appendChild(makeSeparator());
        }
        menu.appendChild(makeItem(item));
    }
}

/* Narrow windows merge the project entries (new / build) above Import and
 * keep the device and maintenance commands at the bottom. */
function fillNarrow(menu) {
    const importBtn = menu.querySelector('[onclick*="import"]');
    for (const item of itemsOf(1)) {
        const el = makeItem(item);
        if (importBtn) menu.insertBefore(el, importBtn);
        else menu.appendChild(el);
    }
    for (const group of [2, 3]) {
        menu.appendChild(makeSeparator());
        for (const item of itemsOf(group)) menu.appendChild(makeItem(item));
    }
}

export function initZeusMenu() {
    if (!isDesktopShell()) return;

    const wide = document.getElementById("zp_split_zeus_menu");
    if (wide && wide.getAttribute("data-zeus-ready") !== "1") {
        wide.setAttribute("data-zeus-ready", "1");
        fillWide(wide);
    }

    const files = document.getElementById("zp_split_files_menu");
    if (files && files.getAttribute("data-zeus-ready") !== "1") {
        files.setAttribute("data-zeus-ready", "1");
        // The narrow-window dropdown already carries the zeus entries, so the
        // phone-only "new" and "export" shortcuts would duplicate them.
        for (const el of Array.from(files.querySelectorAll("[data-zeus-dup]"))) el.remove();
        fillNarrow(files);
    }
}

window.zpZeusAction = (kind) => {
    if (kind === "new") {
        window.zpNewProject();
        return;
    }
    if (kind === "build") {
        window.zpExportProject();
        return;
    }
    /* `zeus dev` pushes the build to the official Zepp OS simulator over
     * socket.io; this app *is* the simulator, so the entry reloads the project
     * in the built-in player instead of connecting to itself. */
    if (kind === "dev") {
        window.zpRunInSimulator();
        return;
    }
    runZeusProjectAction(kind, ProjectPicker.getProject());
};
