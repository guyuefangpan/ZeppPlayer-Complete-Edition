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

import {BaseWidget} from "./BaseWidget.ts";
import HuamiUIMock from "../HuamiUI.js";
import {FillRectWidget} from "../DrawingWidgets.js";
import {ImageWidget, MissingWidget} from "../ImagingWidgets.js";
import {TextWidget} from "./TextWidget.ts";

const DRAG_START = 6;

/* Numeric conversion which never treats units ("20vw") as plain numbers. */
function nf(value, fallback) {
    if (typeof value === "number" && isFinite(value)) return value;
    if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value))
        return parseFloat(value);
    return fallback;
}

function clamp(value, min, max) {
    if (max < min) return min;
    return Math.min(max, Math.max(min, value));
}

function mod(value, size) {
    if (!size) return 0;
    return ((value % size) + size) % size;
}

function pageScroll(runtime) {
    const config = runtime && runtime.player && runtime.player.config;
    return config && typeof config.renderScroll === "number" ? config.renderScroll : 0;
}

/* Reference image, scaled into the given box without changing its ratio. */
async function drawImageFit(player, canvas, src, x, y, w, h) {
    if (!src) return;
    const img = await player.getAssetImage(src);
    if (!img) return;

    const nw = img.width ? img.width : 0;
    const nh = img.height ? img.height : 0;

    if (w > 0 && h > 0) {
        const scale = nw > 0 && nh > 0 ? Math.min(w / nw, h / nh) : 1;
        const dw = nw > 0 ? nw * scale : w;
        const dh = nh > 0 ? nh * scale : h;
        ImageWidget.draw(img, canvas, player, {
            x: x + (w - dw) / 2,
            y: y + (h - dh) / 2,
            w: dw,
            h: dh,
            auto_scale: true
        });
    } else {
        ImageWidget.draw(img, canvas, player, {x, y});
    }
}

function drawTextAt(ctx, runtime, config, x, y) {
    try {
        const layer = TextWidget.drawText(config, runtime);
        if (layer) ctx.drawImage(layer, x, y);
    } catch (e) {
        console.warn("List widget text render failed", e);
    }
}

/**
 * hmUI.widget.CYCLE_LIST
 *
 * Vertically looping list of images. Scrolling is endless: the item index is
 * taken modulo `data_size`, so the last item is followed by the first one.
 *
 *   item_bg_color, item_height, data_array (image paths or {src}),
 *   data_size, item_click_func(list, index),
 *   item_focus_change_func(list, index, isFocus)
 */
export class CycleListWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this.scrollY = 0;
        this.innerHeight = 0;
        this.isMouseDown = false;
        this.moved = false;
        this.mouseStartEv = null;
        this.lastScrollY = 0;
        this.focusIndex = -1;

        this.addEventListener("onmousedown", (e) => this.eventDown(e));
        this.addEventListener("onmousemove", (e) => this.eventMove(e));
        this.addEventListener("onmouseup", (e) => this.eventUp(e));
    }

    _data() {
        return Array.isArray(this.config.data_array) ? this.config.data_array : [];
    }

    _count() {
        const data = this._data();
        const size = nf(this.config.data_size, -1);
        if (size > 0) return Math.max(0, Math.min(Math.floor(size), data.length));
        return data.length;
    }

    _step() {
        const height = nf(this.config.item_height, -1);
        if (height > 0) return height;
        return Math.max(1, nf(this.config.h, 1));
    }

    _size() {
        return [
            Math.max(0, Math.round(nf(this.config.w, 0))),
            Math.max(0, Math.round(nf(this.config.h, 0)))
        ];
    }

    _firstIndex() {
        const count = this._count();
        if (!count) return 0;
        return mod(Math.floor(-this.scrollY / this._step()), count);
    }

    _rows() {
        const count = this._count();
        const step = this._step();
        const height = this._size()[1];
        const rows = [];
        if (!count || step <= 0 || height <= 0) return rows;

        const first = Math.floor(-this.scrollY / step);
        const offset = first * step + this.scrollY;
        const limit = Math.ceil(height / step) + count + 1;

        for (let k = 0; k < limit; k++) {
            const top = offset + k * step;
            if (top >= height) break;
            rows.push({index: mod(first + k, count), y: top});
        }
        return rows;
    }

    _indexAt(localY) {
        for (const row of this._rows()) {
            const step = this._step();
            if (localY >= row.y && localY < row.y + step) return row.index;
        }
        return -1;
    }

    async _drawRow(ctx, row, view, runtime, width) {
        const config = this.config;
        const height = this._step();
        const item = this._data()[row.index];
        const src = item && typeof item === "object" ? item.src : item;

        FillRectWidget.draw(view, {
            x: 0,
            y: row.y,
            w: width,
            h: height,
            color: config.item_bg_color === undefined ? 0x000000 : config.item_bg_color,
            radius: nf(config.item_bg_radius, 0)
        }, "fill", runtime);

        if (!src) return;
        try {
            await drawImageFit(runtime, view, src, 0, row.y, width, height);
        } catch (e) {}
    }

    async render(canvas, runtime) {
        const config = this.config;
        const x = nf(config.x, 0);
        const y = nf(config.y, 0);
        const [width, height] = this._size();

        if (width <= 0 || height <= 0) {
            this.dropEvents(runtime, [x, y, x + width, y + height]);
            return;
        }

        const view = runtime.newCanvas();
        view.width = width;
        view.height = height;

        const ctx = view.getContext("2d");
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();

        for (const row of this._rows()) {
            await this._drawRow(ctx, row, view, runtime, width);
        }

        ctx.restore();
        canvas.getContext("2d").drawImage(view, x, y);

        this.dropEvents(runtime, [x, y, x + width, y + height]);
    }

    _updateFocus() {
        const index = this._firstIndex();
        if (index === this.focusIndex) return;
        const previous = this.focusIndex;
        this.focusIndex = index;

        const callback = this.config.item_focus_change_func;
        if (typeof callback !== "function") return;

        if (previous >= 0) callback(this, previous, false);
        callback(this, index, true);
    }

    _handleClick(e) {
        const localY = e.y + pageScroll(this.runtime) - nf(this.config.y, 0);
        const index = this._indexAt(localY);
        if (index < 0) return;

        if (typeof this.config.item_click_func === "function") {
            this.config.item_click_func(this, index);
        }
    }

    eventDown(e) {
        this.mouseStartEv = e;
        this.lastScrollY = this.scrollY;
        this.isMouseDown = true;
        this.moved = false;
    }

    eventMove(e) {
        if (!this.isMouseDown || !this.mouseStartEv) return;

        const dx = e.x - this.mouseStartEv.x;
        const dy = e.y - this.mouseStartEv.y;

        if (!this.moved) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_START) return;
            this.moved = true;
        }

        this.scrollY = this.lastScrollY + dy;
        this.runtime.refresh_required = "scroll";
    }

    eventUp(e) {
        if (!this.isMouseDown) return;
        this.isMouseDown = false;

        const moved = this.moved;
        this.moved = false;

        if (!moved) this._handleClick(e);
        this._updateFocus();

        this.runtime.refresh_required = "scroll";
    }

    getProperty(key, second) {
        if (key === "more") {
            return Object.assign({}, this.config, {index: this._firstIndex()});
        }
        return super.getProperty(key, second);
    }

    setProperty(prop, val) {
        if (prop === "more" && val && typeof val === "object") {
            for (const key in val) this.config[key] = val[key];
            this.scrollY = 0;
            this.focusIndex = -1;
            this.runtime.refresh_required = "set_prop";
            return;
        }

        if (prop === "scroll_to" && val && typeof val === "object") {
            const index = nf(val.index, -1);
            if (index >= 0) this.scrollY = -index * this._step();
            this.runtime.refresh_required = "scroll";
            return;
        }

        super.setProperty(prop, val);
    }
}

