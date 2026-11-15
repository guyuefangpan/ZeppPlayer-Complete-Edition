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

/* 官方文档中其余 UI 控件的实现：CANVAS、SLIDE_SWITCH、CHECKBOX_GROUP、
 * PAGE_INDICATOR、PAGE_SCROLLBAR、DIALOG、SPORT_DATA、CYCLE_LIST、
 * CYCLE_IMAGE_TEXT_LIST、LIST_VIEW、VIRTUAL_CONTAINER、PICKER、PICK_DATE、
 * TIME_PICKER、KEYBOARD、SYSTEM_KEYBOARD。 */

import {BaseWidget} from "./BaseWidget";
import {TextWidget} from "./TextWidget";
import {ViewContainerWidget} from "./ViewContainerWidget";

function colorOf(value, fallback) {
    return value === undefined || value === null ? fallback : value;
}

function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r || 0, Math.min(w, h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

function fillRound(ctx, x, y, w, h, r, color) {
    ctx.fillStyle = `#${colorOf(color, 0x000000).toString(16).padStart(6, "0")}`;
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
}

function drawText(ctx, runtime, config, x, y, w, h) {
    const layer = TextWidget.drawText({
        x: 0, y: 0, w: w, h: h,
        text: config.text === undefined || config.text === null ? "" : String(config.text),
        text_size: config.text_size || runtime.profileData.defaultFontSize || 18,
        color: colorOf(config.color, 0xffffff),
        align_h: config.align_h,
        align_v: config.align_v,
        char_space: config.char_space || 0,
        line_space: config.line_space || 0
    }, runtime);
    ctx.drawImage(layer, x, y);
}

async function drawSprite(ctx, runtime, src, x, y, w, h) {
    if(!src) return false;
    try {
        const img = await runtime.getAssetImage(src);
        if(!img) return false;
        if(w && h) ctx.drawImage(img, x, y, w, h);
        else ctx.drawImage(img, x, y);
        return true;
    } catch (e) {
        return false;
    }
}

/* ------------------------------------------------------------------ CANVAS */
export class CanvasWidget extends BaseWidget {
    init() {
        this.canvas = this.runtime.newCanvas();
        this.canvas.width = this.config.w || 1;
        this.canvas.height = this.config.h || 1;
        this.context = this.canvas.getContext("2d");
    }

    getContext() {
        return this.context;
    }

    clear() {
        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.runtime.refresh_required = "canvas";
    }

    drawLine(conf) {
        const ctx = this.context;
        ctx.strokeStyle = `#${colorOf(conf.color, 0xffffff).toString(16).padStart(6, "0")}`;
        ctx.lineWidth = conf.line_width || 1;
        ctx.beginPath();
        ctx.moveTo(conf.x1, conf.y1);
        ctx.lineTo(conf.x2, conf.y2);
        ctx.stroke();
        this.runtime.refresh_required = "canvas";
    }

    drawRect(conf) {
        fillRound(this.context, conf.x, conf.y, conf.w, conf.h, 0, conf.color);
        this.runtime.refresh_required = "canvas";
    }

    drawCircle(conf) {
        const ctx = this.context;
        ctx.fillStyle = `#${colorOf(conf.color, 0xffffff).toString(16).padStart(6, "0")}`;
        ctx.beginPath();
        ctx.arc(conf.center_x, conf.center_y, conf.radius, 0, Math.PI * 2);
        ctx.fill();
        this.runtime.refresh_required = "canvas";
    }

    drawArc(conf) {
        const ctx = this.context;
        ctx.strokeStyle = `#${colorOf(conf.color, 0xffffff).toString(16).padStart(6, "0")}`;
        ctx.lineWidth = conf.line_width || 1;
        ctx.beginPath();
        ctx.arc(conf.center_x, conf.center_y, conf.radius,
            (conf.start_angle || 0) * Math.PI / 180,
            (conf.end_angle || 360) * Math.PI / 180);
        ctx.stroke();
        this.runtime.refresh_required = "canvas";
    }

    drawText(conf) {
        drawText(this.context, this.runtime, {
            text: conf.text,
            text_size: conf.text_size,
            color: conf.color,
            align_h: conf.align_h,
            align_v: conf.align_v
        }, conf.x || 0, conf.y || 0, conf.w || this.config.w, conf.h || this.config.h);
        this.runtime.refresh_required = "canvas";
    }

    async render(canvas, runtime) {
        canvas.getContext("2d").drawImage(this.canvas, this.config.x, this.config.y);
        this.dropEvents(runtime, [
            this.config.x, this.config.y,
            this.config.x + this.config.w, this.config.y + this.config.h
        ]);
    }
}

/* ------------------------------------------------------------ SLIDE_SWITCH */
export class SlideSwitchWidget extends BaseWidget {
    init() {
        this.config.checked = !!this.config.checked;
        this.addEventListener("onmouseup", () => this.toggle());
    }

    toggle() {
        this.config.checked = !this.config.checked;
        this.runtime.refresh_required = "slide_switch";
        const cb = this.config.checked_change_func;
        if(typeof cb === "function") {
            try {
                cb({checked: this.config.checked});
            } catch (e) {
                console.warn("checked_change_func failed", e);
            }
        }
    }

    async render(canvas, runtime) {
        const c = this.config;
        const ctx = canvas.getContext("2d");
        const radius = (c.h || 0) / 2;

        const bg = c.checked ? c.select_bg : c.un_select_bg;
        if(!(await drawSprite(ctx, runtime, bg, c.x, c.y, c.w, c.h))) {
            fillRound(ctx, c.x, c.y, c.w, c.h, radius,
                c.checked ? colorOf(c.checked_bg_color, 0x0078d7) : colorOf(c.uncheck_bg_color, 0x444444));
        }

        const knobW = c.h || 20;
        const knobX = c.x + (typeof c.slide_select_x === "number"
            ? (c.checked ? c.slide_select_x : c.slide_un_select_x)
            : (c.checked ? c.w - knobW : 0));
        const knobY = c.y + (c.slide_y || 0);
        if(!(await drawSprite(ctx, runtime, c.slide_src, knobX, knobY, knobW, c.h))) {
            fillRound(ctx, knobX + 2, knobY + 2, knobW - 4, c.h - 4, (c.h - 4) / 2,
                colorOf(c.slider_color, 0xffffff));
        }

        this.dropEvents(runtime, [c.x, c.y, c.x + c.w, c.y + c.h]);
    }
}

/* --------------------------------------------------------- CHECKBOX_GROUP */
export class CheckboxGroupWidget extends BaseWidget {
    init() {
        if(!Array.isArray(this.config.options)) this.config.options = [];
        this.addEventListener("onmouseup", (info) => this.hit(info));
    }

    _options() {
        return Array.isArray(this.config.checkboxes) ? this.config.checkboxes : this.config.options;
    }

    hit(info) {
        const c = this.config;
        const list = this._options();
        for(let i = 0; i < list.length; i++) {
            const o = list[i];
            const x = c.x + (o.x || 0);
            const y = c.y + (o.y || 0);
            const w = o.w || c.w;
            const h = o.h || (c.h / Math.max(1, list.length));
            if(info.x >= x && info.x <= x + w && info.y >= y - this.runtime.player.config.renderScroll && info.y <= y - this.runtime.player.config.renderScroll + h) {
                o.checked = !o.checked;
                this.runtime.refresh_required = "checkbox";
                if(typeof c.check_func === "function") {
                    try {
                        c.check_func({index: i, checked: !!o.checked});
                    } catch (e) {
                        console.warn("check_func failed", e);
                    }
                }
                return;
            }
        }
    }

    async render(canvas, runtime) {
        const c = this.config;
        const ctx = canvas.getContext("2d");
        const list = this._options();
        const rowH = c.h / Math.max(1, list.length);

        for(let i = 0; i < list.length; i++) {
            const o = list[i];
            const x = c.x + (o.x || 0);
            const y = c.y + (o.y || 0) + (o.y === undefined ? i * rowH : 0);
            const boxW = o.box_w || 30;
            const checked = !!o.checked;

            if(!(await drawSprite(ctx, runtime, checked ? c.select_src : c.unselect_src, x, y + 2, boxW, boxW))) {
                fillRound(ctx, x, y + 2, boxW, boxW, 4, checked ? 0x0078d7 : 0x555555);
                if(checked) {
                    ctx.strokeStyle = "#ffffff";
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.moveTo(x + 7, y + 16);
                    ctx.lineTo(x + 12, y + 22);
                    ctx.lineTo(x + 23, y + 8);
                    ctx.stroke();
                }
            }

            drawText(ctx, runtime, {
                text: o.text,
                text_size: c.text_size || 24,
                color: colorOf(c.text_color, 0xffffff),
                align_h: "left",
                align_v: "center_v"
            }, x + boxW + 10, y, c.w - boxW - 10, boxW + 4);
        }

        this.dropEvents(runtime, [c.x, c.y, c.x + c.w, c.y + c.h]);
    }
}

/* --------------------------------------------------------- PAGE_INDICATOR */
export class PageIndicatorWidget extends BaseWidget {
    _count() {
        return this.config.count || this.config.total || 1;
    }

    _current() {
        return this.config.current !== undefined ? this.config.current
            : (this.config.current_index || 0);
    }

    async render(canvas, runtime) {
        const c = this.config;
        const ctx = canvas.getContext("2d");
        const count = this._count();
        const current = this._current();
        const horizontal = c.horizontal !== false;
        const radius = c.element_radius || c.radius || 4;
        const size = (c.element_height || radius * 2 || 8) + (c.h_space || c.v_space || 8);

        for(let i = 0; i < count; i++) {
            const active = i === current;
            const x = c.x + (horizontal ? i * size : 0);
            const y = c.y + (horizontal ? 0 : i * size);
            if(!(await drawSprite(ctx, runtime, active ? c.select_src : c.unselect_src, x, y, radius * 2, radius * 2))) {
                ctx.fillStyle = `#${colorOf(active ? c.select_color : c.unselect_color,
                    active ? 0xffffff : 0x666666).toString(16).padStart(6, "0")}`;
                ctx.beginPath();
                ctx.arc(x + radius, y + radius, radius, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        this.dropEvents(runtime, [c.x, c.y, c.x + c.w, c.y + c.h]);
    }
}

/* --------------------------------------------------------- PAGE_SCROLLBAR */
export class PageScrollbarWidget extends BaseWidget {
    async render(canvas, runtime) {
        const c = this.config;
        const ctx = canvas.getContext("2d");
        const target = c.target;
        let ratio = 0, visible = 1;

        if(target && typeof target.scrollY === "number" && target.innerHeight) {
            const viewH = target.config.h || 1;
            ratio = viewH / Math.max(viewH, target.innerHeight);
            visible = Math.max(0.05, ratio);
            const progress = target.innerHeight > viewH
                ? -target.scrollY / (target.innerHeight - viewH)
                : 0;
            const h = Math.max(10, c.h * visible);
            const y = c.y + (c.h - h) * Math.min(1, Math.max(0, progress));
            fillRound(ctx, c.x, y, c.w, h, c.w / 2, colorOf(c.color, 0x888888));
        } else {
            fillRound(ctx, c.x, c.y, c.w, c.h, c.w / 2, colorOf(c.bg_color, 0x333333));
        }

        this.dropEvents(runtime, [c.x, c.y, c.x + c.w, c.y + c.h]);
    }
}

/* ---------------------------------------------------------------- DIALOG */
export class DialogWidget extends BaseWidget {
    init() {
        const c = this.config;
        this.visible = true;
        this.addEventListener("onmouseup", (info) => this.hit(info));
    }

    _layout() {
        const c = this.config;
        const w = c.w || Math.round(this.runtime.screen[0] * 0.8);
        const h = c.h || Math.round(this.runtime.screen[1] * 0.5);
        const x = c.x !== undefined ? c.x : Math.round((this.runtime.screen[0] - w) / 2);
        const y = c.y !== undefined ? c.y : Math.round((this.runtime.screen[1] - h) / 2);
        const btnH = 44;
        return {x, y, w, h, btnH};
    }

    hit(info) {
        const c = this.config;
        const {x, y, w, h, btnH} = this._layout();
        const py = info.y + this.runtime.player.config.renderScroll;
        if(info.x < x || info.x > x + w || py < y || py > y + h) return;
        if(py < y + h - btnH) return;

        if(info.x < x + w / 2) {
            if(!c.cancel_text) return;
            this.close();
            if(typeof c.cancel_func === "function") c.cancel_func(this);
        } else {
            if(!c.ok_text) return;
            this.close();
            if(typeof c.ok_func === "function") c.ok_func(this);
        }
    }

    close() {
        this.config.visible = false;
        this.visible = false;
        this.runtime.refresh_required = "dialog";
    }

    async render(canvas, runtime) {
        const c = this.config;
        const ctx = canvas.getContext("2d");
        const {x, y, w, h, btnH} = this._layout();
        const r = c.radius || 16;

        fillRound(ctx, 0, 0, runtime.screen[0], runtime.screen[1], 0, 0x000000, 0.45);
        fillRound(ctx, x, y, w, h, r, colorOf(c.content_bg_color, 0x2b2b2b));

        drawText(ctx, runtime, {
            text: c.text,
            text_size: c.content_text_size || 26,
            color: colorOf(c.content_text_color, 0xffffff),
            align_h: c.content_text_align_h || "center_h",
            align_v: c.content_text_align_v || "center_v"
        }, x + 12, y + 10, w - 24, h - btnH - 20);

        const half = w / 2;
        if(c.cancel_text) {
            fillRound(ctx, x + 8, y + h - btnH, half - 12, btnH - 8, 8,
                colorOf(c.cancel_nomal_color, 0x3a3a3a));
            drawText(ctx, runtime, {
                text: c.cancel_text, text_size: 24,
                color: colorOf(c.cancel_text_color, 0xffffff),
                align_h: "center_h", align_v: "center_v"
            }, x + 8, y + h - btnH, half - 12, btnH - 8);
        }

        if(c.ok_text) {
            const bx = c.cancel_text ? x + half : x + 8;
            fillRound(ctx, bx + 4, y + h - btnH, half - 12, btnH - 8, 8,
                colorOf(c.ok_nomal_color, 0x0078d7));
            drawText(ctx, runtime, {
                text: c.ok_text, text_size: 24,
                color: colorOf(c.ok_text_color, 0xffffff),
                align_h: "center_h", align_v: "center_v"
            }, bx + 4, y + h - btnH, half - 12, btnH - 8);
        }

        this.dropEvents(runtime, [x, y, x + w, y + h]);
    }
}

/* ------------------------------------------------------------ SPORT_DATA */
export class SportDataWidget extends BaseWidget {
    _value() {
        const pd = this.runtime.profileData || {};
        const key = (this.config.default_type || "").toString().toLowerCase();
        if(key.indexOf("heart") > -1) return pd.heartRate || 88;
        if(key.indexOf("step") > -1) return pd.steps || 6000;
        if(key.indexOf("cal") > -1) return pd.calories || 320;
        if(key.indexOf("dist") > -1) return pd.distance || 4.2;
        return this.config.text !== undefined ? this.config.text : "";
    }

    async render(canvas, runtime) {
        const c = this.config;
        const ctx = canvas.getContext("2d");
        const textW = c.text_w || c.w;
        const textH = c.text_h || c.h;

        if(c.rect_visible) {
            fillRound(ctx, c.x + (c.text_x || 0), c.y + (c.text_y || 0), textW, textH, 8,
                colorOf(c.line_color, 0x0000ff));
        }

        drawText(ctx, runtime, {
            text: this._value(),
            text_size: c.text_size || 36,
            color: colorOf(c.text_color, 0x0000ff),
            align_h: c.align_h, align_v: c.align_v
        }, c.x + (c.text_x || 0), c.y + (c.text_y || 0), textW, textH);

        if(c.sub_text_visible) {
            drawText(ctx, runtime, {
                text: c.sub_text || "",
                text_size: c.sub_text_size || 24,
                color: colorOf(c.sub_text_color, 0x0000ff)
            }, c.x + (c.sub_text_x || 0), c.y + (c.sub_text_y || 0),
                c.sub_text_w || c.w, c.sub_text_h || 30);
        }

        this.dropEvents(runtime, [c.x, c.y, c.x + c.w, c.y + c.h]);
    }
}

/* -------------------------------------------------------------- CYCLE_LIST */
class CycleListBase extends BaseWidget {
    init() {
        this.scrollY = 0;
        this.isMouseDown = false;
        this.startY = 0;
        this.startScroll = 0;
        this.addEventListener("onmousedown", (e) => {
            this.isMouseDown = true;
            this.startY = e.y;
            this.startScroll = this.scrollY;
        });
        this.addEventListener("onmousemove", (e) => {
            if(!this.isMouseDown) return;
            this.scrollY = this.startScroll - (e.y - this.startY);
            this._clamp();
        });
        this.addEventListener("onmouseup", (e) => {
            const moved = Math.abs(e.y - this.startY) > 6;
            this.isMouseDown = false;
            this._clamp();
            if(!moved) this._click(e);
        });
    }

    _items() {
        const list = this.config.data_array || this.config.data_list || [];
        return Array.isArray(list) ? list : [];
    }

    _itemHeight() {
        const n = Math.max(1, this.config.visible_items || this.config.show_count || 3);
        return (this.config.h || 0) / n;
    }

    _clamp() {
        this.scrollY = Math.max(0, Math.min(this.scrollY, this.config.h || 0));
        this.runtime.refresh_required = "cycle_list";
    }

    _click(e) {
        const index = Math.floor((e.y - this.config.y + this.scrollY) / this._itemHeight());
        const items = this._items();
        if(index < 0 || index >= items.length) return;
        const cb = this.config.item_click_func || this.config.click_func;
        if(typeof cb === "function") {
            try {
                cb(this, index);
            } catch (err) {
                console.warn("cycle list click failed", err);
            }
        }
    }

    async render(canvas, runtime) {
        const c = this.config;
        const ctx = canvas.getContext("2d");
        const items = this._items();
        const itemH = this._itemHeight();

        ctx.save();
        ctx.beginPath();
        ctx.rect(c.x, c.y, c.w, c.h);
        ctx.clip();

        for(let i = 0; i < items.length; i++) {
            const y = c.y + i * itemH - this.scrollY;
            if(y > c.y + c.h || y + itemH < c.y) continue;
            const item = items[i];
            const text = typeof item === "string" ? item : (item.text || "");
            const src = typeof item === "object" && item ? item.src : null;

            if(c.item_bg_color !== undefined) {
                fillRound(ctx, c.x, y + 2, c.w, itemH - 4, c.item_bg_radius || 8, c.item_bg_color);
            }

            let textX = c.x + 8;
            if(src && await drawSprite(ctx, runtime, src, c.x + 8, y + 4, itemH - 8, itemH - 8)) {
                textX = c.x + itemH + 8;
            }

            drawText(ctx, runtime, {
                text: text,
                text_size: c.text_size || 26,
                color: colorOf(c.text_color, 0xffffff),
                align_h: "center_h", align_v: "center_v"
            }, textX, y, c.w - (textX - c.x) - 8, itemH);
        }

        ctx.restore();
        this.dropEvents(runtime, [c.x, c.y, c.x + c.w, c.y + c.h]);
    }
}

export class CycleListWidget extends CycleListBase {}
export class CycleImageTextListWidget extends CycleListBase {}

/* ---------------------------------------------------- LIST_VIEW / VIRTUAL */
export class ListViewWidget extends ViewContainerWidget {}

export class VirtualContainerWidget extends ViewContainerWidget {}

/* ---------------------------------------------------------------- PICKER */
export class PickerWidget extends BaseWidget {
    init() {
        this.columns = (this.config.data_config || []).map((col, i) => {
            const data = col && col.data ? col.data : col;
            return {
                data: Array.isArray(data) ? data : [],
                index: Array.isArray(data)
                    ? Math.max(0, Math.min(data.length - 1, i === 0 ? (this.config.init_col_index || 0) : 0))
                    : 0
            };
        });
        this.isMouseDown = false;
        this.startY = 0;
        this.startIndex = 0;
        this.addEventListener("onmousedown", (e) => {
            this.isMouseDown = true;
            this.startY = e.y;
            const col = this._columnAt(e.x);
            this.startIndex = col >= 0 ? this.columns[col].index : 0;
        });
        this.addEventListener("onmouseup", (e) => {
            const moved = Math.abs(e.y - this.startY) > 12;
            const col = this._columnAt(e.x);
            this.isMouseDown = false;
            if(col < 0) return;
            const column = this.columns[col];
            if(moved) {
                const delta = e.y - this.startY > 0 ? -1 : 1;
                column.index = Math.max(0, Math.min(column.data.length - 1, this.startIndex + delta));
                this.runtime.refresh_required = "picker";
            } else if(e.y > this.config.y) {
                column.index = Math.min(column.data.length - 1, column.index + 1);
                this.runtime.refresh_required = "picker";
            }
            if(e.x > this.config.x + this.config.w - 60 && e.y < this.config.y + 40) {
                this._done();
            }
        });
    }

    _columnAt(x) {
        const c = this.config;
        const n = this.columns.length;
        if(!n) return -1;
        const w = c.w / n;
        const index = Math.floor((x - c.x) / w);
        return index >= 0 && index < n ? index : -1;
    }

    _done() {
        if(typeof this.config.picker_cb !== "function") return;
        const values = this.columns.map(c => c.data[c.index]);
        try {
            this.config.picker_cb({column: 0, index: this.columns[0].index, values: values});
        } catch (e) {
            console.warn("picker_cb failed", e);
        }
    }

    async render(canvas, runtime) {
        const c = this.config;
        const ctx = canvas.getContext("2d");
        const n = Math.max(1, this.columns.length);
        const colW = c.w / n;
        const rowH = (c.h - 60) / 3;

        fillRound(ctx, c.x, c.y, c.w, c.h, 12, 0x111111);

        if(c.title) {
            drawText(ctx, runtime, {
                text: c.title, text_size: 24, color: 0xffffff,
                align_h: "center_h", align_v: "center_v"
            }, c.x, c.y + 4, c.w, 30);
        }

        for(let i = 0; i < this.columns.length; i++) {
            const col = this.columns[i];
            const cx = c.x + i * colW;
            for(let row = -1; row <= 1; row++) {
                const idx = col.index + row;
                if(idx < 0 || idx >= col.data.length) continue;
                drawText(ctx, runtime, {
                    text: String(col.data[idx]),
                    text_size: row === 0 ? (c.select_text_size || 30) : (c.text_size || 24),
                    color: row === 0 ? colorOf(c.select_color, 0x00c8ff) : colorOf(c.normal_color, 0x888888),
                    align_h: "center_h", align_v: "center_v"
                }, cx, c.y + 40 + (row + 1) * rowH, colW, rowH);
            }
        }

        this.dropEvents(runtime, [c.x, c.y, c.x + c.w, c.y + c.h]);
    }
}

/* -------------------------------------------------- PICK_DATE / TIME_PICK */
class DateLikePicker extends BaseWidget {
    init() {
        const c = this.config;
        const now = new Date();
        this.values = {
            year: c.initYear || now.getFullYear(),
            month: c.initMonth || now.getMonth() + 1,
            day: c.initDay || now.getDate(),
            hour: c.initHour !== undefined ? c.initHour : now.getHours(),
            minute: c.initMin !== undefined ? c.initMin : now.getMinutes()
        };
        this.addEventListener("onmouseup", (e) => this.hit(e));
    }

    hit(e) {
        const c = this.config;
        const y = e.y + this.runtime.player.config.renderScroll;
        if(y < c.y - 20 || y > c.y + (c.h || 80) + 20) return;
        const w = c.w || 300;
        const idx = Math.floor((e.x - c.x) / (w / this._columnCount()));
        this._bump(idx);
        this.runtime.refresh_required = "date_picker";
    }

    _columnCount() {
        return 3;
    }

    _bump(index) {
        const v = this.values;
        if(this._hasTime() && index >= 3) {
            if(index === 3) v.hour = (v.hour + 1) % 24;
            else v.minute = (v.minute + 1) % 60;
            return;
        }
        if(index === 0) v.year = Math.min(this.config.endYear || 2100, v.year + 1);
        if(index === 1) v.month = v.month % 12 + 1;
        if(index === 2) v.day = v.day % 31 + 1;
    }

    _hasTime() {
        return this.config.type === 0;
    }

    _labels() {
        const v = this.values;
        if(this._hasTime()) return [v.year, v.month, v.day, v.hour, v.minute]
            .map(x => String(x).padStart(2, "0"));
        return [v.year, String(v.month).padStart(2, "0"), String(v.day).padStart(2, "0")];
    }

    async render(canvas, runtime) {
        const c = this.config;
        const ctx = canvas.getContext("2d");
        const w = c.w || 300;
        const h = c.h || 80;
        const labels = this._labels();
        const colW = w / labels.length;
        const size = c.select_font_size || c.font_size || 30;

        fillRound(ctx, c.x, c.y, w, h, 10, 0x111111);
        for(let i = 0; i < labels.length; i++) {
            drawText(ctx, runtime, {
                text: labels[i],
                text_size: size,
                color: colorOf(c.select_color, 0x00c8ff),
                align_h: "center_h", align_v: "center_v"
            }, c.x + i * colW, c.y, colW, h);
        }

        this.dropEvents(runtime, [c.x, c.y, c.x + w, c.y + h]);
    }
}

export class PickDateWidget extends DateLikePicker {}
export class TimePickerWidget extends DateLikePicker {}

/* -------------------------------------------------------------- KEYBOARD */
export class KeyboardWidget extends BaseWidget {
    init() {
        this.addEventListener("onmouseup", (e) => this.hit(e));
    }

    _keys() {
        if(Array.isArray(this.config.key_attr) && this.config.key_attr.length) {
            return this.config.key_attr;
        }
        const keys = [];
        const cols = 3, rows = 4;
        const w = this.config.w || this.runtime.screen[0];
        const h = this.config.h || 200;
        const kw = w / cols, kh = h / rows;
        const labels = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
        for(let i = 0; i < labels.length; i++) {
            keys.push({
                x: this.config.x + (i % cols) * kw,
                y: this.config.y + Math.floor(i / cols) * kh,
                w: kw, h: kh, text: labels[i]
            });
        }
        return keys;
    }

    hit(e) {
        const y = e.y + this.runtime.player.config.renderScroll;
        for(const key of this._keys()) {
            const x = key.x !== undefined ? key.x : this.config.x;
            const ky = key.y !== undefined ? key.y : this.config.y;
            const w = key.w || 40;
            const h = key.h || 40;
            if(e.x >= x && e.x <= x + w && y >= ky && y <= ky + h) {
                if(typeof this.config.click_func === "function") {
                    try {
                        this.config.click_func({x: e.x, y: ky, key: key.text});
                    } catch (err) {
                        console.warn("keyboard click_func failed", err);
                    }
                }
                return;
            }
        }
    }

    async render(canvas, runtime) {
        const c = this.config;
        const ctx = canvas.getContext("2d");
        const keys = this._keys();

        for(const key of keys) {
            const x = key.x !== undefined ? key.x : c.x;
            const y = key.y !== undefined ? key.y : c.y;
            const w = key.w || 40;
            const h = key.h || 40;
            fillRound(ctx, x + 2, y + 2, w - 4, h - 4, 8, colorOf(key.bg_color, 0x333333));
            drawText(ctx, runtime, {
                text: key.text || "",
                text_size: key.text_size || 26,
                color: colorOf(key.color, 0xffffff),
                align_h: "center_h", align_v: "center_v"
            }, x, y, w, h);
        }

        this.dropEvents(runtime, [c.x, c.y, c.x + (c.w || runtime.screen[0]), c.y + (c.h || runtime.screen[1])]);
    }
}

export class SystemKeyboardWidget extends KeyboardWidget {}
