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

import { BaseWidget } from "./BaseWidget.ts";
import { TextWidget } from "./TextWidget.ts";
import { zeppColorToHex } from "../../Utils.js";

/* A wheel only starts to scroll after this many pixels, shorter movements
 * are treated as a tap (same rule as SCROLL_LIST). */
const DRAG_START = 6;

function num(value, fallback) {
    if (typeof value === "number" && isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && isFinite(Number(value))) {
        return Number(value);
    }
    return fallback;
}

function int(value, fallback) {
    const parsed = num(value, null);
    return parsed === null ? fallback : Math.round(parsed);
}

function clamp(value, min, max) {
    if (min > max) return min;
    return Math.min(max, Math.max(min, value));
}

function safeCall(fn, ...args) {
    if (typeof fn !== "function") return;
    try {
        fn(...args);
    } catch (e) {
        console.warn("[ZeppPlayer] widget callback failed", e);
    }
}

function screenSize(runtime) {
    if (runtime && Array.isArray(runtime.screen) && runtime.screen.length >= 2) return runtime.screen;
    if (runtime && runtime.player && Array.isArray(runtime.player.screen)) return runtime.player.screen;
    return [480, 480];
}

function colorHex(value, fallback) {
    return zeppColorToHex(value === undefined || value === null ? fallback : value);
}

function daysInMonth(year, month) {
    const days = new Date(year, month, 0).getDate();
    return isFinite(days) && days > 0 ? days : 28;
}

function range(start, end) {
    const out = [];
    for (let i = start; i <= end; i++) out.push(i);
    return out;
}

function pointIn(rect, x, y) {
    if (!rect) return false;
    return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];
}

function fillRoundRect(ctx, x, y, w, h, radius, fillStyle) {
    if (!(w > 0) || !(h > 0)) return;
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    ctx.lineTo(x + w, y + h - r);
    ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(x, y + r);
    ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
    ctx.restore();
}

async function createTextLayer(runtime, text, size, color, alignH) {
    return await TextWidget.drawText({
        text: text === undefined || text === null ? "" : String(text),
        text_size: Math.max(1, Math.round(size)),
        color: color === undefined || color === null ? 0xffffff : color,
        char_space: 0,
        line_space: 0,
        align_h: alignH || "center_h",
        align_v: "top"
    }, runtime);
}

/**
 * Shared implementation for the wheel style widgets: PICKER, PICK_DATE and
 * TIME_PICKER. A subclass provides the columns (`_columns()`), the initial
 * selection (`_initState()`) and the callbacks.
 */
class WheelWidgetBase extends BaseWidget {
    constructor(config) {
        super(config);

        this.__stateReady = false;
        this.columns = [];
        this.selected = [];
        this.currentColumn = 0;

        this.isMouseDown = false;
        this.moved = false;
        this.dragDelta = 0;
        this.dragColumn = -1;
        this.startX = 0;
        this.startY = 0;

        this._geom = null;
        this._doneRect = null;
        this._donePressed = false;

        this.addEventListener("onmousedown", (e) => this._eventDown(e));
        this.addEventListener("onmousemove", (e) => this._eventMove(e));
        this.addEventListener("onmouseup", (e) => this._eventUp(e));
    }

    _ensureState() {
        if (this.__stateReady) return;
        this.columns = [];
        this.selected = [];
        this.currentColumn = 0;
        this._initState();
        this.__stateReady = true;
    }

    _initState() {}

    _columns() {
        this._ensureState();
        return this.columns;
    }

    _notify() {}

    _onFocus() {}

    _onDone() {}

    _afterChange() {
        return [];
    }

    _showHeader() {
        return true;
    }

    _defaultBackground() {
        return undefined;
    }

    _refresh(mode) {
        if (this.runtime) this.runtime.refresh_required = mode || "set_prop";
    }

    _box(sw, sh) {
        return {
            x: num(this.config.x, 0),
            y: num(this.config.y, 0),
            w: num(this.config.w, sw),
            h: num(this.config.h, sh)
        };
    }

    _geometry(runtime) {
        const [sw, sh] = screenSize(runtime);
        const box = this._box(sw, sh) || {};

        const w = Math.max(1, Math.round(num(box.w, sw)));
        const h = Math.max(1, Math.round(num(box.h, sh)));
        const headerH = this._showHeader() ? Math.min(72, Math.round(h * 0.18)) : 0;

        return {
            screenW: sw,
            screenH: sh,
            x: Math.round(num(box.x, 0)),
            y: Math.round(num(box.y, 0)),
            w,
            h,
            headerH,
            localCenterY: headerH + (h - headerH) / 2
        };
    }

    _rowHeight() {
        if (!this._geom) return 48;

        let size = 0;
        for (const col of this._columns()) {
            size = Math.max(size, num(col.select_font_size, num(col.font_size, 36)));
        }

        const rowHeight = Math.max(30, Math.round(size * 1.35));
        return Math.min(rowHeight, Math.max(20, Math.round(this._geom.h / 3)));
    }

    _columnWidths(geo, columns) {
        const fallback = geo.w / Math.max(1, columns.length);
        return columns.map((col) => {
            const width = num(col.col_width, 0);
            return width > 0 ? width : fallback;
        });
    }

    _columnGaps(geo, columns) {
        return columns.map(() => 0);
    }

    _columnLayout(geo, columns) {
        const widths = this._columnWidths(geo, columns);
        const gaps = this._columnGaps(geo, columns);

        let total = 0;
        for (let i = 0; i < widths.length; i++) {
            total += widths[i] + (gaps[i] || 0);
        }

        const scale = total > geo.w ? geo.w / total : 1;
        let cursor = (geo.w - total * scale) / 2;

        return columns.map((col, i) => {
            const width = Math.max(1, widths[i] * scale);
            const gap = (gaps[i] || 0) * scale;
            const item = { col, x: cursor, w: width, gap };
            cursor += width + gap;
            return item;
        });
    }

    async render(canvas, runtime) {
        this._ensureState();

        const geo = this._geometry(runtime);
        this._geom = geo;
        this._doneRect = null;
        this._donePressed = false;

        const view = runtime.newCanvas();
        view.width = geo.w;
        view.height = geo.h;
        const ctx = view.getContext("2d");

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, geo.w, geo.h);
        ctx.clip();

        const bg = this.config.bg_color !== undefined
            ? this.config.bg_color : this._defaultBackground(geo);
        if (bg !== undefined && bg !== null) {
            ctx.fillStyle = colorHex(bg, 0x000000);
            ctx.fillRect(0, 0, geo.w, geo.h);
        }

