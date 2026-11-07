import React from "preact/compat";
import {Button} from "../base/Button";
import {zpConfirm} from "../../zepp_player/zpDialogs.js";
import I18n from "../../zepp_player/i18n.js";
import ZeppPlayer from "../../zepp_player/ZeppPlayer";
import {ChangesWatcher} from "../../ui_managment/ChangesWatcher";
import {isMobileView} from "../../ui_managment/ViewMode.js";

import "./PanelCode.css";

type CodeFile = {
    name: string,
    url: string,
    depth: number,
    dir: boolean,
};

const CODE_EXTS = [".js", ".ts", ".json", ".css", ".html", ".wml", ".txt", ".md"];
const SKIP_DIRS = ["node_modules", ".git", ".idea", ".vs", ".vscode", "__pycache__", "dist"];

async function collectFiles(rootUrl: string, depth: number, out: CodeFile[]): Promise<CodeFile[]> {
    if (depth > 5) return out;
    let html: string;
    try {
        const resp = await fetch(rootUrl);
        if (!resp.ok) return out;
        html = await resp.text();
    } catch (e) {
        return out;
    }

    const entries: { name: string, dir: boolean }[] = [];
    const re = /<a href="([^"]+)">/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        const link = m[1];
        if(!link || link === "../" || link === "./") continue;
        entries.push({ name: link.endsWith("/") ? link.slice(0, -1) : link, dir: link.endsWith("/") });
    }

    const dirs = entries.filter((e) => e.dir && SKIP_DIRS.indexOf(e.name) < 0)
        .sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter((e) => !e.dir && CODE_EXTS.some((ext) => e.name.toLowerCase().endsWith(ext)))
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirs) {
        const dirUrl = rootUrl + "/" + encodeURI(d.name);
        out.push({ name: d.name, url: dirUrl, depth, dir: true });
        await collectFiles(dirUrl, depth + 1, out);
    }
    for (const f of files) {
        out.push({ name: f.name, url: rootUrl + "/" + encodeURI(f.name), depth, dir: false });
    }
    return out;
}

