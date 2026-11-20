/*
    Headless smoke test.

    Boots the Electron app with a throw-away profile, imports a ZeppOS project,
    waits for it to render and asserts that the page produced runtime widgets.
    Exits 0 on success, 1 on failure.

    Usage: node scripts/smoke.js "C:\\path\\to\\zepp-project"
*/
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectDir = process.argv[2];
if (!projectDir) {
    console.error("usage: node scripts/smoke.js <project-dir>");
    process.exit(2);
}

const name = path.basename(projectDir);
const stamp = Date.now();
const userData = path.join(os.tmpdir(), "zp-smoke-" + stamp);
const projectsRoot = path.join(userData, "projects");
const target = path.join(projectsRoot, name);

fs.mkdirSync(projectsRoot, {recursive: true});
fs.cpSync(projectDir, target, {recursive: true});

const electron = path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
const port = 9334;

const child = spawn(electron, [".", "--remote-debugging-port=" + port, "--user-data-dir=" + userData], {
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
    for (let i = 0; i < 40; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`);
            const list = await res.json();
            const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
            if (page) return page;
        } catch (e) { /* not up yet */ }
        await sleep(500);
    }
    throw new Error("devtools endpoint did not appear");
}

function connect(url) {
    return new Promise((resolve) => {
        const ws = new WebSocket(url);
        let id = 0;
        const pending = new Map();
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            const cb = pending.get(msg.id);
            if (cb) { pending.delete(msg.id); cb(msg); }
        };
        ws.onopen = () => resolve({
            send(method, params) {
                return new Promise((res) => {
                    const msgId = ++id;
                    pending.set(msgId, res);
                    ws.send(JSON.stringify({id: msgId, method, params: params || {}}));
                });
            },
            close() { ws.close(); },
        });
    });
}

async function evaluate(client, expression) {
    const res = await client.send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
    if (res.result && res.result.exceptionDetails) return null;
    return res.result && res.result.result ? res.result.result.value : null;
}

(async () => {
    let failed = false;
    try {
        const page = await findTarget();
        const client = await connect(page.webSocketDebuggerUrl);

        await evaluate(client, "localStorage.setItem('zepp_player_last_project','/projects/" + name + "');location.reload();true");
        await sleep(9000);

        const report = await evaluate(client, `(function(){
            const p = window.player || null;
            const rt = p && p.currentRuntime ? p.currentRuntime : null;
            return JSON.stringify({
                project: p ? p.projectPath : null,
                widgets: rt && rt.widgets ? rt.widgets.length : 0,
                types: rt && rt.widgets ? Array.from(new Set(rt.widgets.map(w => w.config && (w.config.__widget || w.config.type)))) : []
            });
        })()`);

        console.log("smoke report:", report);
        const data = report ? JSON.parse(report) : null;
        if (!data || data.widgets < 1) failed = true;

        client.close();
    } catch (e) {
        console.error("smoke failed:", e.message);
        if (stderr) console.error(stderr.substring(0, 2000));
        failed = true;
    } finally {
        child.kill();
        await sleep(400);
        try { fs.rmSync(userData, {recursive: true, force: true}); } catch (e) {}
        process.exit(failed ? 1 : 0);
    }
})();
