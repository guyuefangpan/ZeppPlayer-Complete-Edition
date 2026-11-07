/*
    Device-side `messaging` / `hmBle` mock that routes to the in-process
    AppSideManager (VirtualLink). When no companion is loaded these are
    harmless no-ops, so legacy app.js keeps working.
*/

export class MessagingMock {
    constructor(runtime) {
        this.runtime = runtime;
        this._listeners = [];

        const peerSocket = {
            _listeners: [],
            addListener(event, cb) {
                if (event !== "message") return;
                if (!this._listeners.includes(cb)) this._listeners.push(cb);
            },
            removeListener(event, cb) {
                if (event !== "message") return;
                this._listeners = this._listeners.filter(l => l !== cb);
            },
            send: (data) => this.send(data),
            __receive: (bytes) => {
                for (const cb of this._listeners.slice()) {
                    try { cb({ data: bytes }); } catch (e) {
                        this.runtime.player.onConsole("error", ["peerSocket listener error", e]);
                    }
                }
                if (typeof this.onmessage === "function") {
                    try { this.onmessage({ data: bytes }); } catch (e) {}
                }
            }
        };
        this.peerSocket = peerSocket;

        // register so companion -> device messages reach this page runtime
        this._receiver = (bytes) => peerSocket.__receive(bytes);
        const mgr = this._manager();
        if (mgr) mgr.registerDeviceReceiver(this._receiver);
    }

    _manager() {
        const p = this.runtime.player;
        return p && p.appSideManager ? p.appSideManager : null;
    }

    get() { return this; }

    send(data) {
        const bytes = this._toBytes(data);
        const mgr = this._manager();
        if (!mgr) return;
        if (!mgr.enabled) return;
        mgr.injectFromDevice(bytes);
    }

    _toBytes(data) {
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (typeof data === "string") return new TextEncoder().encode(data);
        return new Uint8Array(new TextEncoder().encode(JSON.stringify(data)));
    }

    dispose() {
        const mgr = this._manager();
        if (mgr) mgr.unregisterDeviceReceiver(this._receiver);
        this._receiver = null;
    }
}