export function PanelCode(props: { player: ZeppPlayer }) {
    const [files, setFiles] = React.useState<CodeFile[]>([]);
    const [rootName, setRootName] = React.useState("");
    const [current, setCurrent] = React.useState<CodeFile | null>(null);
    const [content, setContent] = React.useState("");
    const [orig, setOrig] = React.useState("");
    const [status, setStatus] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [manualPick, setManualPick] = React.useState(false);
    const [treeOpen, setTreeOpen] = React.useState(false);
    const acceptPage = React.useRef(true);

    const loadList = () => {
        const root = props.player ? props.player.projectPath : "";
        if (!root) { setFiles([]); return; }
        const segs = root.split("/").filter(Boolean);
        setRootName(segs[segs.length - 1] || root);
        setFiles([]);
        setManualPick(false);
        acceptPage.current = true;
        collectFiles(root, 0, []).then((list) => {
            setFiles(list);
            // after initial build, follow the runtime that is already active
            const rt = props.player.currentRuntime;
            if (rt) followRuntime(rt, list);
        }).catch((e) => console.error("collectFiles failed", e));
    };

    const openTo = async (f: CodeFile) => {
        if (f.dir) return;
        setCurrent(f);
        setStatus("");
        setBusy(true);
        try {
            const resp = await fetch(f.url);
            if (!resp.ok) throw new Error(resp.status + "");
            const text = await resp.text();
            setContent(text);
            setOrig(text);
        } catch (e: any) {
            setContent("");
            setOrig("");
            setStatus(I18n.t("code.loadFailed") + (e && e.message || e));
        } finally {
            setBusy(false);
        }
    };

    const followRuntime = (runtime: any, list: CodeFile[]) => {
        if (!runtime || !acceptPage.current) return;
        const sp = runtime.scriptPath;
        if (!sp) return;
        const target = (list || files).find((f) => !f.dir && (f.url === sp || f.url.endsWith(sp)));
        if (target) openTo(target);
    };

    const dirty = content !== orig;

    // Load project file tree
    React.useEffect(() => {
        const timer = setInterval(() => {
            // retry until a project path is set (mount races setProject)
            if (!props.player.projectPath || files.length > 0) {
                // keep polling; harmless
            } else {
                loadList();
            }
        }, 600);
        return () => clearInterval(timer);
    }, [props.player, files.length]);

    React.useEffect(() => {
        loadList();
        const ref = props.player.onProjectChanged.add(loadList);
        return () => props.player.onProjectChanged.detach(ref);
    }, [props.player]);

    // Follow current page (auto open matching JS file), unless user picked something manually
    React.useEffect(() => {
        const follow = (runtime: any) => followRuntime(runtime, files);
        const ref = props.player.onRuntimeChanged.add(follow);
        return () => props.player.onRuntimeChanged.detach(ref);
    }, [props.player, files]);

    // Console lines with a source path can open that file here.
    React.useEffect(() => {
        (window as any).zpOpenCodeFile = (scriptPath: string) => {
            if(!scriptPath) return;
            const target = files.find((f) => !f.dir
                && (f.url === scriptPath || f.url.endsWith(scriptPath) || scriptPath.endsWith(f.url)));
            if(!target) return;
            acceptPage.current = false;
            setManualPick(true);
            openTo(target);
            // On a phone the panel is a modal; console links should bring it up.
            const open = (window as any).zpOpenCode;
            if (open) open();
            const panel = document.getElementById("code_panel");
            if(panel) panel.scrollIntoView({behavior: "smooth", block: "nearest"});
        };
        return () => { delete (window as any).zpOpenCodeFile; };
    }, [files]);

    const openFile = async (f: CodeFile) => {
        acceptPage.current = false;
        setManualPick(true);
        if (f.dir) return;
        // Picking a file closes the drawer so the editor gets the whole screen.
        setTreeOpen(false);
        await openTo(f);
    };

    const save = async () => {
        if (!current || busy) return;
        setBusy(true);
        try {
            const resp = await fetch(current.url, { method: "PUT", body: content });
            if (!resp.ok) {
                let msg = resp.status + "";
                try {
                    const j = await resp.json();
                    if (j && j.msg) msg = j.msg;
                } catch (e) {}
                throw new Error(msg);
            }
            setOrig(content);
            setStatus(I18n.t("code.saved"));
            // The write above also bumps the file-change counter; hold the
            // auto-restart watcher so the player is not restarted twice.
            ChangesWatcher.hold(1800);
            try { await props.player.restart(); } catch (e) { console.error("restart after save failed", e); }
        } catch (e: any) {
            setStatus(I18n.t("code.saveFailed") + (e && e.message || e));
        } finally {
            setBusy(false);
        }
    };

    // Ctrl+S works from anywhere in the window, not only while the editor
    // has focus (see ToolbarManager.onKeyEvent).
    React.useEffect(() => {
        (window as any).zpSaveCode = save;
        return () => {
            if((window as any).zpSaveCode === save) delete (window as any).zpSaveCode;
        };
    });

    const onKeyDown = (e: any) => {
        // Ctrl+S is handled once, globally, by ToolbarManager.onKeyEvent; only
        // suppress the browser default here. A CJK IME rewrites this event to
        // key "Process", so saving here would miss it entirely.
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            return;
        }
        if (e.key === "Tab" && current) {
            e.preventDefault();
            const el = e.currentTarget as HTMLTextAreaElement;
            const start = el.selectionStart;
            const end = el.selectionEnd;
            setContent(content.slice(0, start) + "  " + content.slice(end));
            requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = start + 2;
            });
        }
    };

    return (
        <div className={"zpc" + (treeOpen ? " zpc--tree-open" : "")}>
            <div className="zpc__head">
                <span className="zpc__title">{I18n.t("code.title")}</span>
                <span className="zpc__root">{rootName}</span>
                <span className="zpc__actions">
                    <span className="material-symbols-outlined zpc__iconbtn zpc__files-btn"
                          title={I18n.t("code.fileList")}
                          onClick={() => setTreeOpen(!treeOpen)}>
                        folder
                    </span>
                    <Button onClick={save} primary>{I18n.t("code.saveReload")}</Button>
                    <span className="material-symbols-outlined zpc__iconbtn zpc__close-btn"
                          title={I18n.t("code.close")}
                          onClick={() => {
                              const close = (window as any).zpCloseCode;
                              if (close) close();
                          }}>
                        close
                    </span>
                </span>
            </div>
            <span className={"zpc__status" + (status ? "" : " zpc__status--empty")}>{status}</span>
            <div className="zpc__body">
                <div className="zpc__tree">
                    {files.length === 0 && <div className="zpc__empty">{I18n.t("code.files")}</div>}
                    {files.map((f) => (
                        <div key={f.url}
                             className={"zpc__file"
                                 + (f.dir ? " zpc__file--dir" : "")
                                 + (current && current.url === f.url ? " zpc__file--active" : "")}
                             style={{ paddingLeft: 8 + f.depth * 14 }}
                             onClick={() => openFile(f)}>
                            <span className="zpc__icon">{f.dir ? "▸" : ""}</span>
                            {f.name}
                        </div>
                    ))}
                </div>
                <div className="zpc__editor-wrap">
                    {current ? (
                        <>
                            <div className="zpc__path">
                                {current.url}
                                {manualPick && <span className="zpc__manual">· {I18n.t("code.manualFollow")}</span>}
                            </div>
                            <textarea className="zpc__editor"
                                      value={content}
                                      onInput={(e: any) => setContent(e.target.value)}
                                      onKeyDown={onKeyDown}
                                      spellCheck={false}
                                      wrap={isMobileView() ? "soft" : "off"} />
                        </>
                    ) : (
                        <div className="zpc__empty">
                            {I18n.t(isMobileView() ? "code.pickFileMobile" : "code.pickFile")}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}