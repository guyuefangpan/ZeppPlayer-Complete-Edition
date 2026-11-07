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

import ZeppPlayer from "./ZeppPlayer.js";
import {CanvasEntry, ImageEntry} from "./types/EnvironmentTypes";
import {DeviceStateFetchType, ListDirectoryResponseEntry} from "./types/PlayerTypes";

export class ChromeZeppPlayer extends ZeppPlayer {
    public rotation: number = 0;
    public _uiOverlayVisible: boolean = false;
    public _htmlRootBlock: HTMLElement = null;
    public uiOverlayPosition: [number, number] = [0, 0];

    async loadFile(path: string, quiet: boolean = false) {
        const resp = await fetch(path);
        if(resp.status !== 200) {
            const message = [
                "Can't fetch script file\nURL:", path
            ];

            if(this.appConfig && this.appConfig.runtime && this.appConfig.runtime.type === 2) {
                message.push("\n\nIn app.json, runtime.type is set to 2.\n" +
                    "Looks like this package is packaged into bytecode \n" +
                    "(*.bin file), and no fallback JS file is provided. \n\n" +
                    "We can't run QuickJS bytecode. and for now there's\n" +
                    "no way to unpack them back into JS.\n\n");
            }

            // Optional files (app-side.js) are probed for existence; missing
            // them is expected and must not be reported as a fatal error.
            if(!quiet) this.onConsole("ZeppPlayerFatalError", message);
            throw new Error(`Can't fetch script file ${path}`);
        }
        return await resp.arrayBuffer();
    }

    set uiOverlayVisible(value: boolean) {
        if(this._htmlRootBlock)
            this._htmlRootBlock.style.cursor = value ? "crosshair": ""
        this._uiOverlayVisible = value;
    }

    async listDirectory(path: string): Promise<ListDirectoryResponseEntry[]> {
        const resp = await fetch(path);
        const html = await resp.text();

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");

        const links = Array.from(doc.getElementsByTagName("a"));

        const content: ListDirectoryResponseEntry[] = [];
        for(let i in links) {
            const name = links[i].innerText;

            content.push({
                name: name,
                type: name.endsWith("/") ? "dir" : "file"
            });
        }

        return content;
    }

    saveDeviceStates() {
        const out: {[id: string]: any} = {};
        for(const type in this.deviceState) {
            out[type] = this.deviceState[type].value;
        }

        try { localStorage.zp_deviceState = JSON.stringify(out); } catch (e) {}
    }

    getEvalAdditionalData(scriptPath: string) {
        return `//# sourceURL=${location.href.substring(0, location.href.length-1)}${scriptPath}`
    }

    setupHTMLEvents(block: HTMLElement) {
        let isMouseDown = false;
        let activePointer: number = null;

        this._htmlRootBlock = block;

        // The canvas is scaled down by CSS on phones; suppress the browser's
        // own touch gestures so dragging on the watch screen works as input.
        (block as HTMLElement).style.touchAction = "none";

        document.documentElement.onkeydown = (e) => {
            if(e.key === "Shift") {
                this.uiOverlayVisible = true;
                if(this.currentRuntime) this.currentRuntime.refresh_required = "uiOverlay";
            }
        }

        document.documentElement.onkeyup = (e) => {
            if(e.key === "Shift") {
                this.uiOverlayVisible = false;
                if(this.currentRuntime) this.currentRuntime.refresh_required = "uiOverlay";
            }
        };

        block.onwheel = (e) => {
            if(this.currentRuntime) {
                if(this.currentRuntime.rootEventHandler.onwheel(e.deltaY))
                    e.preventDefault();
            }
        }

        // Pointer events cover mouse, pen and touch with one code path, so
        // tapping and dragging the watch screen works on phones as well.
        // The runtime is null while a project is loading or after a failed
        // start; touches on the canvas must then be ignored instead of
        // throwing "handleEvent of null" on every tap.
        block.onpointerdown = (e) => {
            e.preventDefault();
            if(!this.currentRuntime) return;
            activePointer = e.pointerId;
            try { block.setPointerCapture(e.pointerId); } catch (err) {}
            const [x, y] = this._fetchCoordinates(e);
            isMouseDown = true;
            this.currentRuntime.handleEvent("onmousedown", x, y, {x, y});
        };

        block.onpointermove = (e) => {
            e.preventDefault();
            const [x, y] = this._fetchCoordinates(e);
            if(isMouseDown && this.currentRuntime && (activePointer === null || e.pointerId === activePointer))
                this.currentRuntime.handleEvent("onmousemove", x, y, {x, y});

            if(this._uiOverlayVisible && this.currentRuntime) {
                const rect = block.getBoundingClientRect();
                this.uiOverlayPosition = [e.clientX - rect.left, e.clientY - rect.top];
                this.currentRuntime.refresh_required = "uiOverlay";
            }
        };

        const finishPointer = (e: PointerEvent) => {
            if(activePointer !== null && e.pointerId !== activePointer) return;
            activePointer = null;
            const [x, y] = this._fetchCoordinates(e);
            if(isMouseDown && this.currentRuntime) this.currentRuntime.handleEvent("onmouseup", x, y, {x, y});
            isMouseDown = false;
        };

        block.onpointerup = finishPointer;
        block.onpointercancel = finishPointer;

        block.oncontextmenu = (e) => {
            // Long-press on a phone would otherwise open the context menu.
            e.preventDefault();
            const [x, y] = this._fetchCoordinates(e);
            console.log("click coords", x, y);
        };
    }