        const columns = this._columns();
        const layout = this._columnLayout(geo, columns);
        const rowHeight = this._rowHeight();
        const centerY = geo.localCenterY;

        const bandHeight = Math.max(24, Math.round(rowHeight * 1.02));
        fillRoundRect(ctx, 8, centerY - bandHeight / 2, geo.w - 16, bandHeight, 10,
            colorHex(this.config.select_bg_color, 0x1f1f1f));

        await this._drawHeader(ctx, geo, runtime);
        await this._drawColumns(ctx, geo, layout, rowHeight, centerY, runtime);

        ctx.restore();
        canvas.getContext("2d").drawImage(view, geo.x, geo.y);

        this.dropEvents(runtime, [
            geo.x,
            geo.y,
            geo.x + geo.w,
            geo.y + geo.h
        ]);
    }

    async _drawHeader(ctx, geo, runtime) {
        const title = this.config.title;
        if (title !== undefined && title !== null && title !== "") {
            const size = num(this.config.title_size, 24);
            const layer = await createTextLayer(runtime, title, size,
                num(this.config.title_color, 0xffffff), "left");
            const y = Math.max(2, Math.round(geo.headerH / 2 - layer.height / 2 - 4));
            ctx.drawImage(layer, Math.round((geo.w - layer.width) / 2), y);
        }

        const subtitle = this.config.subtitle;
        if (subtitle !== undefined && subtitle !== null && subtitle !== "") {
            const size = num(this.config.subtitle_size, 16);
            const layer = await createTextLayer(runtime, subtitle, size,
                num(this.config.subtitle_color, 0x9a9a9a), "left");
            ctx.drawImage(layer, Math.round((geo.w - layer.width) / 2),
                Math.round(geo.headerH / 2 + 2));
        }

        let drawn = false;
        if (this.config.done_icon) {
            try {
                const img = await runtime.getAssetImage(this.config.done_icon);
                if (img && img.width > 0) {
                    const x = geo.w - img.width - 12;
                    const y = 12;
                    ctx.drawImage(img, x, y);
                    this._doneRect = [x, y, x + img.width, y + img.height];
                    drawn = true;
                }
            } catch (e) {
                drawn = false;
            }
        }

        if (!drawn) {
            const cx = geo.w - 30;
            const cy = 24;
            this._drawDoneGlyph(ctx, cx, cy);
            this._doneRect = [cx - 16, cy - 16, cx + 16, cy + 16];
        }
    }

    _drawDoneGlyph(ctx, cx, cy) {
        ctx.save();
        ctx.strokeStyle = colorHex(this.config.done_color, 0xffffff);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 13, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 6, cy);
        ctx.lineTo(cx - 1, cy + 5);
        ctx.lineTo(cx + 7, cy - 6);
        ctx.stroke();
        ctx.restore();
    }

    async _drawColumns(ctx, geo, layout, rowHeight, centerY, runtime) {
        const dragColumn = this.moved ? this.dragColumn : -1;
        const dragOffset = this.moved ? this.dragDelta : 0;

        for (let ci = 0; ci < layout.length; ci++) {
            const item = layout[ci];
            const col = item.col || {};
            const values = Array.isArray(col.values) ? col.values : [];
            const count = values.length;
            if (count === 0) continue;

            const selected = clamp(int(this.selected[ci], 0), 0, count - 1);
            const loop = !!col.support_loop;
            const offset = ci === dragColumn ? dragOffset : 0;

            const fontSize = Math.max(10, num(col.font_size, 28));
            const selectFontSize = Math.max(fontSize, num(col.select_font_size, fontSize));
            const normalColor = col.normal_color !== undefined
                ? col.normal_color : num(this.config.normal_color, 0x9a9a9a);
            const selectColor = col.select_color !== undefined
                ? col.select_color : num(this.config.select_color, 0xffffff);

            for (let k = -2; k <= 2; k++) {
                let index = selected + k;
                if (index < 0 || index >= count) {
                    if (!loop) continue;
                    index = ((index % count) + count) % count;
                }

                const isSelected = k === 0;
                const size = isSelected ? selectFontSize : fontSize;
                const color = isSelected ? selectColor : normalColor;

                const valueLayer = await createTextLayer(runtime, values[index], size, color, "left");

                let unitLayer = null;
                if (isSelected && col.unit !== undefined && col.unit !== null && String(col.unit) !== "") {
                    unitLayer = await createTextLayer(runtime, String(col.unit),
                        num(col.unit_font_size, Math.max(12, fontSize * 0.6)), color, "left");
                }

                const totalWidth = valueLayer.width + (unitLayer ? unitLayer.width + 4 : 0);
                const px = item.x + Math.max(0, (item.w - totalWidth) / 2);
                const rowY = centerY + k * rowHeight + offset;

                ctx.save();
                ctx.globalAlpha = isSelected ? 1 : (Math.abs(k) === 1 ? 0.72 : 0.42);
                ctx.drawImage(valueLayer, Math.round(px), Math.round(rowY - valueLayer.height / 2));
                if (unitLayer) {
                    ctx.drawImage(unitLayer, Math.round(px + valueLayer.width + 4),
                        Math.round(rowY - unitLayer.height / 2));
                }
                ctx.restore();
            }

            const connector = col.connector;
            if (connector !== undefined && connector !== null && String(connector) !== ""
                && item.gap >= 8) {
                const layer = await createTextLayer(runtime, String(connector),
                    num(col.connector_font_size, Math.max(12, fontSize * 0.6)),
                    num(this.config.normal_color, 0x9a9a9a), "left");
                ctx.drawImage(layer, Math.round(item.x + item.w + (item.gap - layer.width) / 2),
                    Math.round(centerY - layer.height / 2));
            }
        }
    }

    _localPoint(e) {
        const geo = this._geom;
        if (!geo) return { x: 0, y: 0 };

        const offsetX = num(this.config.__eventOffsetX, 0);
        const offsetY = num(this.config.__eventOffsetY, 0);
        const scroll = this.runtime && this.runtime.player && this.runtime.player.config
            ? num(this.runtime.player.config.renderScroll, 0) : 0;

        return {
            x: num(e && e.x, 0) - geo.x - offsetX,
            y: num(e && e.y, 0) + scroll - geo.y - offsetY
        };
    }

    _columnAt(localX) {
        if (!this._geom) return -1;

        const layout = this._columnLayout(this._geom, this._columns());
        for (let i = 0; i < layout.length; i++) {
            const item = layout[i];
            if (localX >= item.x - 2 && localX <= item.x + item.w + (item.gap || 0) + 2) {
                return i;
            }
        }
        return -1;
    }

    _setIndex(columnIndex, index) {
        const columns = this._columns();
        const col = columns[columnIndex];
        if (!col) return;

        const values = Array.isArray(col.values) ? col.values : [];
        const count = values.length;
        if (count === 0) return;

        const current = clamp(int(this.selected[columnIndex], 0), 0, count - 1);
        let next;
        if (col.support_loop) {
            next = ((int(index, current) % count) + count) % count;
        } else {
            next = clamp(int(index, current), 0, count - 1);
        }

        if (next === current) return;
        this.selected[columnIndex] = next;

        const extras = this._afterChange(columnIndex) || [];
        this._notify(columnIndex);
        for (const extra of extras) {
            if (extra !== columnIndex) this._notify(extra);
        }
    }

    _eventDown(e) {
        if (!this._geom) return;

        this.isMouseDown = true;
        this.moved = false;
        this.dragDelta = 0;
        this.startX = num(e && e.x, 0);
        this.startY = num(e && e.y, 0);

        const point = this._localPoint(e);
        this._donePressed = pointIn(this._doneRect, point.x, point.y);

        const column = this._columnAt(point.x);
        this.dragColumn = column >= 0 ? column : this.currentColumn;

        if (column >= 0 && column !== this.currentColumn) {
            this.currentColumn = column;
            this._onFocus(column);
        }
    }

    _eventMove(e) {
        if (!this.isMouseDown) return;

        const dy = num(e && e.y, this.startY) - this.startY;
        if (!this.moved && Math.abs(dy) < DRAG_START) return;

        this.moved = true;
        this.dragDelta = dy;
        this._refresh("scroll");
    }

    _eventUp(e) {
        if (!this.isMouseDown) return;
        this.isMouseDown = false;

        const geo = this._geom;
        if (!geo) return;

        const dy = num(e && e.y, this.startY) - this.startY;
        const point = this._localPoint(e);
        const donePressed = this._donePressed;
        this._donePressed = false;

        if (donePressed && pointIn(this._doneRect, point.x, point.y)) {
            this.moved = false;
            this.dragDelta = 0;
            this._onDone();
            this._refresh("set_prop");
            return;
        }

        if (this.moved && Math.abs(dy) >= DRAG_START) {
            const rowHeight = this._rowHeight();
            let steps = Math.round(dy / rowHeight);
            if (steps === 0) steps = dy > 0 ? 1 : -1;

            const column = this.dragColumn >= 0 ? this.dragColumn : this.currentColumn;
            this.moved = false;
            this.dragDelta = 0;
            this._setIndex(column, num(this.selected[column], 0) - steps);
            this._refresh("scroll");
            return;
        }

        this.moved = false;
        this.dragDelta = 0;

        if (point.y < geo.headerH) {
            this._refresh("scroll");
            return;
        }

        const column = this._columnAt(point.x);
        const columnIndex = column >= 0 ? column : this.currentColumn;
        if (column >= 0) this.currentColumn = column;

        const rowHeight = this._rowHeight();
        const step = clamp(Math.round((point.y - geo.localCenterY) / rowHeight), -3, 3);
        if (step !== 0) {
            this._setIndex(columnIndex, num(this.selected[columnIndex], 0) + step);
        }

        this._refresh("scroll");
    }
}

