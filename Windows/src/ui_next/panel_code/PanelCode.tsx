import React from "preact/compat";
import {Button} from "../base/Button";
import {zpConfirm} from "../../zepp_player/zpDialogs.js";
import I18n from "../../zepp_player/i18n.js";
import ZeppPlayer from "../../zepp_player/ZeppPlayer";
import {ChangesWatcher} from "../../ui_managment/ChangesWatcher";
import {isMobileView} from "../../ui_managment/ViewMode.js";

import {basicSetup} from "codemirror";
import {Decoration, EditorView, keymap, ViewPlugin} from "@codemirror/view";
import type {DecorationSet, ViewUpdate} from "@codemirror/view";
import {EditorState, StateEffect, StateField} from "@codemirror/state";
import type {Range} from "@codemirror/state";
import {indentWithTab} from "@codemirror/commands";
import {SearchCursor} from "@codemirror/search";
import {javascript} from "@codemirror/lang-javascript";
import {json} from "@codemirror/lang-json";
import {css} from "@codemirror/lang-css";
import {html} from "@codemirror/lang-html";
import {oneDark} from "@codemirror/theme-one-dark";

import "./PanelCode.css";

type CodeFile = {
    name: string,
    url: string,
    depth: number,
    dir: boolean,
};

type LoadedDoc = {
    file: CodeFile,
    text: string,
};

const CODE_EXTS = [".js", ".ts", ".json", ".css", ".html", ".wml", ".txt", ".md"];
const SKIP_DIRS = ["node_modules", ".git", ".idea", ".vs", ".vscode", "__pycache__", "dist"];
/* Docs and notes cannot change what the simulator renders, so saving them must
 * not cost a full restart. Everything else (js/ts/json/css/html/wml) does. */
const NO_RELOAD_EXTS = [".md", ".txt"];

function langFor(name: string) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".ts")) return javascript({typescript: true});
    if (lower.endsWith(".js")) return javascript();
    if (lower.endsWith(".json")) return json();
    if (lower.endsWith(".css")) return css();
    if (lower.endsWith(".html") || lower.endsWith(".wml")) return html();
    return [];
}

/* In-file search. CodeMirror's own highlighter only paints while its built-in
 * panel is open, but the panel has a compact search row of its own, so the
 * query lives in a dedicated state field and is painted by a small plugin. */
const setSearchString = StateEffect.define<string>();

const searchStringField = StateField.define<string>({
    create: () => "",
    update(value, tr) {
        for (const e of tr.effects) {
            if (e.is(setSearchString)) value = e.value;
        }
        return value;
    },
});

const hitMark = Decoration.mark({class: "zpc-hit"});
const hitCurrentMark = Decoration.mark({class: "zpc-hit zpc-hit--current"});

const searchHighlighter = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
        this.decorations = this.build(view);
    }

    update(u: ViewUpdate) {
        if (u.startState.field(searchStringField) !== u.state.field(searchStringField)
            || u.docChanged || u.viewportChanged || u.selectionSet) {
            this.decorations = this.build(u.view);
        }
    }

    build(view: EditorView) {
        const query = view.state.field(searchStringField);
        if (!query) return Decoration.none;
        const doc = view.state.doc;
        const sel = view.state.selection.main;
        const marks: Range<Decoration>[] = [];
        const cursor = new SearchCursor(doc, query.toLowerCase(), 0, doc.length,
            (s: string) => s.toLowerCase());
        while (!cursor.next().done) {
            const {from, to} = cursor.value;
            const mark = sel.from === from && sel.to === to ? hitCurrentMark : hitMark;
            marks.push(mark.range(from, to));
        }
        return Decoration.set(marks, true);
    }
}, {
    decorations: (v) => v.decorations,
});

