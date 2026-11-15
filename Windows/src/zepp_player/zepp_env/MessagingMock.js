/*
    Device-side `messaging` / `hmBle` mock that routes to the in-process
    AppSideManager (VirtualLink). When no companion is loaded these are
    harmless no-ops, so legacy app.js keeps working.
*/

export class MessagingMock {
    constructor(runtime) {
        this.runtime = runtime;

        /* ZeppOS exposes `messaging.peerSocket.addListener("message", cb)`.
         * The list lives on the socket itself; keeping it in a local variable
         * avoids `this` binding mistakes between the mock and the socket. */
        const messageListeners = [];

        const peerSocket = {
            _listeners: messageListeners,
            addListener(event, cb) {
                if (event !== "message") return;
                if (!messageListeners.includes(cb)) messageListeners.push(cb);
            },
            removeListener(event, cb) {
                if (event !== "message") return;
                const index = messageListeners.indexOf(cb);
                if (index !== -1) messageListeners.splice(index, 1);
            },
            send: (data) => this.send(data),
            __receive: (bytes) => {
                /* ZeppOS delivers `{ data: ArrayBuffer }`; hand out a standalone
                 * buffer so slicing / Buffer.from() on the app side is safe. */
                const buffer = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
                    ? bytes.buffer
                    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                for (const cb of messageListeners.slice()) {
                    try { cb({ data: buffer }); } catch (e) {
                        this.runtime.player.onConsole("error", ["peerSocket listener error", e]);
                    }
                }
                if (typeof peerSocket.onmessage === "function") {
                    try { peerSocket.onmessage({ data: buffer }); } catch (e) {}
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
        /* When the companion is still booting the manager keeps the packet in
         * its backlog instead of dropping it. */
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