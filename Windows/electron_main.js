/*
    ZeppPlayer desktop shell (Electron).
    The Python local server of the original project is re-implemented here
    with Node's built-ins, serving the same /api and /projects routes the
    web front-end expects. The app (including the app-side engine) runs as
    a plain web page inside the renderer - no Node integration needed.
*/

const { app, BrowserWindow, shell, dialog } = require("electron");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const url = require("url");
const { execFile, spawn } = require("child_process");

/* A second instance would start another local server and a second window on
 * the same project folder, so only one copy may run at a time. */
let mainWindow = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });
}

const ROOT_DIR = __dirname;
const APP_DIR = path.join(ROOT_DIR, "app");
const BUNDLED_PROJECTS_DIR = path.join(ROOT_DIR, "projects");
const USER_CONFIG = path.join(app.getPath("userData"), "user_config.json");

/* When the app runs from an installed build, __dirname points inside
 * resources/app.asar, which is read-only: projects cannot be imported or
 * edited there. Use a writable user directory instead and seed it with the
 * bundled sample project on first launch. */
const DEFAULT_PROJECTS_DIR = app.isPackaged
    ? path.join(app.getPath("documents"), "ZeppPlayerProjects")
    : BUNDLED_PROJECTS_DIR;

let projectDir = null;
let PORT = 12789;
const PORT_MAX = PORT + 10;

/* File change counter exposed through /api/change_count. The front-end
 * watcher uses it to auto-restart the player when project files change. */
let changeSeq = 0;
let changeTimer = null;
let projectWatcher = null;

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(USER_CONFIG, "utf8"));
    } catch (e) {
        return {};
    }
}

function writeConfig(patch) {
    const cfg = Object.assign(readConfig(), patch);
    try {
        fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
        fs.writeFileSync(USER_CONFIG, JSON.stringify(cfg));
    } catch (e) {
        console.error("Failed to save config", e);
    }
}

function isWritableDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, ".zp_write_test");
        fs.writeFileSync(probe, "");
        fs.unlinkSync(probe);
        return true;
    } catch (e) {
        return false;
    }
}

function copyTree(src, dst) {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        for (const name of fs.readdirSync(src)) {
            copyTree(path.join(src, name), path.join(dst, name));
        }
        return;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, fs.readFileSync(src));
}

function hasProjects(dir) {
    try {
        return fs.readdirSync(dir).some((name) => {
            const p = path.join(dir, name);
            return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "app.json"));
        });
    } catch (e) {
        return false;
    }
}

function seedBundledProjects(dir) {
    if (!fs.existsSync(BUNDLED_PROJECTS_DIR) || hasProjects(dir)) return;
    try {
        for (const name of fs.readdirSync(BUNDLED_PROJECTS_DIR)) {
            const src = path.join(BUNDLED_PROJECTS_DIR, name);
            if (!fs.statSync(src).isDirectory()) continue;
            copyTree(src, path.join(dir, name));
        }
    } catch (e) {
        console.error("Failed to seed bundled projects", e);
    }
}

function getProjectsDir() {
    if (projectDir) return projectDir;
    const cfg = readConfig();
    if (cfg.projectsPath && isWritableDir(cfg.projectsPath)) {
        projectDir = cfg.projectsPath;
    } else {
        projectDir = DEFAULT_PROJECTS_DIR;
        if (!isWritableDir(projectDir)) {
            projectDir = path.join(app.getPath("userData"), "projects");
            fs.mkdirSync(projectDir, { recursive: true });
        }
    }
    // Only the app-managed folder gets the bundled sample project; a folder
    // picked by the user must stay exactly as it is.
    if (projectDir === DEFAULT_PROJECTS_DIR) seedBundledProjects(projectDir);
    return projectDir;
}

function uniqueDirName(projectsDir, name) {
    let candidate = name;
    let i = 1;
    while (fs.existsSync(path.join(projectsDir, candidate))) {
        candidate = `${name} (${i++})`;
    }
    return candidate;
}

function looksLikeProject(dir) {
    return fs.existsSync(path.join(dir, "app.json"));
}

/* A zip or folder often wraps the real project in a single sub directory. */
function findProjectRoot(dir) {
    if (looksLikeProject(dir)) return dir;
    try {
        const hits = fs.readdirSync(dir)
            .map((n) => path.join(dir, n))
            .filter((p) => fs.statSync(p).isDirectory() && looksLikeProject(p));
        if (hits.length === 1) return hits[0];
    } catch (e) {}
    return null;
}

function extractZip(zipPath, destDir) {
    return new Promise((resolve) => {
        execFile("tar", ["-xf", zipPath, "-C", destDir], { windowsHide: true }, (err) => {
            if (!err) return resolve(null);
            const esc = (s) => String(s).replace(/'/g, "''");
            const cmd = `Expand-Archive -LiteralPath '${esc(zipPath)}' -DestinationPath '${esc(destDir)}' -Force`;
            execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd],
                { windowsHide: true }, (err2) => {
                    resolve(err2 ? (err2.message || String(err2)) : null);
                });
        });
    });
}

/**
 * Show native dialogs and import a ZeppOS project (folder or .zip)
 * into the projects directory. Returns a JSON-ish result object.
 */
async function handleImportProject() {
    const win = BrowserWindow.getAllWindows()[0];
    const choice = await dialog.showMessageBox(win || undefined, {
        type: "question",
        title: "导入项目 / Import project",
        message: "选择项目来源 / Choose the source",
        detail: "支持包含 app.json 的项目文件夹，或 .zip 压缩包。\n"
            + "A ZeppOS project folder (with app.json) or a .zip archive.",
        buttons: ["文件夹 / Folder", "ZIP 压缩包 / ZIP", "取消 / Cancel"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
    });
    if (choice.response === 2) return { ok: false, cancelled: true };

    let src;
    if (choice.response === 0) {
        const r = await dialog.showOpenDialog(win || undefined, {
            title: "选择项目文件夹 / Select project folder",
            properties: ["openDirectory"],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
        src = r.filePaths[0];
    } else {
        const r = await dialog.showOpenDialog(win || undefined, {
            title: "选择 ZIP 压缩包 / Select ZIP archive",
            properties: ["openFile"],
            filters: [{ name: "ZIP", extensions: ["zip"] }],
        });
        if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
        src = r.filePaths[0];
    }

    return importProjectFromPath(src);
}

/**
 * Import a project from an absolute path (folder or .zip) into the projects
 * directory. Shared by the native import dialog and the drag & drop handler.
 */
async function importProjectFromPath(src, displayBase) {
    const projectsDir = getProjectsDir();
    let st;
    try {
        st = fs.statSync(src);
    } catch (e) {
        return { ok: false, msg: "路径不存在：" + src };
    }

    if (st.isDirectory()) {
        const root = findProjectRoot(src);
        if (!root) return { ok: false, msg: "所选文件夹中没有找到 app.json" };
        const name = path.basename(root);
        const dest = path.join(projectsDir, uniqueDirName(projectsDir, name));
        copyTree(root, dest);
        return { ok: true, name: path.basename(dest), path: dest };
    }

    if (st.isFile() && src.toLowerCase().endsWith(".zip")) {
        const tmp = path.join(projectsDir, ".__import_tmp");
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true });
        const err = await extractZip(src, tmp);
        if (err) {
            fs.rmSync(tmp, { recursive: true, force: true });
            return { ok: false, msg: "解压失败：" + err };
        }
        const root = findProjectRoot(tmp);
        if (!root) {
            fs.rmSync(tmp, { recursive: true, force: true });
            return { ok: false, msg: "压缩包中没有找到 app.json" };
        }
        // A zip with app.json at its root has no wrapper folder: the project
        // root *is* the temp dir, so it can only be renamed, never copied out.
        const atZipRoot = root === tmp;
        const base = atZipRoot
            ? (String(displayBase || "").trim() || path.basename(src, ".zip"))
            : path.basename(root);
        const dest = path.join(projectsDir, uniqueDirName(projectsDir, base));
        fs.renameSync(root, dest);
        if (!atZipRoot) fs.rmSync(tmp, { recursive: true, force: true });
        return { ok: true, name: path.basename(dest), path: dest };
    }

    return { ok: false, msg: "不支持的文件类型" };
}

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".tga": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".txt": "text/plain; charset=utf-8",
};

function send(res, data, contentType) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Content-Type", contentType || "text/plain; charset=utf-8");
    res.end(data);
}

function sendJson(res, obj, status) {
    if (status) res.statusCode = status;
    send(res, JSON.stringify(obj), "application/json");
}

function sendFile(res, absPath) {
    fs.stat(absPath, (err, st) => {
        if (err || !st.isFile()) {
            res.statusCode = 404;
            return send(res, "Not found");
        }
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Content-Type", MIME[path.extname(absPath).toLowerCase()] || "application/octet-stream");
        res.setHeader("Content-Length", st.size);
        fs.createReadStream(absPath).pipe(res);
    });
}