/**
 * hmUI.widget.WIDGET_PICKER
 *
 * Multi column wheel selector.
 */
export class PickerWidget extends WheelWidgetBase {
    _initState() {
        const dataConfig = Array.isArray(this.config.data_config) ? this.config.data_config : [];
        const limit = clamp(int(this.config.nb_of_columns, dataConfig.length || 1), 1, 5);
        const count = Math.min(limit, dataConfig.length);

        for (let i = 0; i < count; i++) {
            const raw = dataConfig[i] && typeof dataConfig[i] === "object" ? dataConfig[i] : {};
            const values = Array.isArray(raw.data_array) ? raw.data_array.slice() : [];

            this.columns.push({
                values,
                support_loop: !!raw.support_loop,
                unit: raw.unit,
                connector: raw.connector,
                font_size: num(raw.font_size, 28),
                select_font_size: num(raw.select_font_size, 42),
                unit_font_size: num(raw.unit_font_size, num(raw.font_size, 18)),
                connector_font_size: num(raw.connector_font_size, num(raw.font_size, 18)),
                col_width: num(raw.col_width, 0)
            });
            this.selected.push(clamp(int(raw.init_val_index, 0), 0, Math.max(0, values.length - 1)));
        }

        this.currentColumn = clamp(int(this.config.init_col_index, 0), 0,
            Math.max(0, this.columns.length - 1));
    }

    _box(sw, sh) {
        const w = num(this.config.w, sw);
        const h = num(this.config.h, sh);
        return {
            x: num(this.config.x, 0),
            y: num(this.config.y, 0),
            w: w > 0 ? w : sw,
            h: h > 0 ? h : sh
        };
    }

    _defaultBackground(geo) {
        const coversScreen = geo.w >= geo.screenW * 0.9 && geo.h >= geo.screenH * 0.9;
        return coversScreen ? 0x000000 : undefined;
    }

    _notify(column) {
        safeCall(this.config.picker_cb, this, 2, column, this.selected[column]);
    }

    _onFocus(column) {
        safeCall(this.config.picker_cb, this, 1, column, this.selected[column]);
    }

    _onDone() {
        const column = clamp(this.currentColumn, 0, Math.max(0, this.columns.length - 1));
        safeCall(this.config.picker_cb, this, 2, column, this.selected[column]);
    }

    _applyUpdateData(value) {
        const data = value && typeof value === "object" ? value : {};
        if (this.columns.length === 0) return;

        const column = clamp(int(data.col_index, this.currentColumn), 0, this.columns.length - 1);
        const target = this.columns[column];
        if (!target) return;

        if (Array.isArray(data.data_array)) target.values = data.data_array.slice();

        const maxIndex = Math.max(0, target.values.length - 1);
        const wanted = data.val_index !== undefined
            ? int(data.val_index, this.selected[column])
            : int(this.selected[column], 0);
        this.selected[column] = clamp(wanted, 0, maxIndex);
    }

    getProperty(key, second) {
        this._ensureState();
        const name = String(key === undefined ? "" : key).toLowerCase();

        if (name === "cur_column") return this.currentColumn;
        if (name === "select_index" || name === "selected_index"
            || name === "val_index" || name === "value") {
            return this.selected[this.currentColumn];
        }
        if (name === "select_indexes") return this.selected.slice();

        return super.getProperty(key, second);
    }