/**
 * hmUI.widget.CYCLE_IMAGE_TEXT_LIST
 *
 * Looping list where every item contains an image and a text label.
 *
 *   item_image_x/y, item_text_x/y, item_text_size, item_text_color,
 *   item_text_align_h/v, item_text_width/height, item_bg_color, item_height,
 *   data_array [{src, text}], data_size,
 *   item_click_func(list, index), item_focus_change_func(list, index, isFocus)
 *
 * setProperty("item_more", {index, item_text_color, item_text_size}),
 * setProperty("item_refresh", index), setProperty("list_top", {index})
 */
export class CycleImageTextListWidget extends CycleListWidget {
    constructor(config) {
        super(config);
        this.itemOverrides = Object.create(null);
    }

    async _drawRow(ctx, row, view, runtime, width) {
        const config = this.config;
        const step = this._step();
        const raw = this._data()[row.index];
        const data = raw && typeof raw === "object" ? raw : {text: raw};
        const override = this.itemOverrides[row.index] || {};

        FillRectWidget.draw(view, {
            x: 0,
            y: row.y,
            w: width,
            h: step,
            color: config.item_bg_color === undefined ? 0xffffff : config.item_bg_color,
            radius: nf(config.item_bg_radius, 0)
        }, "fill", runtime);

        if (data && data.src) {
            const ix = nf(config.item_image_x, 0);
            const iy = nf(config.item_image_y, 0);
            const iw = nf(config.item_image_w, 0);
            const ih = nf(config.item_image_h, nf(config.item_image_size, 0));

            try {
                if (iw > 0 || ih > 0) {
                    await drawImageFit(runtime, view, data.src,
                        ix, row.y + iy,
                        iw > 0 ? iw : Math.max(1, width - ix),
                        ih > 0 ? ih : Math.max(1, step - iy));
                } else {
                    const img = await runtime.getAssetImage(data.src);
                    if (img) ImageWidget.draw(img, view, runtime, {x: ix, y: row.y + iy});
                }
            } catch (e) {}
        }

        if (!data || data.text === undefined || data.text === null) return;
        const text = String(data.text);
        if (text === "") return;

        const textX = nf(config.item_text_x, 0);
        const textY = nf(config.item_text_y, 0);

        drawTextAt(ctx, runtime, {
            x: 0,
            y: 0,
            w: Math.max(0, nf(config.item_text_width, width - textX)),
            h: Math.max(0, nf(config.item_text_height, step - textY)),
            text,
            text_size: nf(override.item_text_size, nf(config.item_text_size, 18)),
            color: override.item_text_color !== undefined
                ? override.item_text_color
                : (config.item_text_color === undefined ? 0x000000 : config.item_text_color),
            align_h: config.item_text_align_h ? config.item_text_align_h : "center_h",
            align_v: config.item_text_align_v ? config.item_text_align_v : "center_v",
            char_space: nf(config.char_space, 0),
            line_space: nf(config.line_space, 0)
        }, textX, row.y + textY);
    }

    setProperty(prop, val) {
        if (prop === "item_more" && val && typeof val === "object") {
            const index = nf(val.index, -1);
            if (index >= 0) {
                const override = this.itemOverrides[index] || (this.itemOverrides[index] = {});
                if (val.item_text_color !== undefined) override.item_text_color = val.item_text_color;
                if (val.item_text_size !== undefined) override.item_text_size = val.item_text_size;
            }
            this.runtime.refresh_required = "set_prop";
            return;
        }

        if (prop === "item_refresh") {
            const index = val && typeof val === "object" ? nf(val.index, -1) : nf(val, -1);
            if (index >= 0) delete this.itemOverrides[index];
            this.runtime.refresh_required = "set_prop";
            return;
        }

        if (prop === "list_top") {
            const index = val && typeof val === "object" ? nf(val.index, 0) : nf(val, 0);
            this.scrollY = -Math.max(0, index) * this._step();
            this.runtime.refresh_required = "scroll";
            return;
        }

        super.setProperty(prop, val);
    }
}

