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
const { execFile } = require("child_process");

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

function handleApi(req, res, pathname) {
    const q = url.parse(req.url, true).query;

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
            dialog.showSaveDialog(win || undefined, {
                title: "导出项目 / Export project",
                defaultPath: path.join(app.getPath("documents"), `${base}.zip`),
                filters: [{ name: "ZIP", extensions: ["zip"] }],
            }).then(async (r) => {
                if (r.canceled || !r.filePath) {
                    return sendJson(res, { ok: false, cancelled: true });
                }
                let zipPath = r.filePath;
                if (!/\.zip$/i.test(zipPath)) zipPath += ".zip";
                const err = await zipDirectory(dir, zipPath);
                if (err) return sendJson(res, { ok: false, msg: "打包失败：" + err }, 500);
                sendJson(res, { ok: true, path: zipPath });
            }).catch((e) => sendJson(res, { ok: false, msg: String(e && e.message || e) }, 500));
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
        const tmpZip = path.join(os.tmpdir(), `zp_export_${Date.now()}_${Math.random().toString(36).slice(2)}.zip`);
        const cleanup = () => fs.rm(tmpZip, { force: true }, () => {});

        zipDirectory(dir, tmpZip).then((err) => {
            if (err) {
                cleanup();
                return sendJson(res, { ok: false, msg: "打包失败：" + err }, 500);
            }
            const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
            res.setHeader("Content-Type", "application/zip");
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            res.setHeader("Content-Disposition",
                `attachment; filename="${ascii}.zip"; filename*=UTF-8''${encodeURIComponent(base)}.zip`);
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