function normalizeFsPath(p) {
    let s = String(p || "").replace(/\\/g, "/");
    if (!s) return "";
    s = s.replace(/\/+$/, "");
    if (/^[a-zA-Z]:$/.test(s)) s += "/";
    if (/^[a-zA-Z]:/.test(s)) return path.win32.normalize(s);
    return path.resolve(path.parse(process.cwd()).root, s.replace(/^\/+/, ""));
}

function listDir(dir) {
    return fs.readdirSync(dir).filter((name) => {
        try {
            return fs.statSync(path.join(dir, name)).isDirectory();
        } catch (e) {
            return false;
        }
    }).sort((a, b) => a.localeCompare(b));
}

function getScreenshotDir() {
    try {
        return path.join(app.getPath("pictures"), "ZeppPlayer");
    } catch (e) {
        return path.join(app.getPath("userData"), "screenshots");
    }
}

function getVideoDir() {
    try {
        return path.join(app.getPath("videos"), "ZeppPlayer");
    } catch (e) {
        return path.join(app.getPath("userData"), "videos");
    }
}

function sanitizeMediaName(name, fallbackExt) {
    const base = path.basename(String(name || ""))
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .trim();
    if (!base) return "";
    return /\.(png|gif|mp4|webm)$/i.test(base) ? base : base + (fallbackExt || ".png");
}

function uniqueFilePath(dir, name) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let dest = path.join(dir, name);
    let i = 1;
    while (fs.existsSync(dest)) dest = path.join(dir, `${stem} (${i++})${ext}`);
    return dest;
}

/* Map a front-end project URL ("/projects/Name" or "/projects/Name/build")
 * back to an absolute directory inside the projects folder. */
function resolveProjectDir(projectUrl) {
    const rel = String(projectUrl || "").replace(/^\/?projects\/?/, "").split("?")[0];
    const parts = rel.split(/[/\\]+/).filter(Boolean);
    if (!parts.length) return null;
    const projectsDir = getProjectsDir();
    const abs = path.resolve(projectsDir, parts[0]);
    if (abs !== path.resolve(projectsDir) && !abs.startsWith(path.resolve(projectsDir) + path.sep)) {
        return null;
    }
    try {
        return fs.statSync(abs).isDirectory() ? abs : null;
    } catch (e) {
        return null;
    }
}

function getTextExportDir() {
    try {
        return path.join(app.getPath("documents"), "ZeppPlayerLogs");
    } catch (e) {
        return path.join(app.getPath("userData"), "logs");
    }
}

function sanitizeFileName(name, fallbackExt) {
    const base = path.basename(String(name || ""))
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .trim();
    if (!base) return "";
    return path.extname(base) ? base : base + (fallbackExt || "");
}

/* Windows ships bsdtar which can write zip archives; PowerShell
 * Compress-Archive is the more predictable fallback. */
function zipDirectory(srcDir, zipPath) {
    return new Promise((resolve) => {
        execFile("tar", ["-a", "-cf", zipPath, "-C", path.dirname(srcDir), path.basename(srcDir)],
            { windowsHide: true }, (err) => {
                if (!err) return resolve(null);
                const esc = (s) => String(s).replace(/'/g, "''");
                const cmd = `Compress-Archive -LiteralPath '${esc(srcDir)}' -DestinationPath '${esc(zipPath)}' -Force`;
                execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd],
                    { windowsHide: true }, (err2) => {
                        resolve(err2 ? (err2.message || String(err2)) : null);
                    });
            });
    });
}

/* ------------------------------------------------------------------ *
 * Export pipeline
 *
 * Projects written with ES module syntax (`import` / `export`) cannot run
 * on a real device as-is: the watch runtime executes one plain script per
 * page, so the modules have to be bundled and compiled first. That is what
 * `zeus build` does (rollup + QuickJS bytecode) and it writes the finished
 * installer to `<project>/dist/*.zab`.
 *
 * Projects that only use CommonJS / plain scripts can be zipped directly;
 * on Mi Band style devices that archive is distributed with a `.bin`
 * extension (it is still a plain zip with app.json at its root).
 * ------------------------------------------------------------------ */

const ESM_SCAN_SKIP_DIRS = new Set([
    "node_modules", "dist", ".git", ".svn", ".hg", ".idea", ".vscode",
]);

/* Replace comments and the *contents* of string literals with spaces while
 * keeping the original length and the quote characters. This lets the ESM
 * keyword check ignore commented-out code and strings such as
 * console.log("import x from y"), while still matching `import "./x"`. */
function maskJsCommentsAndStrings(src) {
    let out = "";
    let quote = null;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        const n = src[i + 1];
        if (quote) {
            if (c === "\\") {
                out += "  ";
                i++;
            } else if (c === quote) {
                quote = null;
                out += c;
            } else {
                out += c === "\n" ? "\n" : " ";
            }
            continue;
        }
        if (c === "/" && n === "/") {
            while (i < src.length && src[i] !== "\n") {
                out += " ";
                i++;
            }
            out += "\n";
            continue;
        }
        if (c === "/" && n === "*") {
            out += "  ";
            i += 2;
            while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
                out += src[i] === "\n" ? "\n" : " ";
                i++;
            }
            out += "  ";
            i++;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            quote = c;
            out += c;
            continue;
        }
        out += c;
    }
    return out;
}

const ESM_IMPORT_RE = /(?:^|[^.\w$])import\s*(?:\(|["']|[A-Za-z_$*{])/;
const ESM_EXPORT_RE = /(?:^|[^.\w$])export\s*(?:default|const|let|var|function|class|async|\{|\*)/;

/* Returns the relative paths of project scripts that use ES module syntax. */
function scanEsmImports(dir) {
    const hits = [];
    const MAX_HITS = 20;

    const walk = (current, depth) => {
        if (hits.length >= MAX_HITS || depth > 12) return;
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            if (hits.length >= MAX_HITS) return;
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!ESM_SCAN_SKIP_DIRS.has(entry.name.toLowerCase())) walk(abs, depth + 1);
                continue;
            }
            if (!entry.isFile() || !/\.(js|mjs)$/i.test(entry.name)) continue;
            let st;
            try {
                st = fs.statSync(abs);
            } catch (e) {
                continue;
            }
            if (st.size > 4 * 1024 * 1024) continue;
            let src;
            try {
                src = fs.readFileSync(abs, "utf8");
            } catch (e) {
                continue;
            }
            if (!/\b(import|export)\b/.test(src)) continue;
            const masked = maskJsCommentsAndStrings(src);
            if (ESM_IMPORT_RE.test(masked) || ESM_EXPORT_RE.test(masked)) {
                hits.push(path.relative(dir, abs).replace(/\\/g, "/"));
            }
        }
    };

    walk(dir, 0);
    return hits;
}

function readAppJson(dir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8"));
    } catch (e) {
        return null;
    }
}

/* Locate the global zeus launcher without relying on the packaged app's
 * PATH, which often misses the npm global prefix on Windows. */
function findZeusCommand() {
    const names = process.platform === "win32"
        ? ["zeus.cmd", "zeus.exe", "zeus.ps1"]
        : ["zeus"];
    const dirs = [];
    if (process.env.ZEUS_CLI) {
        const explicit = String(process.env.ZEUS_CLI).replace(/^"|"$/g, "");
        try {
            if (fs.existsSync(explicit)) return explicit;
        } catch (e) {}
    }
    if (process.platform === "win32") {
        if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
        if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, "nodejs"));
    }
    for (const part of String(process.env.PATH || "").split(path.delimiter)) {
        const clean = part.replace(/^"|"$/g, "").trim();
        if (clean) dirs.push(clean);
    }
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            try {
                if (fs.existsSync(candidate)) return candidate;
            } catch (e) {}
        }
    }
    return null;
}

function newestZab(distDir, since) {
    let best = null;
    try {
        for (const name of fs.readdirSync(distDir)) {
            if (!/\.zab$/i.test(name)) continue;
            const abs = path.join(distDir, name);
            const st = fs.statSync(abs);
            if (!st.isFile() || st.mtimeMs < since - 5000) continue;
            if (!best || st.mtimeMs > best.mtime) best = { path: abs, mtime: st.mtimeMs };
        }
    } catch (e) {}
    return best;
}

/* Run `zeus build` inside the project. v2 configs with several targets would
 * otherwise open an interactive checkbox prompt, so every target is passed
 * explicitly; v3 builds all targets on its own. */
