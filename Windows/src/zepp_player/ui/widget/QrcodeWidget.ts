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

import qrcode from "qrcode-generator";
import { BaseWidget } from "./BaseWidget.ts";
import { zeppColorToHex } from "../../Utils.js";

/**
 * hmUI.widget.QRCODE
 *
 * Supported props: content, x, y, w, h, bg_x, bg_y, bg_w, bg_h,
 * color, bg_color
 */
export class QrcodeWidget extends BaseWidget {
    _matrix = null;
    _matrixContent = null;

    _build(content) {
        if (this._matrixContent === content) return this._matrix;

        this._matrix = null;
        this._matrixContent = content;
        if (!content) return null;

        try {
            const qr = qrcode(0, "M");
            qr.addData(content);
            qr.make();
            this._matrix = qr;
        } catch (e) {
            this.runtime.onConsole("SystemWarning", ["QRCODE encode failed", e]);
        }
        return this._matrix;
    }

    async render(canvas, runtime) {
        const config = this.config;
        const ctx = canvas.getContext("2d");

        const x = config.x || 0;
        const y = config.y || 0;
        const w = config.w || 0;
        const h = config.h || 0;

        // White quiet zone painted behind the code.
        const hasBackground = config.bg_w && config.bg_h;
        if (hasBackground) {
            ctx.fillStyle = zeppColorToHex(config.bg_color === undefined ? 0xffffff : config.bg_color);
            ctx.fillRect(config.bg_x || 0, config.bg_y || 0, config.bg_w, config.bg_h);
        }

        const matrix = this._build(config.content === undefined ? "" : String(config.content));
        if (!matrix || !w || !h) {
            this.dropEvents(runtime, [x, y, x + w, y + h]);
            return;
        }

        const count = matrix.getModuleCount();
        if (count < 1) return;

        // Keep modules square: use the smaller of the two dimensions.
        const size = Math.min(w, h);
        const cell = size / count;
        const offsetX = x + (w - size) / 2;
        const offsetY = y + (h - size) / 2;

        ctx.fillStyle = zeppColorToHex(config.color === undefined ? 0x000000 : config.color);
        for (let row = 0; row < count; row++) {
            for (let col = 0; col < count; col++) {
                if (!matrix.isDark(row, col)) continue;
                const px = offsetX + col * cell;
                const py = offsetY + row * cell;
                // +0.5 prevents hairline gaps between neighbouring modules.
                ctx.fillRect(Math.floor(px), Math.floor(py), Math.ceil(cell) + 1, Math.ceil(cell) + 1);
            }
        }

        this.dropEvents(runtime, [x, y, x + w, y + h]);
    }
}