function findMatches(doc: any, query: string): {from: number, to: number}[] {
    const out: {from: number, to: number}[] = [];
    if (!query) return out;
    const cursor = new SearchCursor(doc, query.toLowerCase(), 0, doc.length,
        (s: string) => s.toLowerCase());
    while (!cursor.next().done) out.push({from: cursor.value.from, to: cursor.value.to});
    return out;
}

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
    const [doc, setDoc] = React.useState<LoadedDoc | null>(null);
    const [status, setStatus] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [dirty, setDirty] = React.useState(false);
    const [manualPick, setManualPick] = React.useState(false);
    const [treeOpen, setTreeOpen] = React.useState(false);
    const [searchOpen, setSearchOpen] = React.useState(false);
    const [searchText, setSearchText] = React.useState("");
    const [matchTotal, setMatchTotal] = React.useState(0);
    const [matchIndex, setMatchIndex] = React.useState(0);

    const acceptPage = React.useRef(true);
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const viewRef = React.useRef<EditorView | null>(null);
    const origRef = React.useRef("");
    const dirtyRef = React.useRef(false);
    const currentRef = React.useRef<CodeFile | null>(null);
    const saveRef = React.useRef<() => void>(() => {});
    const searchInputRef = React.useRef<HTMLInputElement | null>(null);
    const queryRef = React.useRef("");
    const matchesRef = React.useRef<{from: number, to: number}[]>([]);

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
        currentRef.current = f;
        setCurrent(f);
        setDoc(null);
        dirtyRef.current = false;
        setDirty(false);
        setStatus("");
        setBusy(true);
        try {
            const resp = await fetch(f.url);
            if (!resp.ok) throw new Error(resp.status + "");
            const text = await resp.text();
            origRef.current = text;
            setDoc({file: f, text});
        } catch (e: any) {
            origRef.current = "";
            setDoc({file: f, text: ""});
            setStatus(I18n.t("code.loadFailed") + (e && e.message || e));
        } finally {
            setBusy(false);
        }
    };

    const followRuntime = (runtime: any, list: CodeFile[]) => {
        if (!runtime || !acceptPage.current) return;
        // Never throw away edits just because the preview navigated.
        if (dirtyRef.current) return;
        const sp = runtime.scriptPath;
        if (!sp) return;
        const target = (list || files).find((f) => !f.dir && (f.url === sp || f.url.endsWith(sp)));
        if (target) openTo(target);
    };

    const confirmDiscard = async () => {
        if (!dirtyRef.current) return true;
        return await zpConfirm(I18n.t("code.discardConfirm"));
    };

    const selectMatch = (idx: number) => {
        const view = viewRef.current;
        const ranges = matchesRef.current;
        if (!view || ranges.length === 0) return;
        const i = ((idx % ranges.length) + ranges.length) % ranges.length;
        const range = ranges[i];
        view.dispatch({
            selection: {anchor: range.from, head: range.to},
            effects: EditorView.scrollIntoView(range.from, {y: "center"}),
        });
        setMatchIndex(i + 1);
    };

    const applySearch = (next: string, jump: boolean) => {
        queryRef.current = next;
        setSearchText(next);
        const view = viewRef.current;
        if (!view) {
            matchesRef.current = [];
            setMatchTotal(0);
            setMatchIndex(0);
            return;
        }
        view.dispatch({effects: setSearchString.of(next)});
        const ranges = findMatches(view.state.doc, next);
        matchesRef.current = ranges;
        setMatchTotal(ranges.length);
        if (ranges.length === 0) {
            setMatchIndex(0);
            return;
        }
        if (jump) {
            const pos = view.state.selection.main.from;
            const at = ranges.findIndex((r) => r.from >= pos);
            selectMatch(at < 0 ? 0 : at);
        } else {
            setMatchIndex(0);
        }
    };

    const stepMatch = (dir: number) => {
        const view = viewRef.current;
        const ranges = matchesRef.current;
        if (!view || ranges.length === 0) return;
        const pos = view.state.selection.main.from;
        if (dir > 0) {
            const at = ranges.findIndex((r) => r.from > pos);
            selectMatch(at < 0 ? 0 : at);
        } else {
            let at = -1;
            for (let i = 0; i < ranges.length; i++) {
                if (ranges[i].to < pos) at = i;
            }
            selectMatch(at < 0 ? ranges.length - 1 : at);
        }
    };

    const closeSearch = () => {
        setSearchOpen(false);
        applySearch("", false);
    };

    const toggleSearch = () => {
        if (searchOpen) {
            closeSearch();
            return;
        }
        setSearchOpen(true);
    };

    React.useEffect(() => {
        if (searchOpen && searchInputRef.current) searchInputRef.current.focus();
    }, [searchOpen]);

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
        if (f.dir) return;
        if (!(await confirmDiscard())) return;
        acceptPage.current = false;
        setManualPick(true);
        // Picking a file closes the drawer so the editor gets the whole screen.
        setTreeOpen(false);
        await openTo(f);
    };

    const save = async () => {
        const file = currentRef.current;
        if (!file || busy) return;
        const view = viewRef.current;
        const text = view ? view.state.doc.toString() : (doc ? doc.text : "");
        setBusy(true);
        try {
            const resp = await fetch(file.url, { method: "PUT", body: text });
            if (!resp.ok) {
                let msg = resp.status + "";
                try {
                    const j = await resp.json();
                    if (j && j.msg) msg = j.msg;
                } catch (e) {}
                throw new Error(msg);
            }
            origRef.current = text;
            dirtyRef.current = false;
            setDirty(false);

            const noReload = NO_RELOAD_EXTS.some((ext) => file.name.toLowerCase().endsWith(ext));
            if (noReload) {
                // Long enough for the change watcher to consume and ignore the
                // write, so a note edit never restarts the simulator.
                ChangesWatcher.hold(4000);
                setStatus(I18n.t("code.savedNoReload"));
            } else {
                setStatus(I18n.t("code.saved"));
                // The write above also bumps the file-change counter; hold the
                // auto-restart watcher so the player is not restarted twice.
                ChangesWatcher.hold(1800);
                try { await props.player.restart(); } catch (e) { console.error("restart after save failed", e); }
            }
        } catch (e: any) {
            setStatus(I18n.t("code.saveFailed") + (e && e.message || e));
        } finally {
            setBusy(false);
        }
    };

    saveRef.current = save;

    const closePanel = async () => {
        if (!(await confirmDiscard())) return;
        const close = (window as any).zpCloseCode;
        if (close) close();
    };

    // Ctrl+S works from anywhere in the window, not only while the editor
    // has focus (see ToolbarManager.onKeyEvent).
    React.useEffect(() => {
        (window as any).zpSaveCode = save;
        (window as any).zpCodeHasUnsaved = () => dirtyRef.current;
        (window as any).zpRequestCloseCode = closePanel;
        return () => {
            if((window as any).zpSaveCode === save) delete (window as any).zpSaveCode;
            delete (window as any).zpCodeHasUnsaved;
            delete (window as any).zpRequestCloseCode;
        };
    });

    // Build the CodeMirror view once per loaded file. Recreating it on every
    // keystroke would wipe the undo history and the cursor.
    React.useEffect(() => {
        if (!doc || !hostRef.current) return;
        const mobile = isMobileView();
        const view = new EditorView({
            state: EditorState.create({
                doc: doc.text,
                extensions: [
                    basicSetup,
                    oneDark,
                    langFor(doc.file.name),
                    EditorState.tabSize.of(2),
                    keymap.of([indentWithTab]),
                    keymap.of([{
                        key: "Mod-s",
                        run: () => { saveRef.current(); return true; },
                    }]),
                    searchStringField,
                    searchHighlighter,
                    EditorView.updateListener.of((u) => {
                        if (!u.docChanged) return;
                        const next = u.state.doc.toString() !== origRef.current;
                        if (next !== dirtyRef.current) {
                            dirtyRef.current = next;
                            setDirty(next);
                        }
                        if (queryRef.current) {
                            const ranges = findMatches(u.state.doc, queryRef.current);
                            matchesRef.current = ranges;
                            setMatchTotal(ranges.length);
                        }
                    }),
                    mobile ? EditorView.lineWrapping : [],
                    EditorView.theme({
                        "&": {height: "100%", fontSize: "12.5px", background: "transparent"},
                        ".cm-scroller": {
                            fontFamily: 'Consolas, Menlo, "Courier New", monospace',
                            lineHeight: "1.5",
                            overflow: "auto",
                        },
                        ".cm-content": {padding: "6px 0"},
                        "&.cm-focused": {outline: "none"},
                        ".cm-gutters": {
                            background: "rgba(0, 0, 0, .18)",
                            border: "none",
                            color: "rgba(255, 255, 255, .38)",
                        },
                        ".cm-activeLine": {background: "rgba(255, 255, 255, .045)"},
                        ".cm-activeLineGutter": {background: "rgba(255, 255, 255, .07)"},
                    }, {dark: true}),
                ],
            }),
            parent: hostRef.current,
        });
        viewRef.current = view;

        // A new file keeps the query (and its yellow hits) but never scrolls
        // away from the top on its own.
        if (queryRef.current) {
            view.dispatch({effects: setSearchString.of(queryRef.current)});
            const ranges = findMatches(view.state.doc, queryRef.current);
            matchesRef.current = ranges;
            setMatchTotal(ranges.length);
            setMatchIndex(0);
        }

        // The phone modal is created while hidden, so the editor has to
        // re-measure when the panel finally gets a size.
        let ro: ResizeObserver | null = null;
        if (typeof ResizeObserver !== "undefined") {
            ro = new ResizeObserver(() => view.requestMeasure());
            ro.observe(hostRef.current);
        }

        return () => {
            if (ro) ro.disconnect();
            view.destroy();
            viewRef.current = null;
        };
    }, [doc]);

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
                          onClick={closePanel}>
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
                                <span className="zpc__path-text" title={current.url}>{current.url}</span>
                                {dirty && <span className="zpc__dirty" title={I18n.t("code.unsaved")}>●</span>}
                                {manualPick && <span className="zpc__manual">· {I18n.t("code.manualFollow")}</span>}
                                <span className="zpc__search">
                                    {searchOpen && (
                                        <input ref={searchInputRef}
                                               className="zpc__search-input"
                                               type="text"
                                               spellCheck={false}
                                               value={searchText}
                                               placeholder={I18n.t("code.search")}
                                               onInput={(e) => applySearch((e.target as HTMLInputElement).value, true)}
                                               onKeyDown={(e) => {
                                                   if (e.key === "Enter") {
                                                       e.preventDefault();
                                                       stepMatch(e.shiftKey ? -1 : 1);
                                                   } else if (e.key === "Escape") {
                                                       e.preventDefault();
                                                       closeSearch();
                                                   }
                                               }} />
                                    )}
                                    {searchOpen && searchText && (
                                        <span className="zpc__search-count">{matchIndex}/{matchTotal}</span>
                                    )}
                                    <span className="material-symbols-outlined zpc__navbtn"
                                          title={I18n.t("code.search")}
                                          onClick={toggleSearch}>
                                        search
                                    </span>
                                    <span className="material-symbols-outlined zpc__navbtn"
                                          title={I18n.t("code.searchPrev")}
                                          onClick={() => stepMatch(-1)}>
                                        keyboard_arrow_up
                                    </span>
                                    <span className="material-symbols-outlined zpc__navbtn"
                                          title={I18n.t("code.searchNext")}
                                          onClick={() => stepMatch(1)}>
                                        keyboard_arrow_down
                                    </span>
                                </span>
                            </div>
                            <div className="zpc__cm" ref={hostRef} />
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