/**
 * hmUI.widget.LIST_VIEW
 *
 * Viewport of items created through `listView.createWidget(widget.GROUP, ...)`.
 * Item children are normal widgets, so buttons/switches keep working.
 * Call `init()` once all items are created.
 *
 * Supported: item_space, pos_y, item_click_func(list, index),
 * snap_type/enable_scroll_bar (accepted), and a SCROLL_LIST style fallback
 * (`data_array` + `item_config`) when no item widgets were created.
 */
export class ListViewWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this.items = [];
        this.scrollY = -Math.max(0, nf(config.pos_y, 0));
        this.innerHeight = 0;
        this.isMouseDown = false;
        this.moved = false;
        this.mouseStartEv = null;
        this.lastScrollY = 0;
        this._childCounter = 0;
        this._x = 0;
        this._y = 0;

        this.addEventListener("onmousedown", (e) => this.eventDown(e));
        this.addEventListener("onmousemove", (e) => this.eventMove(e));
        this.addEventListener("onmouseup", (e) => this.eventUp(e));
    }

    createWidget(type, config) {
        let Widget = null;
        try {
            Widget = (new HuamiUIMock())._widget[type];
        } catch (e) {}
        if (!Widget) Widget = MissingWidget;

        if (typeof config !== "object" || config === null) config = {};

        config.__widget = type;
        config.__id = ((nf(this.config.__id, 0) + 1) << 10) + this._childCounter;
        config.__runtime = this.runtime;
        config.__listOwner = true;

        const widget = new Widget(config);
        this._childCounter++;
        this.items.push(widget);
        this.runtime.refresh_required = "add_widget_container";

        return widget;
    }

    init() {
        const width = nf(this.config.w, 0);
        const height = nf(this.config.h, 0);
        if (width <= 0 || height <= 0) return false;

        this.innerHeight = this._measure();
        this._clamp();
        this.runtime.refresh_required = "set_prop";
        return true;
    }

    _space() {
        return Math.max(0, nf(this.config.item_space, 0));
    }

    _itemHeight(item) {
        return Math.max(0, nf(item && item.config ? item.config.h : undefined,
            nf(this.config.item_height, 0)));
    }

    _layout() {
        const rows = [];
        let y = 0;
        const space = this._space();

        for (let i = 0; i < this.items.length; i++) {
            const height = this._itemHeight(this.items[i]);
            rows.push({index: i, widget: this.items[i], y, h: height});
            y += height + space;
        }
        return rows;
    }

    _measure() {
        if (this.items.length > 0) {
            const rows = this._layout();
            if (!rows.length) return 0;
            const last = rows[rows.length - 1];
            return last.y + last.h;
        }
        return this._measureTemplate();
    }

    _data() {
        return Array.isArray(this.config.data_array) ? this.config.data_array : [];
    }

    _itemConfigs() {
        const list = this.config.item_config;
        if (Array.isArray(list)) return list;
        if (list && typeof list === "object") return [list];
        return [];
    }

    _configFor(item) {
        const list = this._itemConfigs();
        if (!list.length) return null;

        if (item && item.type_id !== undefined) {
            for (const config of list) {
                if (config && config.type_id === item.type_id) return config;
            }
        }
        return list[0];
    }

    _templateRows() {
        const rows = [];
        const data = this._data();
        const space = this._space();
        let y = 0;

        for (let i = 0; i < data.length; i++) {
            const config = this._configFor(data[i]);
            if (!config) break;
            const height = Math.max(0, nf(config.item_height, 0));
            rows.push({index: i, item: data[i], ic: config, y, h: height});
            y += height + space;
        }
        return rows;
    }

    _measureTemplate() {
        const rows = this._templateRows();
        if (!rows.length) return 0;
        const last = rows[rows.length - 1];
        return last.y + last.h;
    }

    _clamp() {
        const maxScroll = Math.max(0, this.innerHeight - nf(this.config.h, 0));
        this.scrollY = clamp(this.scrollY, -maxScroll, 0);
    }

    async _renderItem(row, view, runtime) {
        const config = row.widget.config || {};
        if (config.visible === false) return;

        const savedX = config.x;
        const savedY = config.y;
        config.x = 0;
        config.y = row.y;
        config.__eventOffsetX = 0;
        config.__eventOffsetY = 0;

        const eventStart = runtime.events.length;
        try {
            await runtime.renderWidget(row.widget, view);
        } finally {
            config.x = savedX;
            config.y = savedY;
        }

        const dx = this._x;
        const dy = this._y + this.scrollY;
        for (let i = eventStart; i < runtime.events.length; i++) {
            const zone = runtime.events[i];
            zone.x1 += dx;
            zone.x2 += dx;
            zone.y1 += dy;
            zone.y2 += dy;
        }
    }

    async _drawTemplateRow(ctx, row, view, runtime, width) {
        const ic = row.ic;
        const item = row.item;

        FillRectWidget.draw(view, {
            x: 0,
            y: row.y,
            w: width,
            h: row.h,
            color: ic.item_bg_color === undefined ? 0x303030 : ic.item_bg_color,
            radius: nf(ic.item_bg_radius, 0)
        }, "fill", runtime);

        const textViews = Array.isArray(ic.text_view) ? ic.text_view : [];
        const textCount = nf(ic.text_view_count, textViews.length);
        for (let i = 0; i < textCount; i++) {
            const tv = textViews[i];
            if (!tv) continue;

            const text = item ? item[tv.key] : undefined;
            if (text === undefined || text === null || text === "") continue;

            drawTextAt(ctx, runtime, {
                x: 0,
                y: 0,
                w: Math.max(0, nf(tv.w, 0)),
                h: Math.max(0, nf(tv.h, 0)),
                text: String(text),
                text_size: nf(tv.text_size, nf(this.config.text_size, 18)),
                color: tv.color === undefined ? 0xffffff : tv.color,
                align_h: tv.align_h ? tv.align_h : "left",
                align_v: tv.align_v ? tv.align_v : "top"
            }, nf(tv.x, 0), row.y + nf(tv.y, 0));
        }

        const imageViews = Array.isArray(ic.image_view) ? ic.image_view : [];
        const imageCount = nf(ic.image_view_count, imageViews.length);
        for (let i = 0; i < imageCount; i++) {
            const iv = imageViews[i];
            if (!iv) continue;

            const src = item ? item[iv.key] : undefined;
            try {
                await drawImageFit(runtime, view, src,
                    nf(iv.x, 0), row.y + nf(iv.y, 0),
                    nf(iv.w, 0), nf(iv.h, 0));
            } catch (e) {}
        }
    }

    _hitView(list, count, x, y) {
        if (!Array.isArray(list)) return null;

        const total = nf(count, list.length);
        for (let i = 0; i < total; i++) {
            const view = list[i];
            if (!view || !view.action) continue;

            const w = nf(view.w, 0);
            const h = nf(view.h, 0);
            if (x >= nf(view.x, 0) && x <= nf(view.x, 0) + w &&
                y >= nf(view.y, 0) && y <= nf(view.y, 0) + h) {
                return view;
            }
        }
        return null;
    }

    async render(canvas, runtime) {
        const config = this.config;
        const x = nf(config.x, 0);
        const y = nf(config.y, 0);
        const width = Math.max(0, Math.round(nf(config.w, 0)));
        const height = Math.max(0, Math.round(nf(config.h, 0)));

        this._x = x;
        this._y = y;

        if (width <= 0 || height <= 0) {
            this.dropEvents(runtime, [x, y, x + width, y + height]);
            return;
        }

        const view = runtime.newCanvas();
        view.width = width;
        view.height = height;
        const ctx = view.getContext("2d");

        this.innerHeight = this._measure();
        this._clamp();

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();
        ctx.translate(0, this.scrollY);

        const eventStart = runtime.events.length;
        const pageHeight = runtime.contentHeight;
        const top = -this.scrollY;
        const bottom = top + height;

        if (this.items.length > 0) {
            for (const row of this._layout()) {
                if (row.y + row.h < top) continue;
                if (row.y > bottom) continue;
                await this._renderItem(row, view, runtime);
            }
        } else {
            for (const row of this._templateRows()) {
                if (row.y + row.h < top) continue;
                if (row.y > bottom) continue;
                await this._drawTemplateRow(ctx, row, view, runtime, width);
            }
        }

        for (let i = eventStart; i < runtime.events.length; i++) {
            const zone = runtime.events[i];
            zone.x1 = Math.max(zone.x1, x);
            zone.y1 = Math.max(zone.y1, y);
            zone.x2 = Math.min(zone.x2, x + width);
            zone.y2 = Math.min(zone.y2, y + height);
        }
        runtime.contentHeight = pageHeight;

        ctx.restore();
        canvas.getContext("2d").drawImage(view, x, y);

        this.dropEvents(runtime, [x, y, x + width, y + height]);
    }

    _rowAt(localY) {
        if (this.items.length > 0) {
            for (const row of this._layout()) {
                if (localY >= row.y && localY < row.y + Math.max(row.h, 1)) return row;
            }
            return null;
        }

        for (const row of this._templateRows()) {
            if (localY >= row.y && localY < row.y + Math.max(row.h, 1)) return row;
        }
        return null;
    }

    _findChildZone(runtime, x, y) {
        const events = runtime.events;
        for (let i = events.length - 1; i >= 0; i--) {
            const zone = events[i];
            if (!zone || zone.events === this.events) continue;
            if (zone.x1 < x && x < zone.x2 && zone.y1 < y && y < zone.y2) return zone;
        }
        return null;
    }

    _handleClick(e) {
        const config = this.config;
        const zoneY = e.y + pageScroll(this.runtime);
        const localY = zoneY - this._y - this.scrollY;
        const localX = e.x - this._x;
        const row = this._rowAt(localY);
        if (!row) return;

        let key;
        if (row.ic) {
            const textView = this._hitView(row.ic.text_view, row.ic.text_view_count,
                localX, localY - row.y);
            if (textView) {
                key = textView.key;
            } else {
                const imageView = this._hitView(row.ic.image_view, row.ic.image_view_count,
                    localX, localY - row.y);
                if (imageView) key = imageView.key;
            }
        }

        if (typeof config.item_click_func !== "function") return;
        if (key !== undefined) {
            config.item_click_func(this, row.index, key);
        } else {
            config.item_click_func(this, row.index);
        }
    }

    eventDown(e) {
        this.mouseStartEv = e;
        this.lastScrollY = this.scrollY;
        this.isMouseDown = true;
        this.moved = false;
    }

    eventMove(e) {
        if (!this.isMouseDown || !this.mouseStartEv) return;

        const dx = e.x - this.mouseStartEv.x;
        const dy = e.y - this.mouseStartEv.y;

        if (!this.moved) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_START) return;
            this.moved = true;
        }

        this.scrollY = this.lastScrollY + dy;
        this.runtime.refresh_required = "scroll";
    }

    eventUp(e) {
        if (!this.isMouseDown) return;
        this.isMouseDown = false;

        const moved = this.moved;
        this.moved = false;
        this._clamp();

        if (!moved) {
            /* The list zone is registered last, so clicks have to be handed
             * over to interactive children manually. */
            const y = e.y + pageScroll(this.runtime);
            const zone = this._findChildZone(this.runtime, e.x, y);
            if (zone && zone.events && typeof zone.events.onmouseup === "function") {
                zone.events.onmouseup(e);
            } else {
                this._handleClick(e);
            }
        }

        this.runtime.refresh_required = "scroll";
    }

    setProperty(prop, val) {
        if (prop === "more" && val && typeof val === "object") {
            let reset = false;
            for (const key in val) {
                this.config[key] = val[key];
                if (key === "data_array" || key === "data_count" || key === "item_config") {
                    reset = true;
                }
            }
            if (reset) this.scrollY = 0;
            this.runtime.refresh_required = "set_prop";
            return;
        }

        if (prop === "scroll_to" && val && typeof val === "object") {
            this.scrollY = -nf(val.y, 0);
            this._clamp();
            this.runtime.refresh_required = "scroll";
            return;
        }

        if (prop === "pos_y") {
            this.config.pos_y = val;
            this.scrollY = -Math.max(0, nf(val, 0));
            this._clamp();
            this.runtime.refresh_required = "scroll";
            return;
        }

        super.setProperty(prop, val);
    }
}