function runZeusBuild(dir, zeusCmd) {
    return new Promise((resolve) => {
        const appJson = readAppJson(dir);
        if (!appJson) {
            return resolve({ ok: false, code: "app_json", msg: "app.json 缺失或格式错误，无法执行 zeus build" });
        }
        const targets = appJson.targets && typeof appJson.targets === "object"
            ? Object.keys(appJson.targets)
            : [];
        if (!targets.length) {
            return resolve({
                ok: false,
                code: "config_v1",
                msg: "该项目的 app.json 使用 Zepp OS 1.0 的 device.targets 配置，当前 zeus build 无法构建。请升级到 v2/v3 的 targets 配置，或去掉项目中的 import 语句后再导出。",
            });
        }
        const configVersion = String(appJson.configVersion || "").toLowerCase();
        const args = ["build"];
        if (configVersion !== "v3") args.push("-t", targets.join(","));

        const startedAt = Date.now();
        let log = "";
        const append = (buf) => {
            log += buf.toString();
            if (log.length > 40000) log = log.slice(-40000);
        };
        let child;
        try {
            // `spawn` with shell:true is required for the .cmd launcher on
            // Windows, and the command path must be quoted when npm lives
            // under "C:\Program Files".
            const launch = /\s/.test(zeusCmd) ? `"${zeusCmd}"` : zeusCmd;
            child = spawn(launch, args, {
                cwd: dir,
                windowsHide: true,
                shell: process.platform === "win32",
                env: Object.assign({}, process.env, { CI: "1", FORCE_COLOR: "0" }),
            });
        } catch (e) {
            return resolve({ ok: false, code: "build_failed", msg: "无法启动 zeus：" + (e.message || e), log });
        }
        const timer = setTimeout(() => {
            try { child.kill(); } catch (e) {}
        }, 5 * 60 * 1000);
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("error", (e) => {
            clearTimeout(timer);
            resolve({
                ok: false,
                code: "zeus_missing",
                msg: "无法启动 zeus：" + (e.message || e) + "。请先安装：npm i -g @zeppos/zeus-cli",
                log,
            });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                return resolve({ ok: false, code: "build_failed", msg: "zeus build 失败（退出码 " + code + "）", log });
            }
            const zab = newestZab(path.join(dir, "dist"), startedAt);
            if (!zab) {
                return resolve({
                    ok: false,
                    code: "build_failed",
                    msg: "zeus build 已完成，但没有在 dist 目录找到新的 .zab 安装包",
                    log,
                });
            }
            resolve({ ok: true, zabPath: zab.path, log });
        });
    });
}

/* ------------------------------------------------------------------ *
 * Zeus toolkit
 *
 * The desktop shell exposes the official `zeus` CLI instead of
 * re-implementing it. Three things are needed for that to feel native:
 *
 *  - the login state lives in `~/.zepp/.zeus` (dotenv, three keys), so a
 *    pasted browser cookie can be written there directly;
 *  - `zeus create` asks its questions on the terminal, so the answers are
 *    passed as flags (and the two prompts that cannot be skipped are fed
 *    through stdin);
 *  - long running commands stream their output, which is captured into a
 *    small job registry the renderer polls.
 * ------------------------------------------------------------------ */

const ZEUS_STORE_PATH = path.join(os.homedir(), ".zepp", ".zeus");
const ZEUS_LOGIN_PREFIX = "____user_zepp_com__";
/* Used when the pasted cookie carries no region host. */
const ZEUS_DEFAULT_CNAME = "api-mifit.huami.com";

function readZeusStore() {
    const out = {};
    let text = "";
    try {
        text = fs.readFileSync(ZEUS_STORE_PATH, "utf8");
    } catch (e) {
        return out;
    }
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.charAt(0) === "#") continue;
        const eq = line.indexOf("=");
        if (eq < 1) continue;
        out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
}

function writeZeusStore(store) {
    fs.mkdirSync(path.dirname(ZEUS_STORE_PATH), { recursive: true });
    const body = Object.keys(store).map((k) => `${k}=${store[k]}`).join("\n");
    fs.writeFileSync(ZEUS_STORE_PATH, body, "utf8");
}

function zeusLoginState() {
    const store = readZeusStore();
    const token = store[ZEUS_LOGIN_PREFIX + "token"] || "";
    const userId = store[ZEUS_LOGIN_PREFIX + "userid"] || "";
    const cname = store[ZEUS_LOGIN_PREFIX + "cname"] || "";
    return { loggedIn: !!(token && userId && cname), userId, cname, hasToken: !!token };
}

/* A pasted value is a `document.cookie` string, a JSON dump, or the redirect
 * URL the login page lands on; all are flattened to a lowercase name -> value
 * map. The URL form matters because `zeus login` receives apptoken/userid/
 * cname as query parameters rather than cookies. */
function parseCookieJar(raw) {
    const out = {};
    const text = String(raw || "").trim();
    if (!text) return out;
    const queryAt = text.indexOf("?");
    if (queryAt > -1) {
        for (const part of text.slice(queryAt + 1).split(/[&;]+/)) {
            const item = part.trim();
            const eq = item.indexOf("=");
            if (eq < 1) continue;
            let value = item.slice(eq + 1).trim();
            try {
                value = decodeURIComponent(value);
            } catch (e) {}
            out[item.slice(0, eq).trim().toLowerCase()] = value;
        }
        return out;
    }
    if (text.charAt(0) === "{") {
        try {
            const json = JSON.parse(text);
            for (const key of Object.keys(json)) {
                const value = json[key];
                if (value === null || typeof value === "object") continue;
                out[key.toLowerCase()] = String(value);
            }
            return out;
        } catch (e) {}
    }
    for (const part of text.split(/[;\n]+/)) {
        const item = part.trim();
        if (!item) continue;
        const eq = item.indexOf("=");
        if (eq < 1) continue;
        const name = item.slice(0, eq).trim().toLowerCase();
        let value = item.slice(eq + 1).trim();
        if (value.length > 1 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
            value = value.slice(1, -1);
        }
        try {
            value = decodeURIComponent(value);
        } catch (e) {}
        if (name) out[name] = value;
    }
    return out;
}

const COOKIE_TOKEN_KEYS = ["apptoken", "app_token", "token", "access_token", "zepp_token"];
const COOKIE_USER_KEYS = ["userid", "user_id", "uid", "user"];
const COOKIE_CNAME_KEYS = ["cname", "api_host", "subregionalhost", "sub_regional_host"];

function pickCookieValue(jar, keys) {
    for (const key of keys) {
        if (jar[key]) return jar[key];
    }
    return "";
}

function zeusLoginFromCookie(cookie, cnameOverride) {
    const jar = parseCookieJar(cookie);
    const token = pickCookieValue(jar, COOKIE_TOKEN_KEYS);
    const userId = pickCookieValue(jar, COOKIE_USER_KEYS);
    let cname = pickCookieValue(jar, COOKIE_CNAME_KEYS);
    const override = String(cnameOverride || "").trim();
    if (override) cname = override;
    if (!token) {
        return {
            ok: false,
            code: "token_missing",
            msg: "Cookie 中没有找到 apptoken。请从 user.zepp.com 复制完整的 Cookie（需包含 apptoken 字段）。",
        };
    }
    if (!userId) {
        return {
            ok: false,
            code: "userid_missing",
            msg: "Cookie 中没有找到 userid。请确认复制的是登录后的完整 Cookie。",
        };
    }
    if (!cname) cname = ZEUS_DEFAULT_CNAME;

    const store = readZeusStore();
    store[ZEUS_LOGIN_PREFIX + "token"] = token;
    store[ZEUS_LOGIN_PREFIX + "userid"] = userId;
    store[ZEUS_LOGIN_PREFIX + "cname"] = cname;
    writeZeusStore(store);
    return { ok: true, login: zeusLoginState() };
}

function zeusLogout() {
    const store = readZeusStore();
    let changed = false;
    for (const key of ["token", "userid", "cname", "account"]) {
        const full = ZEUS_LOGIN_PREFIX + key;
        if (Object.prototype.hasOwnProperty.call(store, full)) {
            delete store[full];
            changed = true;
        }
    }
    if (changed) writeZeusStore(store);
    return { ok: true, login: zeusLoginState() };
}

/* The installed zeus package, used to read the bundled template list. */
function zeusPackageDir() {
    const cmd = findZeusCommand();
    if (!cmd) return null;
    let dir = path.dirname(cmd);
    for (let i = 0; i < 4; i++) {
        const candidate = path.join(dir, "node_modules", "@zeppos", "zeus-cli");
        if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
        dir = path.dirname(dir);
    }
    return null;
}

function zeusVersion(pkgDir) {
    if (!pkgDir) return "";
    try {
        return String(JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version || "");
    } catch (e) {
        return "";
    }
}