    setProperty(prop, val) {
        this._ensureState();
        const name = String(prop === undefined || prop === null ? "" : prop).toLowerCase();

        const isUpdateData = name === "update_data"
            || (name === "more" && val && typeof val === "object" && !Array.isArray(val)
                && (val.col_index !== undefined || Array.isArray(val.data_array)));

        if (isUpdateData) {
            this._applyUpdateData(val);
            this._refresh("set_prop");
            return;
        }

        if (name === "cur_column") {
            this.currentColumn = clamp(int(val, 0), 0, Math.max(0, this.columns.length - 1));
            this._refresh("set_prop");
            return;
        }

        if (name === "select_index" || name === "selected_index"
            || name === "val_index" || name === "value") {
            if (val && typeof val === "object") {
                const column = clamp(int(val.col_index, this.currentColumn), 0,
                    Math.max(0, this.columns.length - 1));
                this.currentColumn = column;
                this._setIndex(column, int(val.val_index, int(val.select_index, this.selected[column])));
            } else {
                this._setIndex(this.currentColumn, int(val, this.selected[this.currentColumn]));
            }
            this._refresh("set_prop");
            return;
        }

        super.setProperty(prop, val);

        if (name === "more" && val && typeof val === "object"
            && (val.data_config !== undefined || val.nb_of_columns !== undefined
                || val.init_col_index !== undefined)) {
            this.__stateReady = false;
        }
    }
}

/**
 * hmUI.widget.PICK_DATE
 *
 * Year / month / day / hour / minute wheel (legacy, pre 3.6 API).
 */
export class PickDateWidget extends WheelWidgetBase {
    _initState() {
        const startYear = int(this.config.startYear, 1970);
        const endYear = Math.max(startYear, int(this.config.endYear, 2100));
        const year = clamp(int(this.config.initYear, 2020), startYear, endYear);
        const month = clamp(int(this.config.initMonth, 1), 1, 12);
        const day = clamp(int(this.config.initDay, 1), 1, daysInMonth(year, month));
        const hour = clamp(int(this.config.initHour, 12), 0, 23);
        const minute = clamp(int(this.config.initMin, 0), 0, 59);

        this.selected = [year - startYear, month - 1, day - 1, hour, minute];
        this.currentColumn = 0;
    }

    _showHeader() {
        return false;
    }

    _box(sw, sh) {
        let width = num(this.config.w, 0);
        if (!(width > sw / 2)) width = 300;
        if (width > sw) width = sw;

        const fontSize = num(this.config.font_size, 36);
        const rowHeight = Math.max(30, Math.round(fontSize * 1.35));
        const defaultHeight = Math.min(sh, rowHeight * 3 + 8);

        let height = num(this.config.h, defaultHeight);
        if (!(height > 0)) height = defaultHeight;
        if (height > sh) height = sh;

        let x = num(this.config.x, 0);
        if (x <= 0) x = Math.max(0, (sw - width) / 2);

        return { x, y: num(this.config.y, 0), w: width, h: height };
    }

    _columns() {
        this._ensureState();

        const startYear = int(this.config.startYear, 1970);
        const endYear = Math.max(startYear, int(this.config.endYear, 2100));
        const year = startYear + clamp(int(this.selected[0], 0), 0, endYear - startYear);
        const month = clamp(int(this.selected[1], 0), 0, 11) + 1;
        const days = daysInMonth(year, month);
        this.selected[2] = clamp(int(this.selected[2], 0), 0, days - 1);

        const fontSize = num(this.config.font_size, 36);
        const selectFontSize = num(this.config.select_font_size, fontSize);
        const makeColumn = (values) => ({
            values,
            font_size: fontSize,
            select_font_size: selectFontSize,
            support_loop: false,
            col_width: 0
        });

        return [
            makeColumn(range(startYear, endYear)),
            makeColumn(range(1, 12)),
            makeColumn(range(1, days)),
            makeColumn(range(0, 23)),
            makeColumn(range(0, 59))
        ];
    }

    _columnWidths(geo, columns) {
        const fontSize = num(this.config.font_size, 36);
        return [fontSize * 2.5, fontSize * 2.0, fontSize * 2.0, fontSize * 2.0, fontSize * 2.0]
            .slice(0, columns.length);
    }

    _columnGaps(geo, columns) {
        return [
            num(this.config.padding_1, 0),
            num(this.config.padding_2, 0),
            0,
            0,
            0
        ].slice(0, columns.length);
    }

    _year() {
        const startYear = int(this.config.startYear, 1970);
        const endYear = Math.max(startYear, int(this.config.endYear, 2100));
        return startYear + clamp(int(this.selected[0], 0), 0, endYear - startYear);
    }

    _month() {
        return clamp(int(this.selected[1], 0), 0, 11) + 1;
    }

    _day() {
        return clamp(int(this.selected[2], 0), 0,
            daysInMonth(this._year(), this._month()) - 1) + 1;
    }

    _hour() {
        return clamp(int(this.selected[3], 0), 0, 23);
    }

    _minute() {
        return clamp(int(this.selected[4], 0), 0, 59);
    }

    _afterChange(column) {
        if (column === 0 || column === 1) {
            const days = daysInMonth(this._year(), this._month());
            const dayIndex = clamp(int(this.selected[2], 0), 0, days - 1);
            if (dayIndex !== this.selected[2]) {
                this.selected[2] = dayIndex;
                return [2];
            }
        }
        return [];
    }

    _notify(column) {
        safeCall(this.config.picker_cb, this, 2, column, this.selected[column]);
    }

    _onDone() {
        safeCall(this.config.picker_cb, this, 2, this.currentColumn,
            this.selected[this.currentColumn]);
    }

    _values() {
        return {
            year: this._year(),
            month: this._month(),
            day: this._day(),
            hour: this._hour(),
            minute: this._minute()
        };
    }

    _applyValue(name, value) {
        const number = int(value, null);
        if (number === null) return;

        const map = { year: 0, month: 1, day: 2, hour: 3, minute: 4 };
        let index = number;
        if (name === "year") index = number - int(this.config.startYear, 1970);
        if (name === "month" || name === "day") index = number - 1;

        this._setIndex(map[name], index);
    }

    getProperty(key, second) {
        this._ensureState();
        const name = String(key === undefined ? "" : key).toLowerCase();

        if (name === "more") return this._values();
        if (["year", "month", "day", "hour", "minute"].indexOf(name) > -1) {
            return this._values()[name];
        }

        return super.getProperty(key, second);
    }

    setProperty(prop, val) {
        this._ensureState();
        const name = String(prop === undefined || prop === null ? "" : prop).toLowerCase();

        if (["year", "month", "day", "hour", "minute"].indexOf(name) > -1) {
            this._applyValue(name, val);
            this._refresh("set_prop");
            return;
        }

        super.setProperty(prop, val);

        if (name === "more" || ["startyear", "endyear", "inityear", "initmonth", "initday",
            "inithour", "initmin", "font_size", "select_font_size"].indexOf(name) > -1) {
            this.__stateReady = false;
        }
    }
}

