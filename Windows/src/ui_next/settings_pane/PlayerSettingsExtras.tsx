import React from "preact/compat";
import {Button} from "../base/Button";
import {SettingsListItem} from "./SettingsListItem";
import {ToolbarManager} from "../../ui_managment/ToolbarManager";
import {getDeviceProfiles, readCustomProfiles, saveCustomProfiles} from "../../zepp_player/DeviceProfiles";

const getPlayer = () => ToolbarManager.player;

function pickFile(accept: string): Promise<File | null> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
        input.click();
    });
}

function download(name: string, text: string) {
    const blob = new Blob([text], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Imports `{"my_band": {"screenWidth": 480, ...}}` on top of the built-in
 * device table, so unlisted bands can be emulated without a code change.
 */
export function DeviceProfilesItem() {
    const [message, setMessage] = React.useState("");

    const load = async () => {
        const file = await pickFile(".json,application/json");
        if(!file) return;
        try {
            const data = JSON.parse(await file.text());
            if(!data || typeof data !== "object") throw new Error("not an object");
            const merged = Object.assign({}, readCustomProfiles(), data);
            saveCustomProfiles(merged);
            setMessage(`已导入 ${Object.keys(data).length} 个设备，正在刷新…`);
            setTimeout(() => location.reload(), 500);
        } catch(e) {
            setMessage("导入失败：" + (e && e.message || e));
        }
    };

    const reset = () => {
        saveCustomProfiles({});
        setMessage("已恢复内置设备列表，正在刷新…");
        setTimeout(() => location.reload(), 500);
    };

    const count = Object.keys(readCustomProfiles()).length;
    return (
        <SettingsListItem title="设备能力扩展" noClickHandler
            description={`用 JSON 补充未内置的设备（当前自定义 ${count} 个）`}>
            <div style={{display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap"}}>
                <Button onClick={load}>导入 JSON</Button>
                <Button onClick={reset}>恢复默认</Button>
                {message && <span style={{fontSize: "12px", opacity: .85}}>{message}</span>}
            </div>
        </SettingsListItem>
    );
}

/** Replays a recorded sensor curve one sample per second. */
export function SensorCurveItem() {
    const [message, setMessage] = React.useState("");
    const [playing, setPlaying] = React.useState(false);

    const load = async () => {
        const file = await pickFile(".json,application/json");
        if(!file) return;
        try {
            const data = JSON.parse(await file.text());
            const player = getPlayer();
            if(!player) return;
            player.loadSensorCurve(data);
            const keys = Object.keys(data || {});
            setPlaying(true);
            setMessage("回放中：" + keys.join(", "));
        } catch(e) {
            setMessage("载入失败：" + (e && e.message || e));
        }
    };

    const stop = () => {
        const player = getPlayer();
        if(player) player.stopSensorCurve();
        setPlaying(false);
        setMessage("已停止回放");
    };

    return (
        <SettingsListItem title="传感器曲线回放" noClickHandler
            description={'JSON 形如 {"HEART":[72,75,80],"STEP":[100,120]}，每秒取一个值'}>
            <div style={{display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap"}}>
                <Button onClick={load}>载入曲线</Button>
                {playing && <Button onClick={stop}>停止</Button>}
                {message && <span style={{fontSize: "12px", opacity: .85}}>{message}</span>}
            </div>
        </SettingsListItem>
    );
}

/** Android only: install or repair the bundled Node + Zeus CLI runtime. */
export function ZeusRuntimeItem() {
    const [state, setState] = React.useState<any>(null);
    const [message, setMessage] = React.useState("");

    const load = () => {
        fetch("/api/zeus/info")
            .then((r) => {
                const type = r.headers.get("content-type") || "";
                return (r.ok && type.indexOf("application/json") > -1) ? r.json() : null;
            })
            .then((info) => { if (info && info.ok) setState(info); })
            .catch(() => {});
    };

    React.useEffect(() => { load(); }, []);

    /* Desktop and non-arm64 devices have no bundled runtime, so the item
     * stays hidden there instead of showing a misleading status. */
    if(!state || !state.supported) return null;

    const mb = (Number(state.runtimeBytes || 0) / 1048576).toFixed(0);
    const status = state.installing
        ? "正在安装…"
        : state.needsInstall
            ? `未安装（需要约 ${mb} MB）`
            : "已安装";

    const open = async () => {
        const mod = await import("../../ui_managment/ZeusInstallDialog.js");
        mod.forceZeusInstallDialog();
        setTimeout(load, 1500);
        setMessage("安装完成后可再次查看状态");
    };

    return (
        <SettingsListItem title="Zeus 运行时" noClickHandler
            description={`真实 Node.js + @zeppos/zeus-cli · ${status}`}>
            <div style={{display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap"}}>
                {state.supported && <Button onClick={open}>{state.needsInstall ? "安装" : "重新安装"}</Button>}
                <Button onClick={load}>刷新状态</Button>
                {message && <span style={{fontSize: "12px", opacity: .85}}>{message}</span>}
            </div>
        </SettingsListItem>
    );
}

/** Companion HTTP traffic, so network issues need no console.log digging. */
export function NetworkLogItem() {
    const [rows, setRows] = React.useState<any[]>([]);

    React.useEffect(() => {
        const update = () => {
            const player = getPlayer();
            const log = player && player.appSideManager ? player.appSideManager.networkLog : [];
            setRows(log.slice(-8).reverse());
        };
        update();
        const timer = setInterval(update, 1000);
        return () => clearInterval(timer);
    }, []);

    const clear = () => {
        const player = getPlayer();
        if(player && player.appSideManager) player.appSideManager.clearNetworkLog();
        setRows([]);
    };

    return (
        <SettingsListItem title="网络请求（App-side）" noClickHandler
            description="最近 8 条请求，失败会标红">
            <div style={{display: "flex", flexDirection: "column", gap: "6px", maxWidth: "360px"}}>
                <div style={{display: "flex", gap: "8px"}}>
                    <Button onClick={clear}>清空</Button>
                </div>
                {rows.length === 0 && <span style={{fontSize: "12px", opacity: .7}}>暂无请求</span>}
                {rows.map((row, i) => (
                    <div key={i} style={{fontSize: "11px", lineHeight: "1.4", opacity: .9,
                        color: row.ok ? "inherit" : "#d33", wordBreak: "break-all"}}>
                        {row.method} {row.url} · {row.ok ? (row.status || "-") : "FAIL"} · {row.duration}ms
                        {row.error ? " · " + row.error : ""}
                    </div>
                ))}
            </div>
        </SettingsListItem>
    );
}

/** One-click report with everything needed to reproduce a problem. */
export function DiagnosticsItem() {
    const [message, setMessage] = React.useState("");

    const exportReport = () => {
        const player = getPlayer();
        const report = {
            generatedAt: new Date().toISOString(),
            appVersion: (window as any).zpVersion || null,
            device: player ? player.profileName : null,
            projectPath: player ? player.projectPath : null,
            appConfig: player ? player.appConfig : null,
            sensorCurve: player ? Object.keys(player.sensorCurve || {}) : [],
            network: player && player.appSideManager ? player.appSideManager.networkLog.slice(-100) : [],
        };
        download("zeppplayer-diagnostics.json", JSON.stringify(report, null, 2));
        setMessage("已导出 zeppplayer-diagnostics.json");
    };

    return (
        <SettingsListItem title="导出诊断报告" noClickHandler
            description="包含项目、设备、网络请求与配置，便于反馈问题">
            <div style={{display: "flex", gap: "8px", alignItems: "center"}}>
                <Button onClick={exportReport}>导出</Button>
                {message && <span style={{fontSize: "12px", opacity: .85}}>{message}</span>}
            </div>
        </SettingsListItem>
    );
}

/**
 * Renders the current project on several device profiles and shows the
 * snapshots side by side, which makes layout problems obvious at a glance.
 */
export function CompareDevicesItem() {
    const [shots, setShots] = React.useState<{name: string, url: string}[]>([]);
    const [busy, setBusy] = React.useState(false);

    const capture = async () => {
        const player = getPlayer();
        if(!player || busy) return;
        setBusy(true);
        setShots([]);

        const original = player.profileName;
        const profiles = getDeviceProfiles();
        const targets = Object.keys(profiles).filter((id) => id !== original).slice(0, 2);
        const list = [original].concat(targets);
        const result: {name: string, url: string}[] = [];

        try {
            for(const id of list) {
                player.profileName = id;
                if(player.overlayTool) await player.overlayTool.init();
                await player.init();
                await new Promise((r) => setTimeout(r, 350));
                const canvas = document.getElementById("display") as HTMLCanvasElement;
                if(canvas) result.push({name: id, url: canvas.toDataURL("image/png")});
            }
        } catch(e) {
            console.warn("compare failed", e);
        } finally {
            player.profileName = original;
            if(player.overlayTool) await player.overlayTool.init();
            await player.init();
            setShots(result);
            setBusy(false);
        }
    };

    return (
        <SettingsListItem title="多设备对比" noClickHandler
            description="同一项目在当前设备与另外两个设备上的渲染结果">
            <div style={{display: "flex", flexDirection: "column", gap: "8px"}}>
                <div><Button onClick={capture}>{busy ? "生成中…" : "生成对比"}</Button></div>
                <div style={{display: "flex", gap: "8px", flexWrap: "wrap"}}>
                    {shots.map((shot) => (
                        <div key={shot.name} style={{textAlign: "center", fontSize: "11px"}}>
                            <img src={shot.url} style={{width: "110px", borderRadius: "6px"}} />
                            <div>{shot.name}</div>
                        </div>
                    ))}
                </div>
            </div>
        </SettingsListItem>
    );
}