/* `zeus create` shows template names produced by lodash.startCase. */
function startCaseName(dirName) {
    return String(dirName || "")
        .split(/[-_\s.]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

const ZEUS_TEMPLATE_FALLBACK = {
    app: {
        "1.0": ["Empty", "Calories", "Fetch Api", "Hello World", "Todo List"],
        "2.0": ["Empty", "Calories", "Fetch Api", "Hello World", "Showcase", "Todo List"],
        "3.0": ["Empty", "Calories", "Download", "Fetch Api", "Hello World", "Notification", "Todo List"],
        "4.0": ["Empty", "Calories", "Fetch Api", "Hello World", "Showcase", "Todo List"],
    },
    watchface: {
        "1.0": ["Empty", "Timer"],
        "2.0": ["Empty"],
    },
    workout_extension: {
        "3.5": ["Empty", "Running Pace Master"],
    },
};

const ZEUS_TYPE_DIR = {
    app: "app",
    watchface: "watchface",
    workout_extension: "workout-extension",
};

/* Which API levels each project type actually ships templates for. Anything
 * else would make `zeus create` fall back to an interactive picker. */
const ZEUS_TYPE_LEVELS = {
    app: ["1.0", "2.0", "3.0", "4.0"],
    watchface: ["1.0", "2.0"],
    workout_extension: ["3.5"],
};

const ZEUS_SHAPES = ["r", "s", "b"];

/* zeus keeps its device catalogue in ~/.zepp/.zeus_devices. `zeus create`
 * offers this list when an API 1.0/2.0 project is created, so the dialog needs
 * it to reproduce the official question.
 *
 * The target key is not the product name: getDeviceConf() groups the entries by
 * product, takes the shortest platform code as the device's internal name and
 * strips everything but letters ("Verona" -> "verona"). API 2.0 only offers the
 * targets whose platforms all belong to devices limited to OS 2.0. */
function zeusDevices() {
    const file = path.join(os.homedir(), ".zepp", ".zeus_devices");
    let list = [];
    try {
        const content = JSON.parse(fs.readFileSync(file, "utf8"));
        list = Array.isArray(content.devices) ? content.devices : [];
    } catch (e) {
        return [];
    }

    const shapeMap = {square: "s", round: "r", bar: "b"};
    const groups = new Map();
    for (const dev of list) {
        const name = String(dev.productName || "").trim();
        if (!name || !dev.code) continue;
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(dev);
    }

    const targets = [];
    const byKey = new Map();
    for (const [name, entries] of groups) {
        const inner = entries.reduce((acc, cur) => (cur.code.length < acc.length ? cur.code : acc), entries[0].code);
        const key = String(inner).toLowerCase().replace(/[^a-z]/g, "");
        if (!key) continue;
        const info = {
            key,
            name,
            shape: "r",
            width: 0,
            height: 0,
            platforms: [],
            apiMin: "1.0.0",
            apiMax: "",
        };
        for (const dev of entries) {
            const value = dev.value || {};
            const os = value.os || {};
            const shape = shapeMap[value.shape];
            if (shape) info.shape = shape;
            const size = String((value.screen && value.screen.size) || "").split("*");
            if (size[0] && size[1]) {
                info.width = Number(size[0]) || 0;
                info.height = Number(size[1]) || 0;
            }
            info.platforms.push({ deviceSource: dev.deviceSource });
            info.apiMin = os.apiLevelLimitMin || "1.0.0";
            info.apiMax = os.apiLevel || os.apiLevelLimitMax || "";
        }
        /* The CLI stores the groups in an object keyed by this name, so two
         * products that end up with the same key keep one row: the last one
         * wins and the row stays where it first appeared. */
        const prev = byKey.get(key);
        if (prev) {
            Object.assign(prev, info, { order: prev.order });
        } else {
            info.order = targets.length;
            byKey.set(key, info);
            targets.push(info);
        }
    }

    /* The OS 2.0 list offered by an API 2.0 project is built with
     * compareVersion(a, b) as "code(b) - code(a)", so the check reads
     * min <= 2.0.0 <= max: every device that still supports OS 2.0. */
    const cmp = (a, b) => {
        const pa = String(a).split(".").map(Number);
        const pb = String(b).split(".").map(Number);
        for (let i = 0; i < 3; i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d) return d > 0 ? 1 : -1;
        }
        return 0;
    };
    const osV2 = new Set();
    for (const t of targets) {
        if (!t.platforms.length) continue;
        if (cmp(t.apiMin || "1.0.0", "2.0.0") <= 0 && t.apiMax && cmp(t.apiMax, "2.0.0") >= 0) {
            for (const p of t.platforms) if (p.deviceSource !== undefined) osV2.add(p.deviceSource);
        }
    }

    const order = {r: 0, s: 1, b: 2};
    return targets.map((t) => ({
        key: t.key,
        name: t.name,
        shape: t.shape,
        width: t.width,
        height: t.height,
        order: t.order,
        osV2: t.platforms.length > 0 && t.platforms.every((p) => osV2.has(p.deviceSource)),
    })).sort((a, b) => {
        const oa = order[a.shape] === undefined ? 9 : order[a.shape];
        const ob = order[b.shape] === undefined ? 9 : order[b.shape];
        return oa - ob || a.name.localeCompare(b.name);
    });
}

function zeusTemplateList(appType, apiLevel) {
    const type = ZEUS_TYPE_DIR[appType] ? appType : "app";
    const level = String(apiLevel || "3.0");
    const pkgDir = zeusPackageDir();
    if (pkgDir) {
        const dir = path.join(pkgDir, "private-modules", "zeppos-app-utils", "dist",
            "public", "template", "os" + level, ZEUS_TYPE_DIR[type]);
        try {
            const names = fs.readdirSync(dir, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => startCaseName(e.name))
                .sort((a, b) => a.localeCompare(b));
            if (names.length) {
                const empty = names.filter((n) => n === "Empty");
                const rest = names.filter((n) => n !== "Empty");
                return empty.concat(rest);
            }
        } catch (e) {}
    }
    const fallback = ZEUS_TEMPLATE_FALLBACK[type] || {};
    return (fallback[level] || []).slice();
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const zeusJobs = new Map();
let zeusJobSeq = 0;

function pushZeusLog(job, text) {
    const clean = String(text).replace(ANSI_RE, "");
    for (const line of clean.split(/\r?\n/)) {
        if (!line.trim()) continue;
        job.lines.push(line.replace(/\s+$/, ""));
    }
    if (job.lines.length > 600) job.lines.splice(0, job.lines.length - 600);
}

function startZeusJob(opts) {
    const zeus = findZeusCommand();
    if (!zeus) {
        return {
            ok: false,
            code: "zeus_missing",
            msg: "未找到 zeus 命令，请先安装：npm i -g @zeppos/zeus-cli",
        };
    }
    if (!opts.cwd || !fs.existsSync(opts.cwd)) {
        return { ok: false, msg: "项目目录不存在" };
    }
    const id = "zj" + (++zeusJobSeq);
    const job = {
        id,
        lines: [],
        running: true,
        code: null,
        error: "",
        cwd: opts.cwd,
        action: opts.action,
        startedAt: Date.now(),
        child: null,
        timer: null,
    };
    zeusJobs.set(id, job);
    if (zeusJobs.size > 12) {
        for (const [key, value] of zeusJobs) {
            if (!value.running && zeusJobs.size > 8) zeusJobs.delete(key);
        }
    }

    const launch = /\s/.test(zeus) ? `"${zeus}"` : zeus;
    /* A command that asks questions is answered by watching its output: each
     * step is typed once the prompt it belongs to shows up. Guessing delays
     * does not work because the device cache refresh before `create` can take
     * anywhere from one to twenty seconds. */
    const steps = Array.isArray(opts.stdinSteps) ? opts.stdinSteps.slice() : [];
    const wantsInput = steps.length > 0;
    // shell:true concatenates argv without quoting on Windows, so an argument
    // with a space (a project name) would be split into two.
    const args = process.platform === "win32"
        ? opts.args.map((a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a))
        : opts.args;
    try {
        job.child = spawn(launch, args, {
            cwd: opts.cwd,
            windowsHide: true,
            shell: process.platform === "win32",
            // Commands that ask a question we cannot answer get EOF on stdin,
            // which makes inquirer accept the highlighted default instead of
            // waiting forever on an open pipe.
            stdio: [wantsInput ? "pipe" : "ignore", "pipe", "pipe"],
            env: Object.assign({}, process.env, { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" }),
        });
    } catch (e) {
        job.running = false;
        job.code = -1;
        job.error = "无法启动 zeus：" + (e.message || e);
        return { ok: false, msg: job.error };
    }

    if (wantsInput) {
        let tail = "";
        let closing = false;
        const closeInput = () => {
            if (closing) return;
            closing = true;
            try { job.child.stdin.end(); } catch (e) {}
        };
        const typeStep = (step) => {
            if (!job.running || closing) return;
            try { job.child.stdin.write(step.text); } catch (e) {}
            /* stdin is only closed once every answer has been typed; ending it
             * while inquirer still waits for one makes the next prompt throw
             * ERR_USE_AFTER_CLOSE and aborts the command. */
            if (!steps.length) setTimeout(closeInput, 3000);
        };
        job.child.stdout.on("data", (buf) => {
            tail = (tail + buf.toString().replace(ANSI_RE, "")).slice(-4000);
            while (steps.length && tail.indexOf(steps[0].expect) > -1) {
                const step = steps.shift();
                setTimeout(() => typeStep(step), step.delay || 300);
            }
        });
    }

    job.child.stdout.on("data", (buf) => pushZeusLog(job, buf.toString()));
    job.child.stderr.on("data", (buf) => pushZeusLog(job, buf.toString()));
    job.child.on("error", (e) => {
        job.running = false;
        job.code = -1;
        job.error = "无法启动 zeus：" + (e.message || e);
        pushZeusLog(job, job.error);
    });
    job.child.on("close", (code) => {
        job.running = false;
        job.code = code;
        if (job.timer) clearTimeout(job.timer);
        if (typeof opts.onDone === "function") {
            try { opts.onDone(job); } catch (e) {}
        }
    });

    const limit = opts.timeout || 10 * 60 * 1000;
    if (limit > 0) {
        job.timer = setTimeout(() => {
            if (!job.running) return;
            pushZeusLog(job, "操作超时，已停止。");
            try { job.child.kill(); } catch (e) {}
        }, limit);
    }
    return { ok: true, jobId: id };
}

/* `zeus create` matches `--template` against the display name produced by
 * lodash.startCase, except that the app and workout-extension prompts map
 * "Hello World" to "Hello_World" before comparing. */
function zeusCreateTemplateArg(appType, template) {
    if ((appType === "app" || appType === "workout_extension") && template === "Hello World") {
        return "Hello_World";
    }
    return template;
}

/* The questions that do have a flag are passed on the command line: the app
 * type, the API level and the template. The platform question differs by API
 * level: 3.0 and above asks for screen shapes and accepts `--shape`, while API
 * 1.0/2.0 asks which devices to build for and has no flag at all. */
function zeusCreateArgs(opts) {
    const args = [
        "create", opts.name,
        "--apptype=" + opts.appType,
        "--apilevel=" + opts.apiLevel,
        "--template=" + opts.template,
    ];
    if (opts.shapes && opts.shapes.length) {
        args.push("--shape=" + opts.shapes.join(","));
    }
    if (opts.withAppSide) args.push("--withappside=true");
    if (opts.withSettings) args.push("--withsettings=true");
    return args;
}

/* `zeus create` still asks up to two questions of its own when the Empty
 * template is used: whether the app has an app-side component (and, when it
 * has one, whether it also gets a settings component), plus which devices to
 * build for in an API 1.0/2.0 project (no flag at all - yargs rejects unknown
 * options, so that checkbox has to be driven with the keyboard). Answers are
 * typed into stdin as soon as the prompt text appears on stdout. */
function buildCreateAnswers(opts) {
    if (opts.appType !== "app" || opts.template !== "Empty") return [];
    const steps = [];
    /* A "yes" can be passed as a flag, so only a negative answer is left to
     * type - and only one of the two confirms can still be pending. */
    if (!opts.withAppSide) {
        // A confirm prompt resolves on the newline, not on the letter alone.
        steps.push({expect: "app-side component", text: "n\r", delay: 300});
    } else if (!opts.withSettings) {
        steps.push({expect: "settings component", text: "n\r", delay: 300});
    }
    if (opts.deviceKeys) {
        steps.push({expect: "Which platforms of this application", text: opts.deviceKeys, delay: 500});
    }
    return steps;
}

/* The checkbox opens on the first row with the first device already ticked,
 * so rows are walked with the down arrow and every row whose state has to
 * change is toggled with a space before the list is submitted. */
function deviceCheckboxKeys(count, picks) {
    let keys = "";
    for (let i = 0; i < count; i++) {
        if (i > 0) keys += "\u001b[B";
        if ((picks.indexOf(i) > -1) !== (i === 0)) keys += " ";
    }
    return keys + "\r";
}

function startZeusCreate(body) {
    const projectsDir = getProjectsDir();
    const rawName = String(body.name || "").trim();
    if (!rawName) return { ok: false, msg: "请填写项目名称" };
    const safeName = rawName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/\s+/g, "-").replace(/^\.+/, "").trim();
    if (!safeName) return { ok: false, msg: "项目名称不合法" };
    const name = uniqueDirName(projectsDir, safeName);

    const appType = ZEUS_TYPE_DIR[body.appType] ? body.appType : "app";
    const levels = ZEUS_TYPE_LEVELS[appType];
    let apiLevel = String(body.apiLevel || "");
    if (levels.indexOf(apiLevel) < 0) apiLevel = levels[levels.length - 1];

    let template = String(body.template || "Empty");
    const available = zeusTemplateList(appType, apiLevel);
    if (available.length && available.indexOf(template) < 0) template = available[0];

    /* Mirror the official questions: only an Empty app project asks anything
     * about platforms, and the question depends on the API level. */
    const asksPlatform = appType === "app" && template === "Empty";

    let shapes = [];
    let deviceKeys = "";
    if (asksPlatform && parseFloat(apiLevel) <= 2) {
        /* The keystrokes follow the row order of the CLI list, which is the
         * catalogue order (`order`), not the grouped display order. An API 2.0
         * project only offers the devices that still support OS 2.0. */
        const all = zeusDevices().slice().sort((a, b) => a.order - b.order);
        const choices = apiLevel === "2.0" ? all.filter((d) => d.osV2) : all;
        if (choices.length) {
            const picked = Array.isArray(body.devices) ? body.devices : [];
            const indices = [];
            choices.forEach((d, i) => {
                if (picked.indexOf(d.key) > -1) indices.push(i);
            });
            if (!indices.length) indices.push(0);
            deviceKeys = deviceCheckboxKeys(choices.length, indices);
        }
    } else if (asksPlatform && parseFloat(apiLevel) > 2) {
        shapes = Array.isArray(body.shapes) ? body.shapes.filter((s) => ZEUS_SHAPES.indexOf(s) > -1) : [];
        if (!shapes.length) shapes = ["r"];
    }

    const withAppSide = appType === "app" && !!body.withAppSide;
    const withSettings = withAppSide && !!body.withSettings;

    const opts = {
        name,
        appType,
        apiLevel,
        template: zeusCreateTemplateArg(appType, template),
        shapes,
        withAppSide,
        withSettings,
    };

    const started = startZeusJob({
        action: "create",
        cwd: projectsDir,
        args: zeusCreateArgs(opts),
        stdinSteps: buildCreateAnswers({
            appType,
            template,
            withAppSide,
            withSettings,
            deviceKeys,
        }),
        timeout: 15 * 60 * 1000,
    });
    if (!started.ok) return started;
    return {
        ok: true,
        jobId: started.jobId,
        name,
        path: path.join(projectsDir, name),
        template,
        apiLevel,
    };
}

function startZeusProjectJob(body) {
    const action = String(body.action || "");
    const table = {
        prune: { args: ["prune"], timeout: 5 * 60 * 1000 },
        status: { args: ["status"], timeout: 2 * 60 * 1000, global: true },
        config: { args: ["config", "list"], timeout: 2 * 60 * 1000, global: true },
        "cache-update": { args: ["cache", "update"], timeout: 5 * 60 * 1000, global: true },
        "cache-clean": { args: ["cache", "clean"], timeout: 2 * 60 * 1000, global: true },
        preview: { args: ["preview"], timeout: 10 * 60 * 1000 },
        bridge: { args: ["bridge"], timeout: 0 },
    };
    const spec = table[action];
    if (!spec) return { ok: false, msg: "不支持的 zeus 操作：" + action };
    /* status / config / cache do not read the project, so they must work even
     * when no project is selected. */
    const dir = spec.global ? getProjectsDir() : resolveProjectDir(body.projectUrl);
    if (!dir) return { ok: false, msg: "找不到项目目录" };
    if ((action === "preview" || action === "bridge") && !zeusLoginState().loggedIn) {
        return {
            ok: false,
            code: "login_required",
            msg: "该操作需要华米账号，请先在「设置 → 华米账号」中粘贴 Cookie 登录。",
        };
    }
    const started = startZeusJob({
        action,
        cwd: dir,
        args: spec.args,
        timeout: spec.timeout,
    });
    if (!started.ok) return started;
    return { ok: true, jobId: started.jobId, name: path.basename(dir) };
}

/* Zip the project *contents* (app.json at the archive root), which is the
 * layout device installers expect for a `.bin` package. bsdtar is preferred
 * because PowerShell's Compress-Archive writes backslash separators, which
 * some installers refuse to read. */
function zipProjectContents(srcDir, zipPath) {
    return new Promise((resolve) => {
        let entries;
        try {
            entries = fs.readdirSync(srcDir);
        } catch (e) {
            return resolve(e.message || String(e));
        }
        if (!entries.length) return resolve("项目目录为空");
        execFile("tar", ["-a", "-cf", zipPath, "-C", srcDir, "--", ...entries],
            { windowsHide: true }, (err) => {
                if (!err) return resolve(null);
                const esc = (s) => String(s).replace(/'/g, "''");
                const cmd = `Compress-Archive -Path '${esc(path.join(srcDir, "*"))}' -DestinationPath '${esc(zipPath)}' -Force`;
                execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd],
                    { windowsHide: true }, (err2) => {
                        resolve(err2 ? (err2.message || String(err2)) : null);
                    });
            });
    });
}

function bumpChangeCount() {
    changeSeq++;
}

/* Ignore file events caused by the app's own writes (code editor save),
 * the editor already restarts the player itself. */
let selfWriteUntil = 0;

function startProjectWatch(name) {
    if (projectWatcher) {
        try { projectWatcher.close(); } catch (e) {}
        projectWatcher = null;
    }
    const rootName = String(name || "").split(/[/\\]/)[0];
    const dir = rootName ? resolveProjectDir("/projects/" + rootName) : null;
    if (!dir) return;
    try {
        projectWatcher = fs.watch(dir, { recursive: true }, () => {
            if (Date.now() < selfWriteUntil) return;
            if (changeTimer) return;
            changeTimer = setTimeout(() => {
                changeTimer = null;
                bumpChangeCount();
            }, 300);
        });
        projectWatcher.on("error", (e) => console.warn("Project watcher error", e));
    } catch (e) {
        console.warn("Cannot watch project", e);
    }
}

function readJsonBody(req, res, cb) {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (c) => {
        if (failed) return;
        size += c.length;
        if (size > 8 * 1024 * 1024) {
            failed = true;
            sendJson(res, { ok: false, msg: "请求体过大" }, 413);
            req.destroy();
            return;
        }
        chunks.push(c);
    });
    req.on("end", () => {
        if (failed) return;
        let body = {};
        try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch (e) {
            return sendJson(res, { ok: false, msg: "无效的 JSON" }, 400);
        }
        cb(body);
    });
}

function listDrives() {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ":\\";
        try {
            if (fs.existsSync(d)) drives.push(d);
        } catch (e) {}
    }
    return drives;
}