/**
 * hmUI.widget.WIDGET_TIME_PICKER
 *
 * Full screen time (type 0) or date (type 1) picker.
 */
export class TimePickerWidget extends WheelWidgetBase {
    _isDateType() {
        return int(this.config.type, 0) === 1;
    }

    _initState() {
        if (this._isDateType()) {
            const startYear = int(this.config.startYear, 1970);
            const endYear = Math.max(startYear, int(this.config.endYear, 2100));
            const year = clamp(int(this.config.initYear, 2020), startYear, endYear);
            const month = clamp(int(this.config.initMonth, 1), 1, 12);
            const day = clamp(int(this.config.initDay, 1), 1, daysInMonth(year, month));

            this.selected = [year - startYear, month - 1, day - 1];
        } else {
            this.selected = [
                clamp(int(this.config.initHour, 12), 0, 23),
                clamp(int(this.config.initMin, 0), 0, 59)
            ];
        }
        this.currentColumn = 0;
    }

    _box(sw, sh) {
        const x = num(this.config.x, 0);
        const y = num(this.config.y, 0);
        const w = num(this.config.w, sw - x);
        const h = num(this.config.h, sh - y);

        return {
            x,
            y,
            w: w > 0 ? w : sw - x,
            h: h > 0 ? h : sh - y
        };
    }

    _defaultBackground(geo) {
        const coversScreen = geo.w >= geo.screenW * 0.9 && geo.h >= geo.screenH * 0.9;
        return coversScreen ? 0x000000 : undefined;
    }

    _columns() {
        this._ensureState();

        const fontSize = num(this.config.font_size, 36);
        const selectFontSize = num(this.config.select_font_size, 48);
        const makeColumn = (values, loop) => ({
            values,
            font_size: fontSize,
            select_font_size: selectFontSize,
            support_loop: !!loop,
            col_width: 0
        });

        if (this._isDateType()) {
            const startYear = int(this.config.startYear, 1970);
            const endYear = Math.max(startYear, int(this.config.endYear, 2100));
            const year = startYear + clamp(int(this.selected[0], 0), 0, endYear - startYear);
            const month = clamp(int(this.selected[1], 0), 0, 11) + 1;
            const days = daysInMonth(year, month);
            this.selected[2] = clamp(int(this.selected[2], 0), 0, days - 1);

            const columns = [
                makeColumn(range(startYear, endYear), false),
                makeColumn(range(1, 12), false),
                makeColumn(range(1, days), false)
            ];
            columns[0].connector = "-";
            columns[1].connector = "-";
            return columns;
        }

        const columns = [
            makeColumn(range(0, 23), true),
            makeColumn(range(0, 59), true)
        ];
        columns[0].connector = ":";
        return columns;
    }

    _columnWidths(geo, columns) {
        const fontSize = num(this.config.font_size, 36);
        if (this._isDateType()) {
            return [fontSize * 2.6, fontSize * 2.0, fontSize * 2.0].slice(0, columns.length);
        }
        return [fontSize * 2.2, fontSize * 2.2].slice(0, columns.length);
    }

    _columnGaps(geo, columns) {
        const fontSize = num(this.config.font_size, 36);
        if (this._isDateType()) {
            return [fontSize * 0.45, fontSize * 0.45, 0].slice(0, columns.length);
        }
        return [fontSize * 0.5, 0].slice(0, columns.length);
    }

    _year() {
        if (this._isDateType()) {
            const startYear = int(this.config.startYear, 1970);
            const endYear = Math.max(startYear, int(this.config.endYear, 2100));
            return startYear + clamp(int(this.selected[0], 0), 0, endYear - startYear);
        }
        return clamp(int(this.config.initYear, 2020), 1970, 2100);
    }

    _month() {
        if (this._isDateType()) {
            return clamp(int(this.selected[1], 0), 0, 11) + 1;
        }
        return clamp(int(this.config.initMonth, 1), 1, 12);
    }

    _day() {
        if (this._isDateType()) {
            return clamp(int(this.selected[2], 0), 0,
                daysInMonth(this._year(), this._month()) - 1) + 1;
        }
        return clamp(int(this.config.initDay, 1), 1,
            daysInMonth(this._year(), this._month()));
    }

    _hour() {
        if (this._isDateType()) return clamp(int(this.config.initHour, 12), 0, 23);
        return clamp(int(this.selected[0], 12), 0, 23);
    }

    _minute() {
        if (this._isDateType()) return clamp(int(this.config.initMin, 0), 0, 59);
        return clamp(int(this.selected[1], 0), 0, 59);
    }

    _afterChange(column) {
        if (this._isDateType() && (column === 0 || column === 1)) {
            const days = daysInMonth(this._year(), this._month());
            const dayIndex = clamp(int(this.selected[2], 0), 0, days - 1);
            if (dayIndex !== this.selected[2]) {
                this.selected[2] = dayIndex;
                return [2];
            }
        }
        return [];
    }

    _values() {
        return {
            year: this._year(),
            month: this._month(),
            day: this._day(),
            hour: this._hour(),
            minute: this._minute()
        };
    }

    _notify(column) {
        safeCall(this.config.picker_cb, this, 1, column, this.selected[column]);
    }

    _onDone() {
        safeCall(this.config.picker_cb, this, 2, this.currentColumn,
            this.selected[this.currentColumn]);
    }

    _applyValue(name, value) {
        const number = int(value, null);
        if (number === null) return;

        if (this._isDateType()) {
            const map = { year: 0, month: 1, day: 2 };
            if (map[name] === undefined) return;
            let index = number;
            if (name === "year") index = number - int(this.config.startYear, 1970);
            if (name === "month" || name === "day") index = number - 1;
            this._setIndex(map[name], index);
            return;
        }

        if (name === "hour") this._setIndex(0, number);
        if (name === "minute") this._setIndex(1, number);
    }

    getProperty(key, second) {
        this._ensureState();
        const name = String(key === undefined ? "" : key).toLowerCase();

        if (name === "more") return this._values();
        if (["year", "month", "day", "hour", "minute"].indexOf(name) > -1) {
            return this._values()[name];
        }

        return super.getProperty(key, second);
    }

