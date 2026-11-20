/*
    ZeppPlayer - ZeppOS, mostly Mi Band 7, simulator for PC
    Copyright (C) 2022  MelianMiko

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

export class HuamiBLEMock {
    constructor(runtime) {
        this.runtime = runtime;
        this._receiver = null;

        /* Legacy `hmBle` traffic is routed to the in-process companion, the
         * same VirtualLink `messaging.peerSocket` uses. */
        const mgr = this._manager();
        if(mgr && typeof mgr.registerDeviceReceiver === "function") {
            this._bound = (bytes) => {
                if(!this._receiver) return;
                try {
                    /* The device API hands out a standalone ArrayBuffer. */
                    const buffer = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
                        ? bytes.buffer
                        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                    this._receiver(0, buffer, bytes.byteLength);
                } catch(e) {}
            };
            mgr.registerDeviceReceiver(this._bound);
        }
    }

    _manager() {
        const p = this.runtime && this.runtime.player;
        return p && p.appSideManager ? p.appSideManager : null;
    }

    createConnect(cb) {
        this._receiver = cb;
    }

    disConnect() {
        this._receiver = null;
    }

    send(data, length) {
        const mgr = this._manager();
        if(!mgr) return;

        let bytes;
        if(data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data, 0, length === undefined ? data.byteLength : length);
        } else if(data && data.buffer instanceof ArrayBuffer) {
            const len = length === undefined ? data.byteLength : length;
            bytes = new Uint8Array(data.buffer, data.byteOffset || 0, len);
        } else {
            return;
        }

        mgr.injectFromDevice(bytes);
    }

    connectStatus() {
        /* The companion (app-side service) is the phone of the simulator, so a
         * running companion means the BLE link is up. */
        const mgr = this._manager();
        if(mgr && mgr.status === "running") return true;
        if(this.runtime && typeof this.runtime.getDeviceState === "function")
            return !this.runtime.getDeviceState("DISCONNECT", "boolean");
        return true;
    }

    addListener(event, cb) {
        if(event === "message") this._receiver = cb;
    }

    removeListener() {}

    /**
     * Unregisters the companion -> device receiver. Without this every page
     * runtime left a closure inside AppSideManager.deviceReceivers, so after a
     * few page switches a single reply was delivered many times over.
     */
    dispose() {
        const mgr = this._manager();
        if(mgr && this._bound) {
            mgr.unregisterDeviceReceiver(this._bound);
            this._bound = null;
        }
        this._receiver = null;
    }
}