/* App-side fetch proxy. ZeppOS companion services are not subject to the
 * browser's CORS rules, so requests from the app-side runtime go through the
 * main process instead of the page's window.fetch. */
function proxyForward(target, options, redirectsLeft, resolve, reject) {
    let parsed;
    try { parsed = new URL(target); } catch (e) { return reject(new Error("Invalid URL: " + target)); }
    const lib = parsed.protocol === "https:" ? require("https") : require("http");
    const headers = Object.assign({}, options.headers || {});
    for (const key of ["host", "origin", "referer", "content-length", "connection", "accept-encoding"]) {
        delete headers[key];
    }
    const request = lib.request(parsed, { method: options.method || "GET", headers }, (upstream) => {
        const status = upstream.statusCode || 0;
        if (status >= 300 && status < 400 && upstream.headers.location && redirectsLeft > 0) {
            upstream.resume();
            const next = new URL(upstream.headers.location, parsed).toString();
            return proxyForward(next, options, redirectsLeft - 1, resolve, reject);
        }
        const chunks = [];
        upstream.on("data", (c) => chunks.push(c));
        upstream.on("end", () => {
            const buffer = Buffer.concat(chunks);
            const type = String(upstream.headers["content-type"] || "");
            const textual = !type || /json|text|javascript|xml|x-www-form-urlencoded|charset/i.test(type);
            resolve({
                url: target,
                status,
                statusText: upstream.statusMessage || "",
                headers: upstream.headers,
                body: textual ? buffer.toString("utf8") : null,
                base64: textual ? null : buffer.toString("base64"),
                text: textual,
            });
        });
    });
    request.setTimeout(30000, () => request.destroy(new Error("Proxy request timed out")));
    request.on("error", reject);
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
}