    setProperty(prop, val) {
        this._ensureState();
        const name = String(prop === undefined || prop === null ? "" : prop).toLowerCase();

        if (["year", "month", "day", "hour", "minute"].indexOf(name) > -1) {
            this._applyValue(name, val);
            this._refresh("set_prop");
            return;
        }

        super.setProperty(prop, val);

        if (name === "more" || ["type", "startyear", "endyear", "inityear", "initmonth",
            "initday", "inithour", "initmin", "font_size", "select_font_size"].indexOf(name) > -1) {
            this.__stateReady = false;
        }
    }
}

/**
 * hmUI.widget.KEYBOARD
 *
 * Free form key grid. Key positions come from `key_attr`; when it is missing
 * a default numeric pad is generated.
 */
export class KeyboardWidget extends BaseWidget {
    constructor(config) {
        super(config);

        this.text = config.text !== undefined && config.text !== null ? String(config.text) : "";
        this.keys = [];
        this.__keysReady = false;
        this.__keyScreen = null;
        this.pressedId = null;

        this.addEventListener("onmousedown", (e) => this._eventDown(e));
        this.addEventListener("onmouseup", (e) => this._eventUp(e));
    }

    _refresh(mode) {
        if (this.runtime) this.runtime.refresh_required = mode || "set_prop";
    }

    _parseCoord(value, total, fallback) {
        if (typeof value === "number" && isFinite(value)) return value;
        if (typeof value === "string") {
            const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(px|vh|vw|%)?$/);
            if (match) {
                const number = parseFloat(match[1]);
                if (match[2] === "vh" || match[2] === "vw" || match[2] === "%") {
                    return number * total / 100;
                }
                return number;
            }
        }
        return fallback;
    }

    _normalizeKey(raw, index, sw, sh) {
        const size = num(this.config.key_size, 64);
        return {
            id: raw.id !== undefined && raw.id !== null ? raw.id : index,
            x: this._parseCoord(raw.x, sw, 0),
            y: this._parseCoord(raw.y, sh, 0),
            w: num(raw.w, size),
            h: num(raw.h, size),
            text: raw.text !== undefined && raw.text !== null ? String(raw.text) : "",
            image: raw.image,
            value: raw.value !== undefined ? raw.value : index
        };
    }

    _ensureKeys(sw, sh) {
        if (this.__keysReady && this.__keyScreen
            && this.__keyScreen[0] === sw && this.__keyScreen[1] === sh) {
            return;
        }

        const list = Array.isArray(this.config.key_attr) ? this.config.key_attr : [];
        this.keys = [];

        if (list.length > 0) {
            for (let i = 0; i < list.length; i++) {
                const raw = list[i] && typeof list[i] === "object" ? list[i] : null;
                if (!raw) continue;
                this.keys.push(this._normalizeKey(raw, i, sw, sh));
            }
        } else {
            const size = 64;
            const gap = 12;
            const startX = 12;
            const startY = 56;

            for (let i = 1; i <= 10; i++) {
                const digit = i % 10;
                const slot = i - 1;
                const column = slot % 3;
                const row = Math.floor(slot / 3);
                const x = digit === 0 ? startX + size + gap : startX + column * (size + gap);
                const y = startY + row * (size + gap);

                this.keys.push({
                    id: slot,
                    x,
                    y,
                    w: size,
                    h: size,
                    text: String(digit),
                    image: undefined,
                    value: digit
                });
            }
        }

        this.__keysReady = true;
        this.__keyScreen = [sw, sh];
    }

    async render(canvas, runtime) {
        const [sw, sh] = screenSize(runtime);
        this._ensureKeys(sw, sh);

        const ctx = canvas.getContext("2d");
        const baseX = num(this.config.x, 0);
        const baseY = num(this.config.y, 0);

        const style = this.config.text_style && typeof this.config.text_style === "object"
            ? this.config.text_style : {};

        if (style.show !== false) {
            const textX = baseX + num(style.x, 0);
            const textW = num(style.w, sw - num(style.x, 0));
            const size = num(this.config.text_size, 28);
            const color = style.color !== undefined ? style.color : 0xffffff;
            const layer = await createTextLayer(runtime, this.text, size, color, "left");
            const px = textW > 0 ? textX + Math.max(0, (textW - layer.width) / 2) : textX;

            ctx.save();
            if (style.alpha !== undefined && style.alpha !== null) {
                ctx.globalAlpha = clamp(num(style.alpha, 255), 0, 255) / 255;
            }
            ctx.drawImage(layer, Math.round(px), Math.round(baseY + 8));
            ctx.restore();
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const key of this.keys) {
            const kx = baseX + key.x;
            const ky = baseY + key.y;
            const kw = Math.max(1, key.w);
            const kh = Math.max(1, key.h);

            minX = Math.min(minX, key.x);
            minY = Math.min(minY, key.y);
            maxX = Math.max(maxX, key.x + kw);
            maxY = Math.max(maxY, key.y + kh);

            const pressed = this.pressedId !== null && this.pressedId === key.id;
            fillRoundRect(ctx, kx, ky, kw, kh, Math.min(10, kw / 4),
                colorHex(pressed ? this.config.key_press_color : this.config.key_color,
                    pressed ? 0x555555 : 0x2b2b2b));

            let imageDrawn = false;
            if (key.image) {
                try {
                    const img = await runtime.getAssetImage(key.image);
                    if (img && img.width > 0) {
                        ctx.drawImage(img,
                            Math.round(kx + (kw - img.width) / 2),
                            Math.round(ky + (kh - img.height) / 2));
                        imageDrawn = true;
                    }
                } catch (e) {
                    imageDrawn = false;
                }
            }

            if (!imageDrawn && key.text !== "") {
                const layer = await createTextLayer(runtime, key.text,
                    num(this.config.key_text_size, 28),
                    num(this.config.key_text_color, 0xffffff), "left");
                ctx.drawImage(layer,
                    Math.round(kx + (kw - layer.width) / 2),
                    Math.round(ky + (kh - layer.height) / 2));
            }
        }

        if (!isFinite(minX)) {
            minX = 0;
            minY = 0;
            maxX = sw;
            maxY = sh;
        }
        minY = Math.min(minY, 0);

        this.dropEvents(runtime, [
            baseX + minX,
            baseY + minY,
            baseX + maxX,
            baseY + maxY
        ]);
    }

    _localPoint(e) {
        const offsetX = num(this.config.__eventOffsetX, 0);
        const offsetY = num(this.config.__eventOffsetY, 0);
        const scroll = this.runtime && this.runtime.player && this.runtime.player.config
            ? num(this.runtime.player.config.renderScroll, 0) : 0;

        return {
            x: num(e && e.x, 0) - num(this.config.x, 0) - offsetX,
            y: num(e && e.y, 0) + scroll - num(this.config.y, 0) - offsetY
        };
    }

    _keyAt(x, y) {
        for (const key of this.keys) {
            if (x >= key.x && x <= key.x + key.w && y >= key.y && y <= key.y + key.h) {
                return key;
            }
        }
        return null;
    }

    _eventDown(e) {
        const point = this._localPoint(e);
        const key = this._keyAt(point.x, point.y);
        this.pressedId = key ? key.id : null;
        this._refresh("set_prop");
    }

    _eventUp(e) {
        const point = this._localPoint(e);
        const key = this._keyAt(point.x, point.y);
        const pressed = this.pressedId;
        this.pressedId = null;
        this._refresh("set_prop");

        if (key && pressed !== null && key.id === pressed) {
            safeCall(this.config.click_func, this, key.id, key.value);
        }
    }

    _findKeyById(id) {
        for (const key of this.keys) {
            if (key.id === id) return key;
        }
        return null;
    }

    _applyKeyParams(value) {
        const data = value && typeof value === "object" ? value : {};
        let key = this._findKeyById(data.id);
        if (!key) {
            key = {
                id: data.id !== undefined ? data.id : this.keys.length,
                x: 0, y: 0, w: num(this.config.key_size, 64), h: num(this.config.key_size, 64),
                text: "", image: undefined, value: key ? key.value : data.id
            };
            this.keys.push(key);
        }

        if (data.x !== undefined) key.x = this._parseCoord(data.x, 480, key.x);
        if (data.y !== undefined) key.y = this._parseCoord(data.y, 480, key.y);
        if (data.text !== undefined) key.text = data.text === null ? "" : String(data.text);
        if (data.image !== undefined) key.image = data.image;
        if (data.value !== undefined) key.value = data.value;
    }

    getProperty(key, second) {
        const name = String(key === undefined ? "" : key).toLowerCase();

        if (name === "key_para") {
            const found = this._findKeyById(second);
            return found ? { ...found } : undefined;
        }
        if (name === "text") return this.text;
        if (name === "x") return num(this.config.x, 0);
        if (name === "y") return num(this.config.y, 0);
        if (name === "text_style") return this.config.text_style;

        return super.getProperty(key, second);
    }

    setProperty(prop, val) {
        const name = String(prop === undefined || prop === null ? "" : prop).toLowerCase();

        if (name === "add_key") {
            if (val && typeof val === "object") {
                const raw = { ...val };
                const key = this._normalizeKey(raw, this.keys.length, 480, 480);
                const existing = this._findKeyById(key.id);
                if (existing) {
                    Object.assign(existing, key);
                } else {
                    this.keys.push(key);
                }
                this._refresh("set_prop");
            }
            return;
        }

        if (name === "del_key") {
            const id = val && typeof val === "object" ? int(val.id, null) : int(val, null);
            if (id !== null) {
                this.keys = this.keys.filter((key) => key.id !== id);
                this._refresh("set_prop");
            }
            return;
        }

        if (name === "key_para") {
            this._applyKeyParams(val);
            this._refresh("set_prop");
            return;
        }

        if (name === "text_style") {
            this.config.text_style = {
                ...(this.config.text_style && typeof this.config.text_style === "object"
                    ? this.config.text_style : {}),
                ...(val && typeof val === "object" ? val : {})
            };
            this._refresh("set_prop");
            return;
        }

        if (name === "text") {
            this.text = val === undefined || val === null ? "" : String(val);
            this.config.text = this.text;
            this._refresh("set_prop");
            return;
        }

        if (name === "x" || name === "y") {
            this.config[name] = num(val, 0);
            this._refresh("set_prop");
            return;
        }

        if (name === "more" && val && typeof val === "object") {
            for (const field in val) this.config[field] = val[field];
            if (val.key_attr !== undefined) this.__keysReady = false;
            if (val.text !== undefined) {
                this.text = val.text === null ? "" : String(val.text);
            }
            this._refresh("set_prop");
            return;
        }

        super.setProperty(prop, val);
    }
}