    async render(force=false) {
        const canvas = await super.render(force);

        if(this._uiOverlayVisible && this.currentRuntime) {
            let [x, y] = this.uiOverlayPosition;
            y += this.config.renderScroll;

            const context = canvas.getContext("2d");
            const baseColor = this.getDeviceState("OVERLAY_COLOR", DeviceStateFetchType.string);

            context.save();
            context.lineWidth = 1;

            // Dim BG
            context.globalAlpha = 1;
            context.fillStyle = "rgba(0, 0, 0, 0.5)";
            context.fillRect(0, 0, canvas.width, canvas.height);

            // Baselines
            context.globalAlpha = 0.6;
            context.strokeStyle = baseColor;
            context.beginPath();
            context.setLineDash([]);
            context.moveTo(Math.floor(canvas.width / 2), 0);
            context.lineTo(Math.floor(canvas.width / 2), canvas.height);
            context.moveTo(0, Math.floor(canvas.height / 2));
            context.lineTo(canvas.width, Math.floor(canvas.height / 2));
            context.stroke();

            // Current widget
            context.globalAlpha = 1;
            context.strokeStyle = baseColor;
            for(const widget of this.currentRuntime.widgets) {
                if(!widget.positionInfo) continue;
                const [x1, y1, x2, y2] = widget.positionInfo;
                if(x > x1 && x < x2 && y > y1 && y < y2) {
                    context.beginPath();
                    context.rect(x1,
                        y1 - this.config.renderScroll,
                        x2 - x1,
                        y2 - y1);
                    context.stroke();
                }
            }

            // Current event trigger
            context.strokeStyle = "#0099FF";
            for(let data of this.currentRuntime.events) {
                let hasNoNull = false;
                for(let i in data.events) {
                    if(data.events[i] !== null) {
                        hasNoNull = true;
                        break;
                    }
                }

                if(!hasNoNull) continue;

                const {x1, y1, x2, y2} = data;
                if(x > x1 && x < x2 && y > y1 && y < y2) {
                    context.beginPath();
                    context.rect(x1,
                        y1 - this.config.renderScroll,
                        x2 - x1,
                        y2 - y1);
                    context.stroke();
                    break;
                }
            }

            // Cursor alignment lines
            context.strokeStyle = baseColor;
            context.beginPath();
            context.setLineDash([10, 2]);
            context.moveTo(0, y - this.config.renderScroll);
            context.lineTo(canvas.width, y - this.config.renderScroll);
            context.moveTo(x, 0);
            context.lineTo(x, canvas.height);
            context.stroke();

            // Cursor coordinates
            context.font = "12px monospace";
            context.fillStyle = baseColor;
            const text = `${x}, ${y - this.config.renderScroll}`
            const metrics = context.measureText(text);
            const tx = x > canvas.width / 2 ? x - metrics.width - 6 : x + 6;
            const ty = y - this.config.renderScroll > canvas.height / 2 ? y - 4 : y + 14;
            context.fillText(text, tx, ty - this.config.renderScroll);

            context.restore();
        }

        return canvas;
    }

    newCanvas(): CanvasEntry {
        return document.createElement("canvas") as any;
    }

    _fetchCoordinates(e: MouseEvent) {
        const block = this._htmlRootBlock as HTMLCanvasElement;
        const rect = block.getBoundingClientRect()
        // The canvas keeps its native resolution while CSS may scale it down
        // on phones, so map CSS pixels back into canvas pixels.
        const sx = rect.width > 0 ? block.width / rect.width : 1;
        const sy = rect.height > 0 ? block.height / rect.height : 1;
        let x, y;

        switch(this.rotation) {
            case 90:
                x = (e.clientY - rect.top) * sy;
                y = (rect.width - (e.clientX - rect.left)) * sx;
                break;
            case 180:
                x = (rect.width - (e.clientX - rect.left)) * sx;
                y = (rect.height - (e.clientY - rect.top)) * sy;
                break;
            case 270:
                x = (rect.height - (e.clientY - rect.top)) * sy;
                y = (e.clientX - rect.left) * sx;
                break;
            default:
                x = (e.clientX - rect.left) * sx;
                y = (e.clientY - rect.top) * sy;
        }

        x = Math.min(Math.max(x, 0), Math.max(block.width - 1, 0));
        y = Math.min(Math.max(y, 0), Math.max(block.height - 1, 0));

        return [Math.floor(x), Math.floor(y)];
    }

    _loadPNG(data: ArrayBuffer) {
        return new Promise<ImageEntry>((resolve, reject) => {
            const blob = new Blob( [ data ] );
            const url = URL.createObjectURL( blob );
            const img = document.createElement("img");
            img.onload = () => resolve(img);
            img.onerror = (e) => reject(e);
            img.src = url;
        });
    }
}