function handleProxy(req, res) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
        let payload = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) {}
        const url = String(payload.url || "");
        if (!/^https?:\/\//i.test(url)) {
            return sendJson(res, { ok: false, msg: "Unsupported URL: " + url }, 400);
        }
        const options = {
            method: payload.method || "GET",
            headers: payload.headers || {},
            body: payload.body,
        };
        proxyForward(url, options, 3, (data) => {
            sendJson(res, Object.assign({ ok: true }, data));
        }, (err) => {
            sendJson(res, { ok: false, msg: String((err && err.message) || err) }, 502);
        });
    });
}

function handleApi(req, res, pathname) {
    const q = url.parse(req.url, true).query;

    if (pathname === "/api/proxy") {
        handleProxy(req, res);
        return;
    }

    if (pathname === "/api/list_projects") {
        const projectsDir = getProjectsDir();
        const preferBuild = q.preferBuildDir === "true";
        const out = [];
        for (const name of fs.readdirSync(projectsDir).sort()) {
            const p = path.join(projectsDir, name);
            let isDir = false;
            try { isDir = fs.statSync(p).isDirectory(); } catch (e) {}
            if (!isDir || !fs.existsSync(path.join(p, "app.json"))) continue;
            let loadUrl = `/projects/${name}`;
            if (preferBuild && fs.existsSync(path.join(p, "build", "app.json"))) {
                loadUrl = `/projects/${name}/build`;
            }
            out.push({ title: name, url: loadUrl });
        }
        return sendJson(res, out);
    }

    if (pathname === "/api/open_projects") {
        const dir = getProjectsDir();
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
        shell.openPath(dir).then((err) => {
            sendJson(res, { ok: !err, path: dir, msg: err || "" });
        }).catch((e) => {
            sendJson(res, { ok: false, path: dir, msg: String(e && e.message || e) });
        });
        return;
    }

    if (pathname === "/api/import_project") {
        handleImportProject().then((r) => sendJson(res, r)).catch((e) => {
            sendJson(res, { ok: false, msg: String(e && e.message || e) });
        });
        return;
    }

    if (pathname === "/api/choose_projects_dir") {
        const win = BrowserWindow.getAllWindows()[0];
        dialog.showOpenDialog(win || undefined, {
            title: "选择项目文件夹 / Select projects folder",
            properties: ["openDirectory", "createDirectory"],
        }).then((r) => {
            if (r.canceled || !r.filePaths.length) {
                return sendJson(res, { ok: false, cancelled: true });
            }
            const dir = r.filePaths[0];
            if (!isWritableDir(dir)) {
                return sendJson(res, { ok: false, msg: "该文件夹不可写：" + dir });
            }
            writeConfig({ projectsPath: dir });
            projectDir = dir;
            sendJson(res, { ok: true, path: dir });
        }).catch((e) => sendJson(res, { ok: false, msg: String(e && e.message || e) }));
        return;
    }

    if (pathname === "/api/save_preview") {
        if (req.method !== "POST") {
            return sendJson(res, { ok: false, msg: "Method not allowed" }, 405);
        }
        const MAX_BODY = 64 * 1024 * 1024;
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on("data", (c) => {
            if (tooLarge) return;
            size += c.length;
            if (size > MAX_BODY) {
                tooLarge = true;
                res.statusCode = 413;
                sendJson(res, { ok: false, msg: "图片过大" }, 413);
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            if (tooLarge) return;
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                const match = /^data:(image|video)\/(png|gif|mp4|webm);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.dataUrl || ""));
                if (!match) return sendJson(res, { ok: false, msg: "无效的媒体数据" }, 400);
                const isVideo = match[1] === "video";
                let dir = isVideo ? getVideoDir() : getScreenshotDir();
                if (String(body.dest || "") === "project") {
                    dir = resolveProjectDir(body.projectUrl) || dir;
                }
                fs.mkdirSync(dir, { recursive: true });
                const ext = "." + match[2];
                const name = sanitizeMediaName(body.name, ext)
                    || `preview_${Date.now()}${ext}`;
                const dest = uniqueFilePath(dir, name);
                fs.writeFileSync(dest, Buffer.from(match[3], "base64"));
                sendJson(res, { ok: true, path: dest });
            } catch (e) {
                sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500);
            }
        });
        return;
    }

    if (pathname === "/api/save_text") {
        if (req.method !== "POST") {
            return sendJson(res, { ok: false, msg: "Method not allowed" }, 405);
        }
        return readJsonBody(req, res, (body) => {
            try {
                const dir = getTextExportDir();
                fs.mkdirSync(dir, { recursive: true });
                const name = sanitizeFileName(body.name, ".log") || `log_${Date.now()}.log`;
                const dest = uniqueFilePath(dir, name);
                fs.writeFileSync(dest, String(body.text == null ? "" : body.text), "utf8");
                sendJson(res, { ok: true, path: dest });
            } catch (e) {
                sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500);
            }
        });
    }

    if (pathname === "/api/export_project") {
        if (req.method !== "POST") {
            return sendJson(res, { ok: false, msg: "Method not allowed" }, 405);
        }
        return readJsonBody(req, res, (body) => {
            const dir = resolveProjectDir(body.projectUrl);
            if (!dir) return sendJson(res, { ok: false, msg: "找不到项目目录" }, 404);
            const win = BrowserWindow.getAllWindows()[0];
            const base = path.basename(dir);
            const esmFiles = scanEsmImports(dir);
            const needsBuild = esmFiles.length > 0;

            // Used by the plain-browser export path, which cannot open a native
            // save dialog but still has to know whether a build is required.
            if (body.probe) {
                return sendJson(res, { ok: true, needsBuild, imports: esmFiles });
            }

            if (needsBuild) {
                const zeus = findZeusCommand();
                if (!zeus) {
                    return sendJson(res, {
                        ok: false,
                        code: "zeus_missing",
                        needsBuild: true,
                        imports: esmFiles,
                        msg: "检测到 import 语句，需要 zeus build 构建安装包，但未找到 zeus 命令。请先执行：npm i -g @zeppos/zeus-cli",
                    }, 400);
                }
                dialog.showSaveDialog(win || undefined, {
                    title: "构建并导出安装包 / Build and export package",
                    defaultPath: path.join(app.getPath("documents"), `${base}.zab`),
                    filters: [{ name: "ZAB 安装包", extensions: ["zab"] }],
                }).then(async (r) => {
                    if (r.canceled || !r.filePath) {
                        return sendJson(res, { ok: false, cancelled: true });
                    }
                    let zabPath = r.filePath;
                    if (!path.extname(zabPath)) zabPath += ".zab";
                    const build = await runZeusBuild(dir, zeus);
                    if (!build.ok) {
                        return sendJson(res, {
                            ok: false,
                            code: build.code || "build_failed",
                            needsBuild: true,
                            imports: esmFiles,
                            msg: build.msg,
                            log: String(build.log || "").slice(-4000),
                        }, 500);
                    }
                    try {
                        fs.copyFileSync(build.zabPath, zabPath);
                    } catch (e) {
                        return sendJson(res, { ok: false, msg: "复制安装包失败：" + (e.message || e) }, 500);
                    }
                    sendJson(res, {
                        ok: true,
                        path: zabPath,
                        mode: "zeus",
                        imports: esmFiles,
                        package: path.basename(build.zabPath),
                    });
                }).catch((e) => sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500));
                return;
            }

            dialog.showSaveDialog(win || undefined, {
                title: "导出项目 / Export project",
                defaultPath: path.join(app.getPath("documents"), `${base}.bin`),
                filters: [{ name: "BIN 安装包", extensions: ["bin"] }],
            }).then(async (r) => {
                if (r.canceled || !r.filePath) {
                    return sendJson(res, { ok: false, cancelled: true });
                }
                let binPath = r.filePath;
                if (!/\.bin$/i.test(binPath)) {
                    binPath = binPath.replace(/\.[^./\\]*$/, "") + ".bin";
                }
                // tar/Compress-Archive pick the archive format from the file
                // extension, so build the zip first and rename it afterwards.
                const tmpZip = path.join(os.tmpdir(), `zp_export_${Date.now()}_${Math.random().toString(36).slice(2)}.zip`);
                const err = await zipProjectContents(dir, tmpZip);
                if (err) return sendJson(res, { ok: false, msg: "打包失败：" + err }, 500);
                try {
                    fs.copyFileSync(tmpZip, binPath);
                } catch (e) {
                    return sendJson(res, { ok: false, msg: "写入文件失败：" + (e.message || e) }, 500);
                } finally {
                    fs.rm(tmpZip, { force: true }, () => {});
                }
                sendJson(res, { ok: true, path: binPath, mode: "zip" });
            }).catch((e) => sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500));
        });
    }

    if (pathname === "/api/zeus/info") {
        const pkgDir = zeusPackageDir();
        return sendJson(res, {
            ok: true,
            installed: !!findZeusCommand(),
            version: zeusVersion(pkgDir),
            login: zeusLoginState(),
            types: ZEUS_TYPE_LEVELS,
            shapes: ZEUS_SHAPES,
            devices: zeusDevices(),
        });
    }

    if (pathname === "/api/zeus/login") {
        if (req.method !== "POST") {
            return sendJson(res, { ok: false, msg: "Method not allowed" }, 405);
        }
        return readJsonBody(req, res, (body) => {
            try {
                sendJson(res, zeusLoginFromCookie(body.cookie, body.cname));
            } catch (e) {
                sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500);
            }
        });
    }

    if (pathname === "/api/zeus/logout") {
        if (req.method !== "POST") {
            return sendJson(res, { ok: false, msg: "Method not allowed" }, 405);
        }
        try {
            sendJson(res, zeusLogout());
        } catch (e) {
            sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500);
        }
        return;
    }

    if (pathname === "/api/zeus/templates") {
        return sendJson(res, {
            ok: true,
            templates: zeusTemplateList(String(q.appType || "app"), String(q.apiLevel || "3.0")),
        });
    }

    if (pathname === "/api/zeus/run") {
        if (req.method !== "POST") {
            return sendJson(res, { ok: false, msg: "Method not allowed" }, 405);
        }
        return readJsonBody(req, res, (body) => {
            try {
                const action = String(body.action || "");
                const result = action === "create" ? startZeusCreate(body) : startZeusProjectJob(body);
                sendJson(res, result, result.ok ? 200 : 400);
            } catch (e) {
                sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500);
            }
        });
    }

    if (pathname === "/api/zeus/job") {
        const job = zeusJobs.get(String(q.id || ""));
        if (!job) return sendJson(res, { ok: false, msg: "任务不存在" }, 404);
        let from = parseInt(q.from, 10);
        if (!(from >= 0)) from = 0;
        if (from > job.lines.length) from = 0;
        return sendJson(res, {
            ok: true,
            running: job.running,
            code: job.code,
            error: job.error,
            action: job.action,
            lines: job.lines.slice(from),
            next: job.lines.length,
        });
    }

    if (pathname === "/api/zeus/stop") {
        if (req.method !== "POST") {
            return sendJson(res, { ok: false, msg: "Method not allowed" }, 405);
        }
        return readJsonBody(req, res, (body) => {
            const job = zeusJobs.get(String(body.id || ""));
            if (!job) return sendJson(res, { ok: false, msg: "任务不存在" }, 404);
            try {
                if (job.child) job.child.kill();
            } catch (e) {}
            sendJson(res, { ok: true });
        });
    }

    if (pathname === "/api/import_path") {
        if (req.method !== "POST") {
            return sendJson(res, { ok: false, msg: "Method not allowed" }, 405);
        }
        return readJsonBody(req, res, (body) => {
            importProjectFromPath(String(body.path || "")).then((r) => {
                sendJson(res, r);
            }).catch((e) => {
                sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500);
            });
        });
    }

    if (pathname === "/api/import_zip_upload") {
        if (req.method !== "POST") {
            return sendJson(res, { ok: false, msg: "Method not allowed" }, 405);
        }
        const MAX_UPLOAD = 256 * 1024 * 1024;
        let displayBase = "";
        try {
            displayBase = decodeURIComponent(req.headers["x-file-name"] || "");
        } catch (e) {}
        displayBase = displayBase.replace(/\.zip$/i, "");

        const tmpZip = path.join(os.tmpdir(), `zp_upload_${Date.now()}_${Math.random().toString(36).slice(2)}.zip`);
        const out = fs.createWriteStream(tmpZip);
        let size = 0;
        let aborted = false;
        const cleanup = () => fs.rm(tmpZip, { force: true }, () => {});

        req.on("data", (c) => {
            if (aborted) return;
            size += c.length;
            if (size > MAX_UPLOAD) {
                aborted = true;
                out.destroy();
                cleanup();
                sendJson(res, { ok: false, msg: "压缩包过大" }, 413);
                req.destroy();
            }
        });
        out.on("error", (e) => {
            if (aborted) return;
            aborted = true;
            cleanup();
            sendJson(res, { ok: false, msg: "写入失败：" + (e.message || e) }, 500);
        });
        out.on("finish", () => {
            if (aborted) return;
            importProjectFromPath(tmpZip, displayBase).then((r) => {
                sendJson(res, r);
            }).catch((e) => {
                sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500);
            }).finally(cleanup);
        });
        req.pipe(out);
        return;
    }

    if (pathname === "/api/delete_project") {
        if (req.method !== "POST") {
            return sendJson(res, { ok: false, msg: "Method not allowed" }, 405);
        }
        return readJsonBody(req, res, (body) => {
            const dir = resolveProjectDir(body.projectUrl);
            if (!dir) return sendJson(res, { ok: false, msg: "找不到项目目录" }, 404);
            // The watcher keeps a handle on the tree; release it before deleting.
            if (projectWatcher) {
                try { projectWatcher.close(); } catch (e) {}
                projectWatcher = null;
            }
            try {
                fs.rmSync(dir, { recursive: true, force: true });
                sendJson(res, { ok: true });
            } catch (e) {
                sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500);
            }
        });
    }

    if (pathname === "/api/download_project") {
        const dir = resolveProjectDir(q.projectUrl);
        if (!dir) return sendJson(res, { ok: false, msg: "找不到项目目录" }, 404);

        const base = path.basename(dir);
        const asBin = q.format === "bin";
        const ext = asBin ? "bin" : "zip";
        const tmpZip = path.join(os.tmpdir(), `zp_export_${Date.now()}_${Math.random().toString(36).slice(2)}.zip`);
        const cleanup = () => fs.rm(tmpZip, { force: true }, () => {});

        // `format=bin` is the device-installer layout: app.json at the archive
        // root, still a plain zip behind the extension.
        (asBin ? zipProjectContents(dir, tmpZip) : zipDirectory(dir, tmpZip)).then((err) => {
            if (err) {
                cleanup();
                return sendJson(res, { ok: false, msg: "打包失败：" + err }, 500);
            }
            const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
            res.setHeader("Content-Type", "application/zip");
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            res.setHeader("Content-Disposition",
                `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(base)}.${ext}`);
            const stream = fs.createReadStream(tmpZip);
            stream.on("error", () => {
                cleanup();
                if (!res.headersSent) {
                    res.statusCode = 500;
                    send(res, "Read failed");
                } else {
                    res.destroy();
                }
            });
            stream.on("close", cleanup);
            stream.pipe(res);
        }).catch((e) => {
            cleanup();
            sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500);
        });
        return;
    }

    if (pathname === "/api/server_info") {
        return sendJson(res, {
            ok: true,
            port: PORT,
            desktop: true,
            urls: lanUrls(),
        });
    }

    if (pathname === "/api/change_count") {
        return send(res, String(changeSeq));
    }

    if (pathname.startsWith("/api/watch/")) {
        startProjectWatch(decodeURIComponent(pathname.slice("/api/watch/".length)));
        return send(res, String(changeSeq));
    }

    if (pathname === "/api/folder_chooser/" || pathname.startsWith("/api/folder_chooser/")) {
        const sub = pathname.slice("/api/folder_chooser/".length);
        if (!sub) {
            return sendJson(res, { current_path: "", contents: listDrives() });
        }
        const dir = normalizeFsPath(sub);
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            return sendJson(res, { current_path: "", contents: listDrives() });
        }
        return sendJson(res, { current_path: dir, contents: listDir(dir) });
    }

    if (pathname.startsWith("/api/set_projects_dir/")) {
        const sub = pathname.slice("/api/set_projects_dir/".length);
        const dir = normalizeFsPath(sub);
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            return sendJson(res, { ok: false, msg: "目录不存在：" + (dir || sub) }, 400);
        }
        if (!isWritableDir(dir)) {
            return sendJson(res, { ok: false, msg: "目录不可写：" + dir }, 403);
        }
        writeConfig({ projectsPath: dir });
        projectDir = dir;
        return send(res, "true");
    }

    res.statusCode = 404;
    return send(res, "Not found");
}