/**
 * hmUI.widget.SYSTEM_KEYBOARD (createKeyboard)
 *
 * Full screen overlay keyboard with an input box, QWERTY / numeric keys and
 * delete / confirm actions.
 */
export class SystemKeyboardWidget extends BaseWidget {
    constructor(config) {
        super(config);

        this.inputText = config.text !== undefined && config.text !== null
            ? String(config.text) : "";
        this.keys = [];
        this.pressedId = null;
        this.startX = 0;
        this.startY = 0;
        this.swiping = false;
        this._cancelRect = null;

        this.addEventListener("onmousedown", (e) => this._eventDown(e));
        this.addEventListener("onmousemove", (e) => this._eventMove(e));
        this.addEventListener("onmouseup", (e) => this._eventUp(e));
    }

    _refresh(mode) {
        if (this.runtime) this.runtime.refresh_required = mode || "set_prop";
    }

    _isNumeric() {
        const type = this.config.inputType;
        if (typeof type === "number") return type === 1;
        if (typeof type === "string") return type.toUpperCase() === "NUM";
        return false;
    }

    _layout(sw, sh) {
        const margin = 10;
        const gap = 3;
        const inputY = 22;
        const inputH = 52;
        const top = inputY + inputH + 14;
        const areaBottom = sh - margin - 6;
        const areaWidth = sw - margin * 2;

        const keys = [];
        let id = 0;
        const addKey = (label, value, x, y, w, h, action) => {
            keys.push({ id: id++, label, value, x, y, w, h, action });
        };

        if (this._isNumeric()) {
            const keyW = (areaWidth - 2 * gap) / 3;
            const keyH = Math.max(30, Math.min(64,
                (areaBottom - top - 3 * gap) / 4));
            const totalH = keyH * 4 + gap * 3;
            const startY = top + Math.max(0, (areaBottom - top - totalH) / 2);

            const rows = [
                ["1", "2", "3"],
                ["4", "5", "6"],
                ["7", "8", "9"],
                ["DEL", "0", "OK"]
            ];

            for (let r = 0; r < rows.length; r++) {
                for (let c = 0; c < rows[r].length; c++) {
                    const label = rows[r][c];
                    const x = margin + c * (keyW + gap);
                    const y = startY + r * (keyH + gap);

                    if (label === "DEL") addKey("删除", "DEL", x, y, keyW, keyH, "del");
                    else if (label === "OK") addKey("确定", "OK", x, y, keyW, keyH, "confirm");
                    else addKey(label, label, x, y, keyW, keyH, "char");
                }
            }
        } else {
            const rows = [
                "1234567890".split(""),
                "qwertyuiop".split(""),
                "asdfghjkl".split(""),
                "zxcvbnm".split("")
            ];
            const keyW = (areaWidth - 9 * gap) / 10;
            const keyH = Math.max(24, Math.min(56,
                (areaBottom - top - 4 * gap) / 5));
            const totalH = keyH * 5 + gap * 4;
            const startY = top + Math.max(0, (areaBottom - top - totalH) / 2);

            for (let r = 0; r < rows.length; r++) {
                const row = rows[r];
                const indent = r === 2 ? keyW * 0.5 : (r === 3 ? keyW * 1.5 : 0);

                for (let c = 0; c < row.length; c++) {
                    const value = row[c];
                    const label = r === 0 ? value : value.toUpperCase();
                    addKey(label, value,
                        margin + indent + c * (keyW + gap),
                        startY + r * (keyH + gap),
                        keyW, keyH, "char");
                }
            }

            const bottomY = startY + 4 * (keyH + gap);
            const actionW = Math.min(keyW * 2.4, areaWidth * 0.25);
            const spaceW = Math.max(keyW, areaWidth - actionW * 2 - 2 * gap);

            addKey("删除", "DEL", margin, bottomY, actionW, keyH, "del");
            addKey("空格", " ", margin + actionW + gap, bottomY, spaceW, keyH, "space");
            addKey("确定", "OK", margin + actionW + gap + spaceW + gap, bottomY,
                actionW, keyH, "confirm");
        }

        this.keys = keys;
    }