/**
 * hmUI.widget.VIRTUAL_CONTAINER
 *
 * Flex layout root. Children are added with `setLayoutParent()` /
 * `addLayoutChild()` (or created through `container.createWidget()`), their
 * `layout` style is resolved against the screen size.
 *
 * Supported: layout {x, y, width, height, display, flex-flow,
 * justify-content, align-items, row-gap, column-gap, padding*},
 * updateLayoutStyle(), updateLayout(), removeLayoutChild(),
 * optional scrolling (`scroll_enable`, `pos_y`) and `item_click_func(list, index)`.
 */
export class VirtualContainerWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this.children = [];
        if (!config.layout || typeof config.layout !== "object") config.layout = {};
        config.__content = this.children;

        this.scrollY = -Math.max(0, nf(config.pos_y, 0));
        this.innerHeight = 0;
        this.isMouseDown = false;
        this.moved = false;
        this.mouseStartEv = null;
        this.lastScrollY = 0;
        this._childCounter = 0;
        this._rect = {x: 0, y: 0, w: 0, h: 0};
        this._positions = [];
        this.layoutParent = null;
    }

    createWidget(type, config) {
        let Widget = null;
        try {
            Widget = (new HuamiUIMock())._widget[type];
        } catch (e) {}
        if (!Widget) Widget = MissingWidget;

        if (typeof config !== "object" || config === null) config = {};

        config.__widget = type;
        config.__id = ((nf(this.config.__id, 0) + 1) << 10) + this._childCounter;
        config.__runtime = this.runtime;
        config.__layoutOwner = true;

        const widget = new Widget(config);
        this._childCounter++;
        this.children.push(widget);
        this.runtime.refresh_required = "add_widget_container";

        return widget;
    }

    setLayoutParent(parent) {
        this.layoutParent = parent || null;
    }

    addLayoutChild(child, index) {
        if (!child) return;
        const position = nf(index, -1);
        if (position >= 0 && position <= this.children.length) {
            this.children.splice(position, 0, child);
        } else {
            this.children.push(child);
        }
        child.layoutParent = this;
        this.runtime.refresh_required = "add_widget_container";
    }

    removeLayoutChild(child) {
        const index = this.children.indexOf(child);
        if (index < 0) return;
        this.children.splice(index, 1);
        this.runtime.refresh_required = "del_widget";
    }

    updateLayoutStyle(style) {
        if (!style || typeof style !== "object") return;
        Object.assign(this.config.layout, style);
        this.runtime.refresh_required = "set_prop";
    }

    updateLayout() {
        this.runtime.refresh_required = "set_prop";
    }

    /* Layout length: number, "%", "vw"/"vh", "px" or a plain numeric string. */
    _len(value, base, fallback, screen) {
        screen = screen || this.runtime.screen || [0, 0];

        if (typeof value === "number" && isFinite(value)) return value;
        if (typeof value !== "string") return fallback;

        const text = value.trim().toLowerCase();
        if (text === "" || text === "auto" || text === "none") return fallback;

        const parsed = parseFloat(text);
        if (!isFinite(parsed)) return fallback;

        if (text.endsWith("%")) return base * parsed / 100;
        if (text.endsWith("vw")) return (screen[0] || 0) * parsed / 100;
        if (text.endsWith("vh")) return (screen[1] || 0) * parsed / 100;
        return parsed;
    }

    _padding(screen) {
        const layout = this.config.layout || {};
        const all = this._len(layout.padding, 0, 0, screen);
        return {
            top: this._len(layout["padding-top"], 0, all, screen),
            right: this._len(layout["padding-right"], 0, all, screen),
            bottom: this._len(layout["padding-bottom"], 0, all, screen),
            left: this._len(layout["padding-left"], 0, all, screen)
        };
    }

    _intrinsic(child, runtime) {
        const config = child.config || {};

        if (config.__widget === "TEXT" && config.text !== undefined) {
            try {
                const metrics = TextWidget.drawText({
                    text: String(config.text),
                    text_size: nf(config.text_size, 18),
                    w: nf(config.w, 0),
                    h: nf(config.h, 0),
                    char_space: nf(config.char_space, 0),
                    line_space: nf(config.line_space, 0),
                    text_style: config.text_style,
                    _metricsOnly: true
                }, runtime);

                return {
                    w: metrics && metrics.width ? metrics.width : 0,
                    h: metrics && metrics.height ? metrics.height : 0
                };
            } catch (e) {}
        }

        return {w: nf(config.w, 0), h: nf(config.h, 0)};
    }

    _computeLayout(runtime) {
        const config = this.config;
        const layout = config.layout || {};
        const screen = runtime.screen || [0, 0];

        const rect = {
            x: this._len(layout.x, screen[0], nf(config.x, 0), screen),
            y: this._len(layout.y, screen[1], nf(config.y, 0), screen),
            w: this._len(layout.width, screen[0], 0, screen),
            h: this._len(layout.height, screen[1], 0, screen)
        };

        if (rect.w <= 0) rect.w = Math.max(0, nf(config.w, screen[0]));
        if (rect.h <= 0) rect.h = Math.max(0, nf(config.h, screen[1]));

        this._rect = rect;

        const pad = this._padding(screen);
        const flow = String(layout["flex-flow"] || layout.flex_direction || "row").toLowerCase();
        const column = flow.indexOf("column") >= 0;
        const wrap = flow.indexOf("wrap") >= 0;
        const justify = String(layout["justify-content"] || "flex-start").toLowerCase();
        const align = String(layout["align-items"] || "flex-start").toLowerCase();
        const rowGap = layout["row-gap"] !== undefined ? layout["row-gap"] : layout.gap;
        const columnGap = layout["column-gap"] !== undefined ? layout["column-gap"] : layout.gap;
        const mainGap = Math.max(0, this._len(column ? rowGap : columnGap, 0, 0, screen));
        const crossGap = Math.max(0, this._len(column ? columnGap : rowGap, 0, 0, screen));

        const mainBase = column ? rect.h : rect.w;
        const crossBase = column ? rect.w : rect.h;
        const mainStart = column ? pad.top : pad.left;
        const mainEnd = column ? pad.bottom : pad.right;
        const crossStart = column ? pad.left : pad.top;
        const crossEnd = column ? pad.right : pad.bottom;

        const lines = [{items: [], mainStart, mainEnd: mainStart}];
        let cursor = mainStart;
        let crossCursor = crossStart;
        let lineCross = 0;

        for (let i = 0; i < this.children.length; i++) {
            const child = this.children[i];
            const childConfig = child.config || {};
            if (childConfig.visible === false) continue;

            const childLayout = childConfig.layout || {};
            const intrinsic = this._intrinsic(child, runtime);

            const width = Math.max(0, this._len(childLayout.width, rect.w, intrinsic.w, screen));
            const height = Math.max(0, this._len(childLayout.height, rect.h, intrinsic.h, screen));

            const marginLeft = this._len(childLayout["margin-left"], rect.w, 0, screen);
            const marginRight = this._len(childLayout["margin-right"], rect.w, 0, screen);
            const marginTop = this._len(childLayout["margin-top"], rect.h, 0, screen);
            const marginBottom = this._len(childLayout["margin-bottom"], rect.h, 0, screen);

            const mainBefore = column ? marginTop : marginLeft;
            const mainAfter = column ? marginBottom : marginRight;
            const crossBefore = column ? marginLeft : marginTop;
            const crossAfter = column ? marginRight : marginBottom;
            const mainSize = column ? height : width;
            const crossSize = column ? width : height;

            if (wrap && lines[lines.length - 1].items.length > 0 &&
                cursor + mainBefore + mainSize + mainAfter > mainBase - mainEnd) {
                const finished = lines[lines.length - 1];
                finished.crossSize = lineCross;
                cursor = mainStart;
                crossCursor += lineCross + crossGap;
                lineCross = 0;
                lines.push({items: [], mainStart, mainEnd: mainStart});
            }

            const entry = {
                index: i,
                widget: child,
                width,
                height,
                main: cursor + mainBefore,
                cross: crossCursor + crossBefore,
                mainBefore,
                mainAfter,
                crossBefore,
                crossAfter,
                mainSize,
                crossSize,
                alignSelf: String(childLayout["align-self"] || "").toLowerCase(),
                offsetX: this._len(childLayout.x, rect.w, 0, screen),
                offsetY: this._len(childLayout.y, rect.h, 0, screen)
            };

            const line = lines[lines.length - 1];
            line.items.push(entry);
            line.mainEnd = entry.main + mainSize + mainAfter;
            cursor = entry.main + mainSize + mainAfter + mainGap;
            lineCross = Math.max(lineCross, crossBefore + crossSize + crossAfter);
        }

        const lastLine = lines[lines.length - 1];
        lastLine.crossSize = lineCross;

        const positions = [];
        for (const line of lines) {
            if (!line.items.length) continue;

            const contentMain = line.mainEnd - line.mainStart;
            const free = Math.max(0, mainBase - mainStart - mainEnd - contentMain);
            let shift = 0;
            let extraGap = 0;

            if (justify === "flex-end" || justify === "end") {
                shift = free;
            } else if (justify === "center") {
                shift = free / 2;
            } else if (justify === "space-between") {
                extraGap = line.items.length > 1 ? free / (line.items.length - 1) : 0;
            } else if (justify === "space-around") {
                extraGap = free / line.items.length;
                shift = extraGap / 2;
            } else if (justify === "space-evenly") {
                extraGap = free / (line.items.length + 1);
                shift = extraGap;
            }

            for (let j = 0; j < line.items.length; j++) {
                const entry = line.items[j];
                const main = entry.main + shift + extraGap * j;

                let cross;
                const itemAlign = entry.alignSelf || align;
                if (itemAlign === "center") {
                    cross = line.crossSize - entry.crossBefore - entry.crossAfter - entry.crossSize;
                    cross = entry.crossBefore + Math.max(0, cross) / 2;
                } else if (itemAlign === "flex-end" || itemAlign === "end") {
                    cross = line.crossSize - entry.crossAfter - entry.crossSize;
                } else if (itemAlign === "stretch") {
                    cross = entry.crossBefore;
                    if (column) entry.width = Math.max(0,
                        line.crossSize - entry.crossBefore - entry.crossAfter);
                    else entry.height = Math.max(0,
                        line.crossSize - entry.crossBefore - entry.crossAfter);
                } else {
                    cross = entry.crossBefore;
                }

                if (column) {
                    positions.push({
                        index: entry.index,
                        widget: entry.widget,
                        x: cross + entry.offsetX,
                        y: main + entry.offsetY,
                        w: entry.width,
                        h: entry.height
                    });
                } else {
                    positions.push({
                        index: entry.index,
                        widget: entry.widget,
                        x: main + entry.offsetX,
                        y: cross + entry.offsetY,
                        w: entry.width,
                        h: entry.height
                    });
                }
            }
        }

        return {rect, positions, padding: pad};
    }

    _clamp() {
        const maxScroll = Math.max(0, this.innerHeight - this._rect.h);
        this.scrollY = clamp(this.scrollY, -maxScroll, 0);
    }

    async render(canvas, runtime) {
        const config = this.config;
        const computed = this._computeLayout(runtime);
        const rect = computed.rect;
        const width = Math.max(0, Math.round(rect.w));
        const height = Math.max(0, Math.round(rect.h));

        this._positions = computed.positions;

        if (width <= 0 || height <= 0) {
            this.dropEvents(runtime, [rect.x, rect.y, rect.x + width, rect.y + height]);
            return;
        }

        this.innerHeight = 0;
        for (const position of computed.positions) {
            const bottom = position.y + position.h + computed.padding.bottom;
            if (bottom > this.innerHeight) this.innerHeight = bottom;
        }
        this._clamp();

        const view = runtime.newCanvas();
        view.width = width;
        view.height = height;
        const ctx = view.getContext("2d");

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();
        ctx.translate(0, this.scrollY);

        const eventStart = runtime.events.length;
        const pageHeight = runtime.contentHeight;

        for (const position of computed.positions) {
            const child = position.widget;
            const childConfig = child.config || {};
            if (childConfig.visible === false) continue;

            const savedX = childConfig.x;
            const savedY = childConfig.y;
            const savedW = childConfig.w;
            const savedH = childConfig.h;

            childConfig.x = position.x;
            childConfig.y = position.y;
            if (position.w > 0) childConfig.w = position.w;
            if (position.h > 0) childConfig.h = position.h;
            childConfig.__eventOffsetX = 0;
            childConfig.__eventOffsetY = 0;

            try {
                await runtime.renderWidget(child, view);
            } finally {
                childConfig.x = savedX;
                childConfig.y = savedY;
                childConfig.w = savedW;
                childConfig.h = savedH;
            }
        }

        const dx = rect.x;
        const dy = rect.y + this.scrollY;
        for (let i = eventStart; i < runtime.events.length; i++) {
            const zone = runtime.events[i];
            zone.x1 += dx;
            zone.x2 += dx;
            zone.y1 += dy;
            zone.y2 += dy;
            zone.x1 = Math.max(zone.x1, rect.x);
            zone.y1 = Math.max(zone.y1, rect.y);
            zone.x2 = Math.min(zone.x2, rect.x + width);
            zone.y2 = Math.min(zone.y2, rect.y + height);
        }
        runtime.contentHeight = pageHeight;

        ctx.restore();
        canvas.getContext("2d").drawImage(view, rect.x, rect.y);

        this.dropEvents(runtime, [
            rect.x,
            rect.y,
            rect.x + width,
            rect.y + height
        ]);
    }

    _findChildZone(runtime, x, y) {
        const events = runtime.events;
        for (let i = events.length - 1; i >= 0; i--) {
            const zone = events[i];
            if (!zone || zone.events === this.events) continue;
            if (zone.x1 < x && x < zone.x2 && zone.y1 < y && y < zone.y2) return zone;
        }
        return null;
    }

    _handleClick(e) {
        if (typeof this.config.item_click_func !== "function") return;

        const rect = this._rect;
        const y = e.y + pageScroll(this.runtime);
        const localY = y - rect.y - this.scrollY;
        const localX = e.x - rect.x;

        for (const position of this._positions) {
            if (localX >= position.x && localX <= position.x + position.w &&
                localY >= position.y && localY <= position.y + position.h) {
                this.config.item_click_func(this, position.index);
                return;
            }
        }
    }

    eventDown(e) {
        this.mouseStartEv = e;
        this.lastScrollY = this.scrollY;
        this.isMouseDown = true;
        this.moved = false;
    }

    eventMove(e) {
        if (!this.isMouseDown || !this.mouseStartEv) return;
        if (this.config.scroll_enable === false || this.config.scroll_enable === 0) return;

        const dx = e.x - this.mouseStartEv.x;
        const dy = e.y - this.mouseStartEv.y;

        if (!this.moved) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_START) return;
            this.moved = true;
        }

        this.scrollY = this.lastScrollY + dy;
        this.runtime.refresh_required = "scroll";
    }

    eventUp(e) {
        if (!this.isMouseDown) return;
        this.isMouseDown = false;

        const moved = this.moved;
        this.moved = false;
        this._clamp();

        if (!moved) {
            const y = e.y + pageScroll(this.runtime);
            const zone = this._findChildZone(this.runtime, e.x, y);
            if (zone && zone.events && typeof zone.events.onmouseup === "function") {
                zone.events.onmouseup(e);
            } else {
                this._handleClick(e);
            }
        }

        this.runtime.refresh_required = "scroll";
    }

    setProperty(prop, val) {
        if (prop === "more" && val && typeof val === "object") {
            for (const key in val) {
                if (key === "layout" && val.layout && typeof val.layout === "object") {
                    Object.assign(this.config.layout, val.layout);
                } else {
                    this.config[key] = val[key];
                }
            }
            this.runtime.refresh_required = "set_prop";
            return;
        }

        if (prop === "layout" && val && typeof val === "object") {
            Object.assign(this.config.layout, val);
            this.runtime.refresh_required = "set_prop";
            return;
        }

        if (prop === "pos_y") {
            this.config.pos_y = val;
            this.scrollY = -Math.max(0, nf(val, 0));
            this._clamp();
            this.runtime.refresh_required = "scroll";
            return;
        }

        super.setProperty(prop, val);
    }
}