function handleProjects(req, res, pathname) {
    const projectsDir = getProjectsDir();
    // strip /projects prefix, guard against traversal
    const rel = pathname.slice("/projects".length).replace(/^[/\\]+/, "");
    const abs = path.resolve(projectsDir, rel);
    if (abs !== path.resolve(projectsDir) && !abs.startsWith(path.resolve(projectsDir) + path.sep)) {
        res.statusCode = 403;
        return send(res, "Forbidden");
    }

    if (req.method === "PUT") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("error", (e) => {
            res.statusCode = 400;
            send(res, String(e && e.message || e));
        });
        req.on("end", () => {
            try {
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                fs.writeFileSync(abs, Buffer.concat(chunks));
                // Our own write must not fire the auto-restart watcher; the
                // editor restarts the player explicitly after saving.
                selfWriteUntil = Date.now() + 1500;
                send(res, "");
            } catch (e) {
                res.statusCode = 500;
                sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500);
            }
        });
        return;
    }

    fs.stat(abs, (err, st) => {
        if (err) {
            res.statusCode = 404;
            return send(res, "Not found");
        }
        if (st.isDirectory()) {
            const links = fs.readdirSync(abs).map((f) => {
                const full = path.join(abs, f);
                let suffix = "";
                try { suffix = fs.statSync(full).isDirectory() ? "/" : ""; } catch (e) {}
                return `<a href="${f}${suffix}">${f}${suffix}</a>\n`;
            }).join("");
            return send(res, `<!DOCTYPE html><html><body>${links}</body></html>`, "text/html; charset=utf-8");
        }
        sendFile(res, abs);
    });
}