    async render(canvas, runtime) {
        const [sw, sh] = screenSize(runtime);
        this._layout(sw, sh);

        const ctx = canvas.getContext("2d");

        ctx.save();
        ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
        ctx.fillRect(0, 0, sw, sh);

        const inputX = 14;
        const inputY = 22;
        const inputW = sw - 28;
        const inputH = 52;

        fillRoundRect(ctx, inputX, inputY, inputW, inputH, 10, "rgba(42, 42, 42, 0.96)");

        const shown = this.inputText + "|";
        const textLayer = await createTextLayer(runtime, shown, 26, 0xffffff, "left");

        ctx.save();
        ctx.beginPath();
        ctx.rect(inputX + 10, inputY, inputW - 44, inputH);
        ctx.clip();
        const textX = inputX + 12 + Math.max(0, inputW - 56 - textLayer.width);
        ctx.drawImage(textLayer, Math.round(textX),
            Math.round(inputY + (inputH - textLayer.height) / 2));
        ctx.restore();

        const cancelLayer = await createTextLayer(runtime, "×", 28, 0xcccccc, "left");
        ctx.drawImage(cancelLayer, inputX + inputW - 32,
            Math.round(inputY + (inputH - cancelLayer.height) / 2));
        this._cancelRect = [
            inputX + inputW - 40,
            inputY + 4,
            inputX + inputW - 4,
            inputY + inputH - 4
        ];

        for (const key of this.keys) {
            const pressed = this.pressedId !== null && this.pressedId === key.id;
            fillRoundRect(ctx, key.x, key.y, key.w, key.h, 6,
                pressed ? "#5a5a5a" : "#333333");

            const size = key.action === "char" ? 24 : 20;
            const layer = await createTextLayer(runtime, key.label, size, 0xffffff, "left");
            ctx.drawImage(layer,
                Math.round(key.x + (key.w - layer.width) / 2),
                Math.round(key.y + (key.h - layer.height) / 2));
        }

        ctx.restore();

        this.dropEvents(runtime, [0, 0, sw, sh]);
    }

    _keyAt(x, y) {
        for (const key of this.keys) {
            if (x >= key.x && x <= key.x + key.w && y >= key.y && y <= key.y + key.h) {
                return key;
            }
        }
        return null;
    }

    _eventDown(e) {
        this.startX = num(e && e.x, 0);
        this.startY = num(e && e.y, 0);
        this.swiping = false;

        const key = this._keyAt(this.startX, this.startY);
        this.pressedId = key ? key.id : null;
        this._refresh("set_prop");
    }

    _eventMove(e) {
        if (this.pressedId === null) return;

        const dx = num(e && e.x, this.startX) - this.startX;
        const dy = num(e && e.y, this.startY) - this.startY;
        if (dx > 40 && Math.abs(dx) > Math.abs(dy)) this.swiping = true;
    }

    _eventUp(e) {
        const x = num(e && e.x, this.startX);
        const y = num(e && e.y, this.startY);
        const pressed = this.pressedId;
        this.pressedId = null;

        if (this.swiping) {
            this.swiping = false;
            this._cancel();
            return;
        }

        if (pointIn(this._cancelRect, x, y)) {
            this._cancel();
            return;
        }

        const key = this._keyAt(x, y);
        if (key && pressed !== null && key.id === pressed) {
            this._activate(key);
        } else {
            this._refresh("set_prop");
        }
    }

    _activate(key) {
        if (key.action === "char") {
            if (this.inputText.length < 64) this.inputText += String(key.value);
        } else if (key.action === "space") {
            if (this.inputText.length < 64) this.inputText += " ";
        } else if (key.action === "del") {
            this.inputText = this.inputText.substring(0, Math.max(0, this.inputText.length - 1));
        } else if (key.action === "confirm") {
            this._complete();
            return;
        }

        this._refresh("set_prop");
    }

    _complete() {
        const result = { data: this.inputText };
        this.config.visible = false;
        safeCall(this.config.onComplete, this, result);
        this._refresh("set_prop");
    }

    _cancel() {
        const result = { data: this.inputText };
        this.config.visible = false;
        safeCall(this.config.onCancel, this, result);
        this._refresh("set_prop");
    }

    getProperty(key, second) {
        const name = String(key === undefined ? "" : key).toLowerCase();

        if (name === "text") return this.inputText;
        if (name === "input_type") return this.config.inputType;

        return super.getProperty(key, second);
    }

    setProperty(prop, val) {
        const name = String(prop === undefined || prop === null ? "" : prop).toLowerCase();

        if (name === "text") {
            this.inputText = val === undefined || val === null ? "" : String(val);
            this.config.text = this.inputText;
            this._refresh("set_prop");
            return;
        }

        if (name === "input_type") {
            this.config.inputType = val;
            this._refresh("set_prop");
            return;
        }

        if (name === "show") {
            this.config.visible = val !== false;
            this._refresh("set_prop");
            return;
        }

        if (name === "hide") {
            this.config.visible = false;
            this._refresh("set_prop");
            return;
        }

        if (name === "more" && val && typeof val === "object") {
            for (const field in val) this.config[field] = val[field];
            if (val.text !== undefined) {
                this.inputText = val.text === null ? "" : String(val.text);
            }
            this._refresh("set_prop");
            return;
        }

        super.setProperty(prop, val);
    }
}