/* Unit used for sport data keys. Values are not simulated, only the layout
 * described by the documentation is reproduced. */
const SPORT_UNITS = [
    ["DISTANCE", "km"],
    ["CONSUME", "kcal"],
    ["CAL", "kcal"],
    ["SPEED", "km/h"],
    ["PACE", "/km"],
    ["STRIDE_FREQ", "spm"],
    ["FREQ", "rpm"],
    ["TEMP", "°C"],
    ["ALTITUDE", "m"],
    ["DEPTH", "m"],
    ["HEIGHT", "m"],
    ["PRESSURE", "hPa"],
    ["SLOPE", "%"],
    ["HR", "bpm"],
    ["POWER", "W"],
    ["DURATION", ""]
];

/**
 * hmUI.widget.SPORT_DATA
 *
 * Workout data cell: value text box plus optional unit/subtext box and border.
 * `mock_data` is displayed as-is (that is what the emulator is supposed to do);
 * otherwise `value` or the device state of `default_type` is used.
 */
export class SportDataWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this.value = config.mock_data !== undefined && config.mock_data !== null
            ? String(config.mock_data)
            : (config.value !== undefined && config.value !== null ? String(config.value) : "");
    }

    _unit() {
        if (this.config.unit !== undefined) return String(this.config.unit);
        if (this.config.sub_text !== undefined) return String(this.config.sub_text);

        const type = this.config.default_type;
        if (typeof type !== "string") return "";

        for (const [key, unit] of SPORT_UNITS) {
            if (type.indexOf(key) === 0) return unit;
        }
        return "";
    }

    _value(runtime) {
        const config = this.config;
        if (config.mock_data !== undefined && config.mock_data !== null) {
            return String(config.mock_data);
        }
        if (this.value !== "") return this.value;

        if (config.default_type !== undefined) {
            try {
                const state = runtime.getDeviceState(config.default_type, "string");
                if (state !== undefined && state !== null && state !== "") return String(state);
            } catch (e) {}
        }
        return "0";
    }

    async render(canvas, runtime) {
        const config = this.config;
        const x = nf(config.x, 0);
        const y = nf(config.y, 0);
        const width = Math.max(0, Math.round(nf(config.w, 0)));
        const height = Math.max(0, Math.round(nf(config.h, 0)));

        if (width <= 0 || height <= 0) {
            this.dropEvents(runtime, [x, y, x + width, y + height]);
            return;
        }

        const view = runtime.newCanvas();
        view.width = width;
        view.height = height;
        const ctx = view.getContext("2d");

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();

        if (config.rect_visible) {
            FillRectWidget.draw(view, {
                x: 0,
                y: 0,
                w: width,
                h: height,
                color: config.line_color === undefined ? 0x0000FF : config.line_color,
                radius: nf(config.radius, 0),
                line_width: nf(config.line_width, 2)
            }, "stroke", runtime);
        }

        let textX = nf(config.text_x, 0);
        const textY = nf(config.text_y, 0);
        let textW = Math.max(0, nf(config.text_w, width - textX));
        const textH = Math.max(0, nf(config.text_h, height - textY));

        const iconSrc = config.icon || config.icon_src;
        if (iconSrc) {
            const iconSize = Math.max(0, nf(config.icon_size, Math.min(textH || height, height)));
            try {
                await drawImageFit(runtime, view, iconSrc, textX,
                    textY + Math.max(0, (textH - iconSize) / 2),
                    iconSize, iconSize);
                textX += iconSize + Math.max(0, nf(config.icon_space, 0));
                textW = Math.max(0, textW - iconSize);
            } catch (e) {}
        }

        const unit = this._unit();
        const value = this._value(runtime);
        const mainText = unit && !config.sub_text_visible ? value + " " + unit : value;

        drawTextAt(ctx, runtime, {
            x: 0,
            y: 0,
            w: textW,
            h: textH,
            text: mainText,
            text_size: nf(config.text_size, 36),
            color: config.text_color === undefined ? 0x0000FF : config.text_color,
            align_h: config.text_align_h ? config.text_align_h : "center_h",
            align_v: config.text_align_v ? config.text_align_v : "center_v",
            char_space: nf(config.char_space, 0),
            line_space: nf(config.line_space, 0)
        }, textX, textY);

        if (config.sub_text_visible) {
            const subText = config.sub_text !== undefined ? String(config.sub_text) : unit;
            if (subText !== "") {
                const subX = nf(config.sub_text_x, textX);
                const subY = nf(config.sub_text_y, textY + textH);
                drawTextAt(ctx, runtime, {
                    x: 0,
                    y: 0,
                    w: Math.max(0, nf(config.sub_text_w, textW)),
                    h: Math.max(0, nf(config.sub_text_h, height - subY)),
                    text: subText,
                    text_size: nf(config.sub_text_size, 36),
                    color: config.sub_text_color === undefined ? 0x0000FF : config.sub_text_color,
                    align_h: "center_h",
                    align_v: "center_v"
                }, subX, subY);
            }
        }

        ctx.restore();
        canvas.getContext("2d").drawImage(view, x, y);

        this.dropEvents(runtime, [x, y, x + width, y + height]);
    }

    setProperty(prop, val) {
        if (prop === "more" && val && typeof val === "object") {
            for (const key in val) this.config[key] = val[key];
            if (val.mock_data !== undefined) {
                this.value = val.mock_data === null ? "" : String(val.mock_data);
            }
            if (val.value !== undefined) {
                this.value = val.value === null ? "" : String(val.value);
            }
            if (val.text !== undefined) this.config.mock_data = val.text;
            this.runtime.refresh_required = "set_prop";
            return;
        }

        if (prop === "mock_data" || prop === "value" || prop === "text") {
            this.value = val === undefined || val === null ? "" : String(val);
            this.config[prop === "text" ? "mock_data" : prop] = val;
            this.runtime.refresh_required = "set_prop";
            return;
        }

        super.setProperty(prop, val);
    }

    getProperty(key, second) {
        if (key === "more") {
            return Object.assign({}, this.config, {value: this.value});
        }
        return super.getProperty(key, second);
    }
}