const server = http.createServer((req, res) => {
    try {
        const pathname = decodeURIComponent(url.parse(req.url).pathname);

        if (pathname.startsWith("/api/")) return handleApi(req, res, pathname);
        if (pathname.startsWith("/projects")) return handleProjects(req, res, pathname);
        if (pathname === "/package.json" || pathname === "/package.json/") {
            return sendFile(res, path.join(ROOT_DIR, "package.json"));
        }

        // static app assets
        // Front-end references every asset as "/app/<file>". Strip that prefix so
        // it maps to the app/ directory instead of nesting app/app/.
        let rel = pathname === "/" || pathname === "/app" ? "index.html" : pathname.replace(/^\/+/, "");
        if (rel.startsWith("app/")) rel = rel.slice(4);
        const abs = path.resolve(APP_DIR, rel);
        if (!abs.startsWith(path.resolve(APP_DIR) + path.sep) && abs !== path.resolve(APP_DIR, "index.html")) {
            res.statusCode = 403;
            return send(res, "Forbidden");
        }
        sendFile(res, abs);
    } catch (e) {
        console.error("Request failed", e);
        res.statusCode = 500;
        send(res, String(e && e.message || e));
    }
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1180,
        height: 820,
        icon: path.join(ROOT_DIR, "assets", "icon.ico"),
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(ROOT_DIR, "preload.js"),
            // Recording keeps drawing the composited frame; throttling would
            // freeze the clip as soon as the window is covered by another app.
            backgroundThrottling: false,
        },
    });
    /* Keyboard shortcuts must survive an active IME: while Microsoft Pinyin
     * (or any CJK IME) is composing, the renderer only receives keyCode 229 /
     * key "Process" for letter and digit keys, so the in-page listeners see
     * nothing usable. before-input-event fires before that processing and
     * still has the physical key. The renderer de-duplicates, so this is a
     * safety net rather than a second source of truth. */
    win.webContents.on("before-input-event", (_event, input) => {
        if (input.type !== "keyDown" || input.isAutoRepeat) return;
        try {
            win.webContents.send("zp-key-event", {
                key: input.key,
                code: input.code,
                keyCode: input.keyCode,
                ctrlKey: input.control,
                altKey: input.alt,
                shiftKey: input.shift,
                metaKey: input.meta,
                fromMain: true,
            });
        } catch (e) {}
    });

    win.loadURL(`http://127.0.0.1:${PORT}/`);
    mainWindow = win;
    win.on("closed", () => {
        if (mainWindow === win) mainWindow = null;
    });
}

/* URLs other devices on the same network can use to reach the app. */
function lanUrls() {
    const out = [];
    try {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const n of nets[name] || []) {
                if (n.family === "IPv4" && !n.internal) out.push(`http://${n.address}:${PORT}/`);
            }
        }
    } catch (e) {}
    return out;
}

function listenWithRetry() {
    return new Promise((resolve, reject) => {
        const onError = (e) => {
            server.removeListener("listening", onListening);
            if (e.code === "EADDRINUSE" && PORT < PORT_MAX) {
                PORT++;
                return listenWithRetry().then(resolve, reject);
            }
            reject(e);
        };
        const onListening = () => {
            server.removeListener("error", onError);
            console.log(`ZeppPlayer server on http://127.0.0.1:${PORT}`);
            for (const u of lanUrls()) console.log(`ZeppPlayer mobile access: ${u}`);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        // 0.0.0.0 lets phones on the same Wi-Fi open the responsive UI.
        server.listen(PORT, "0.0.0.0");
    });
}

app.whenReady().then(async () => {
    if (!hasSingleInstanceLock) return;
    getProjectsDir();
    try {
        await listenWithRetry();
    } catch (e) {
        dialog.showErrorBox("ZeppPlayer", "无法启动本地服务 / Cannot start local server:\n" + (e && e.message || e));
        app.quit();
        return;
    }
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    server.close();
    if (process.platform !== "darwin") app.quit();
});
