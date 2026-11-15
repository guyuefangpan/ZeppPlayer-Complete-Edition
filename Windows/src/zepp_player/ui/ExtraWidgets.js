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

import { BaseWidget } from "./widget/BaseWidget.ts";
import { zeppColorToHex } from "../Utils.js";
import { ImageWidget, MissingWidget } from "./ImagingWidgets.js";
import { TextWidget } from "./widget/TextWidget";

/**
 * Misc helpers. All of them are tolerant to missing/invalid values because
 * real apps often omit optional params.
 */

function num(value, fallback = 0) {
    return typeof value === "number" && isFinite(value) ? value : fallback;
}

function colorAt(value, fallback = 0x000000) {
    return value === undefined || value === null ? fallback : value;
}

function colorWithAlpha(value, alpha) {
    const hex = zeppColorToHex(value);
    if (typeof hex !== "string" || hex[0] !== "#" || hex.length < 7)
        return hex;

    const r = parseInt(hex.substring(1, 3), 16) || 0;
    const g = parseInt(hex.substring(3, 5), 16) || 0;
    const b = parseInt(hex.substring(5, 7), 16) || 0;
    const a = Math.max(0, Math.min(1, typeof alpha === "number" ? alpha : 1));

    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function roundRect(ctx, x, y, w, h, radius) {
    const r = Math.max(0, Math.min(num(radius), Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath();

    if (r === 0) {
        ctx.rect(x, y, w, h);
        return;
    }

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
}

function ellipsePath(ctx, cx, cy, rx, ry) {
    rx = Math.max(0, num(rx));
    ry = Math.max(0, num(ry));

    if (typeof ctx.ellipse === "function") {
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        return;
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx || 1, ry || 1);
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.restore();
}

function scaledArcPath(ctx, cx, cy, rx, ry, startDeg, endDeg, includeCenter) {
    const start = num(startDeg) * Math.PI / 180;
    const end = num(endDeg) * Math.PI / 180;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(Math.max(0, num(rx)) || 1, Math.max(0, num(ry)) || 1);
    if (includeCenter) ctx.moveTo(0, 0);
    ctx.arc(0, 0, 1, start, end);
    ctx.restore();
}

/**
 * hmUI.widget.SLIDE_SWITCH
 *
 * Supported props: checked, visible, x, y, w, h, select_bg, un_select_bg,
 * slide_src, slide_select_x, slide_un_select_x, slide_y
 * Callback: checked_change_func(slideSwitch, checked)
 */
export class SlideSwitchWidget extends BaseWidget {
    constructor(config) {
        super(config);
        if (typeof this.config.checked !== "boolean") this.config.checked = !!this.config.checked;
        this.addEventListener("onmouseup", () => this.toggle());
    }

    get checked() {
        return !!this.config.checked;
    }

    setProperty(prop, val) {
        if (prop === "checked") {
            this.config.checked = !!val;
            if (this.runtime) this.runtime.refresh_required = "set_prop";
            return;
        }

        super.setProperty(prop, val);
    }

    toggle() {
        const config = this.config;
        config.checked = !config.checked;
        if (this.runtime) this.runtime.refresh_required = "set_prop";

        if (typeof config.checked_change_func === "function") {
            try {
                config.checked_change_func(this, config.checked);
            } catch(e) {
                console.warn("SLIDE_SWITCH checked_change_func failed", e);
            }
        }
    }

    async render(canvas, runtime) {
        runtime = runtime || this.runtime;
        if (!runtime) return;

        const config = this.config;
        const x = num(config.x), y = num(config.y);
        const w = Math.max(0, num(config.w)), h = Math.max(0, num(config.h));
        if (w === 0 || h === 0) return;

        const bgSrc = config.checked ? config.select_bg : config.un_select_bg;
        let drawn = false;

        if (bgSrc) {
            try {
                const img = await runtime.getAssetImage(bgSrc);
                ImageWidget.draw(img, canvas, runtime, { x, y, w, h, auto_scale: true });
                drawn = true;
            } catch(e) {}
        }

        if (!drawn) {
            const ctx = canvas.getContext("2d");
            const color = config.checked
                ? colorAt(config.select_color, 0x00b26b)
                : colorAt(config.un_select_color, 0x444444);
            ctx.fillStyle = zeppColorToHex(color);
            roundRect(ctx, x, y, w, h, h / 2);
            ctx.fill();
        }

        const slideX = x + num(config.checked ? config.slide_select_x : config.slide_un_select_x);
        const slideY = y + num(config.slide_y);
        let knobDrawn = false;

        if (config.slide_src) {
            try {
                const img = await runtime.getAssetImage(config.slide_src);
                ImageWidget.draw(img, canvas, runtime, { x: slideX, y: slideY });
                knobDrawn = true;
            } catch(e) {}
        }

        if (!knobDrawn) {
            const ctx = canvas.getContext("2d");
            const radius = Math.max(1, (h - Math.max(2, h * 0.16)) / 2);
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(slideX + radius, slideY + h / 2, radius, 0, Math.PI * 2);
            ctx.fill();
        }

        this.dropEvents(runtime, [x, y, x + w, y + h]);
    }
}

/**
 * hmUI.widget.STATE_BUTTON used inside CHECKBOX_GROUP.
 */
export class CheckboxStateButtonWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this.addEventListener("onmouseup", () => {
            const group = this.config.__checkboxGroup;
            if (group && typeof group._toggle === "function") group._toggle(this);
        });
    }

    async render(canvas, runtime) {
        runtime = runtime || this.runtime;
        const config = this.config;
        const group = config.__checkboxGroup;
        if (!runtime || !group) return;

        const groupConfig = group.config;
        const x = num(config.x), y = num(config.y);
        const w = Math.max(0, num(config.w)), h = Math.max(0, num(config.h));
        const checked = group._isChecked(this);

        const src = checked ? groupConfig.select_src : groupConfig.unselect_src;
        let drawn = false;

        if (src) {
            try {
                const img = await runtime.getAssetImage(src);
                ImageWidget.draw(img, canvas, runtime, {
                    x: x + num(groupConfig.x),
                    y: y + num(groupConfig.y)
                });
                drawn = true;
            } catch(e) {}
        }

        if (!drawn) {
            const ctx = canvas.getContext("2d");
            const fillW = Math.max(0, num(config.fill_width, w));
            const fillH = Math.max(0, num(config.fill_height, h));
            const color = checked
                ? colorAt(config.select_color, colorAt(groupConfig.select_color, 0x00b26b))
                : colorAt(config.unselect_color, colorAt(groupConfig.unselect_color, 0x444444));

            ctx.fillStyle = zeppColorToHex(color);
            roundRect(ctx, x + num(groupConfig.x), y + num(groupConfig.y),
                fillW, fillH, Math.min(fillW, fillH) / 2);
            ctx.fill();
        }

        this.dropEvents(runtime, [x, y, x + w, y + h]);
    }
}

/**
 * hmUI.widget.CHECKBOX_GROUP
 *
 * Supported props: checked (set a STATE_BUTTON), unchecked (set a STATE_BUTTON)
 * Callback: check_func(group, index, checked)
 */
export class CheckboxGroupWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this.widgets = [];
        this.checkedFlags = [];
        this._counter = 0;
        config.__content = this.widgets;
    }

    createWidget(type, widgetConfig) {
        if (typeof widgetConfig !== "object" || widgetConfig === null) widgetConfig = {};

        let Widget = MissingWidget;
        if (type === "STATE_BUTTON") Widget = CheckboxStateButtonWidget;

        widgetConfig.__widget = type;
        widgetConfig.__id = ((num(this.config.__id, 0) + 1) << 8) + this._counter;
        widgetConfig.__runtime = this.runtime;

        if (type === "STATE_BUTTON") {
            widgetConfig.__checkboxGroup = this;
            widgetConfig.__index = this._counter;
        }

        this._counter++;
        const widget = new Widget(widgetConfig);
        this.widgets.push(widget);

        if (this.runtime) this.runtime.refresh_required = "add_widget_group";
        return widget;
    }

    _isStateButton(value) {
        return !!(value && value.config && value.config.__checkboxGroup === this);
    }

    _isChecked(button) {
        return !!this.checkedFlags[num(button.config.__index, -1)];
    }

    _setChecked(button, checked) {
        const index = num(button.config.__index, -1);
        if (index < 0) return;

        const previous = !!this.checkedFlags[index];
        this.checkedFlags[index] = !!checked;

        if (this.runtime) this.runtime.refresh_required = "set_prop";

        if (previous !== !!checked && typeof this.config.check_func === "function") {
            try {
                this.config.check_func(this, index, !!checked);
            } catch(e) {
                console.warn("CHECKBOX_GROUP check_func failed", e);
            }
        }
    }

    _toggle(button) {
        this._setChecked(button, !this._isChecked(button));
    }

    setProperty(prop, val) {
        if (this._isStateButton(val)) {
            if (prop === "unchecked") {
                this._setChecked(val, false);
                return;
            }
            /* prop.INIT and prop.CHECKED both resolve to "checked" in this
             * simulator, so an unknown prop is treated as "check" as well. */
            if (prop === "checked" || prop === "init" || prop === undefined) {
                this._setChecked(val, true);
                return;
            }
        }

        super.setProperty(prop, val);
    }

    getProperty(key, second) {
        if (key === "checked") {
            if (typeof second === "number") return !!this.checkedFlags[second];
            return this.checkedFlags.map(checked => !!checked);
        }

        return super.getProperty(key, second);
    }

    async render(canvas, runtime) {
        runtime = runtime || this.runtime;
        if (!runtime) return;

        for(let i in this.widgets) {
            const widget = this.widgets[i];
            widget.config.__eventOffsetX = this.config.x;
            widget.config.__eventOffsetY = this.config.y;
            await runtime.renderWidget(widget, canvas);
        }
    }
}

/**
 * hmUI.widget.PAGE_INDICATOR
 *
 * Optional props (in addition to the official ones): count, current_page /
 * current_index, because the swiper itself is not emulated.
 */
export class PageIndicatorWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this._images = new Map();
    }

    _pageState() {
        const config = this.config;
        let count = config.count !== undefined ? config.count
            : (config.page_count !== undefined ? config.page_count : undefined);
        let current = config.current_page !== undefined ? config.current_page
            : (config.current_index !== undefined ? config.current_index : undefined);

        const runtime = this.runtime;
        const player = runtime && runtime.player;

        if (runtime) {
            if (count === undefined) {
                if (typeof runtime.pageCount === "number") count = runtime.pageCount;
                else if (typeof runtime.page_count === "number") count = runtime.page_count;
            }
            if (current === undefined) {
                if (typeof runtime.currentPage === "number") current = runtime.currentPage;
                else if (typeof runtime.current_page === "number") current = runtime.current_page;
            }
        }

        const sources = [
            runtime && runtime.swiper,
            runtime && runtime.swiperState,
            runtime && runtime.swiperOptions,
            runtime && runtime.scrollMode && runtime.scrollMode.options,
            runtime && runtime.pageScrollMode && runtime.pageScrollMode.options,
            player && player.swiper,
            player && player.swiperState,
            player && player.config && player.config.swiper
        ];

        for(const source of sources) {
            if (!source || typeof source !== "object") continue;

            if (count === undefined) {
                if (typeof source.count === "number") count = source.count;
                else if (typeof source.page_count === "number") count = source.page_count;
                else if (typeof source.total === "number") count = source.total;
            }

            if (current === undefined) {
                if (typeof source.current_page === "number") current = source.current_page;
                else if (typeof source.current === "number") current = source.current;
                else if (typeof source.index === "number") current = source.index;
                else if (typeof source.current_index === "number") current = source.current_index;
            }
        }

        const total = Math.max(0, Math.round(num(count, 0)));
        let active = Math.round(num(current, 0));
        if (total > 0) active = Math.max(0, Math.min(total - 1, active));
        else active = 0;

        return { total, active };
    }

    async _getImage(runtime, src) {
        if (!src) return null;
        if (this._images.has(src)) return this._images.get(src);

        try {
            const image = await runtime.getAssetImage(src);
            this._images.set(src, image);
            return image;
        } catch(e) {
            this._images.set(src, null);
            return null;
        }
    }

    setProperty(prop, val) {
        if (prop === "count" || prop === "page_count" || prop === "total") {
            this.config.count = val;
            if (this.runtime) this.runtime.refresh_required = "set_prop";
            return;
        }

        if (prop === "current_page" || prop === "current_index" || prop === "checked") {
            this.config.current_page = num(val, 0);
            if (this.runtime) this.runtime.refresh_required = "set_prop";
            return;
        }

        super.setProperty(prop, val);
    }

    async render(canvas, runtime) {
        runtime = runtime || this.runtime;
        if (!runtime) return;

        const config = this.config;
        const { total, active } = this._pageState();
        if (total <= 0) return;

        const ctx = canvas.getContext("2d");
        const x = num(config.x), y = num(config.y);
        const w = Math.max(0, num(config.w)), h = Math.max(0, num(config.h));
        const useColor = !!config.use_color;
        const horizontal = config.horizontal !== false;

        const items = [];
        for(let i = 0; i < total; i++) {
            const checked = i === active;
            let image = null;

            if (!useColor) {
                image = await this._getImage(runtime, checked ? config.select_src : config.unselect_src);
            }

            const size = Math.max(1, Math.round(num(config.element_height, useColor ? (h || 8) : 8)));
            items.push({
                checked,
                image,
                width: image ? image.width : size,
                height: image ? image.height : size
            });
        }

        const gap = Math.max(0, Math.round(num(
            horizontal ? config.h_space : config.v_space,
            num(config.h_space, 8)
        )));

        if (horizontal) {
            let totalWidth = 0;
            for(const item of items) totalWidth += item.width;
            totalWidth += gap * Math.max(0, items.length - 1);

            let px = x;
            if (config.align_h === "center_h") px = x + Math.max(0, (w - totalWidth) / 2);
            else if (config.align_h === "right") px = x + Math.max(0, w - totalWidth);

            for(const item of items) {
                const py = y + Math.max(0, (h - item.height) / 2);
                this._drawItem(ctx, item, px, py, config);
                px += item.width + gap;
            }
        } else {
            let py = y;
            for(const item of items) {
                let px = x;
                if (config.align_h === "center_h") px = x + Math.max(0, (w - item.width) / 2);
                else if (config.align_h === "right") px = x + Math.max(0, w - item.width);

                this._drawItem(ctx, item, px, py, config);
                py += item.height + gap;
            }
        }
    }

    _drawItem(ctx, item, px, py, config) {
        if (item.image) {
            try {
                ctx.drawImage(item.image, Math.round(px), Math.round(py));
                return;
            } catch(e) {}
        }

        const radius = Math.max(1, num(config.element_radius,
            Math.max(1, (item.checked ? num(config.element_height, item.height) : item.height) / 2)));
        const size = radius * 2;

        ctx.fillStyle = zeppColorToHex(item.checked
            ? colorAt(config.select_color, 0xffffff)
            : colorAt(config.unselect_color, 0x555555));
        ctx.beginPath();
        ctx.arc(px + size / 2, py + (item.height || size) / 2, radius, 0, Math.PI * 2);
        ctx.fill();
    }
}

/**
 * hmUI.widget.PAGE_SCROLLBAR
 *
 * Official props: target (optional VIEW_CONTAINER). Everything else is
 * derived from the page scroll position.
 */
export class PageScrollbarWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this.target = null;
    }

    _resolveTarget() {
        const target = this.target || this.config.target;
        if (!target || typeof target !== "object" || !target.config) return null;
        if (typeof target.scrollY !== "number" || typeof target.innerHeight !== "number") return null;
        return target;
    }

    setProperty(prop, val) {
        if (prop === "target") {
            this.target = val;
            if (this.runtime) this.runtime.refresh_required = "set_prop";
            return;
        }

        if (prop === undefined && val && typeof val === "object" && val.config) {
            this.target = val;
            if (this.runtime) this.runtime.refresh_required = "set_prop";
            return;
        }

        if (prop === "more" && val && typeof val === "object" && val.target) {
            this.target = val.target;
        }

        super.setProperty(prop, val);
    }

    async render(canvas, runtime) {
        runtime = runtime || this.runtime;
        if (!runtime) return;

        const config = this.config;
        const screen = runtime.screen || [480, 480];
        const screenW = num(screen[0], 480);
        const screenH = num(screen[1], 480);
        const target = this._resolveTarget();

        let areaX = 0, areaY = 0, areaW = screenW, areaH = screenH;
        let scroll = 0, contentHeight = screenH;

        if (target) {
            const targetConfig = target.config;
            areaX = num(targetConfig.x);
            areaY = num(targetConfig.y);
            areaW = Math.max(0, num(targetConfig.w, screenW));
            areaH = Math.max(0, num(targetConfig.h, screenH));
            scroll = -Math.min(0, num(target.scrollY, 0));
            contentHeight = Math.max(areaH, num(target.innerHeight, areaH));
        } else {
            const player = runtime.player;
            scroll = num(player && player.config && player.config.renderScroll, 0);
            contentHeight = Math.max(screenH, num(runtime.contentHeight, screenH));
        }

        const maxScroll = contentHeight - areaH;
        if (maxScroll <= 0 || areaW <= 0 || areaH <= 0) return;

        const barW = Math.max(2, Math.round(num(config.w, num(config.bar_width, 4))));
        const margin = Math.max(0, num(config.margin, 2));
        const minThumb = Math.max(16, Math.round(areaH * 0.08));
        const thumbH = Math.max(minThumb, Math.round(areaH * areaH / contentHeight));
        const progress = Math.max(0, Math.min(1, scroll / maxScroll));

        const px = Math.round(areaX + areaW - barW - margin);
        const py = Math.round(areaY + progress * (areaH - thumbH));

        const ctx = canvas.getContext("2d");
        ctx.fillStyle = colorWithAlpha(colorAt(config.color, 0xaaaaaa), num(config.opacity, 0.6));
        roundRect(ctx, px, py, barW, thumbH, barW / 2);
        ctx.fill();
    }
}

/**
 * hmUI.widget.DIALOG
 *
 * Supported props: visible / show, text, content_text_size,
 * content_text_color, content_bg_color, content_text_align_h/_v, ok_text,
 * ok_text_color, ok_press_color, ok_nomal_color, ok_press_src, ok_nomal_src,
 * cancel_* (same set), dialog_align_h, dialog_align_v
 * Callbacks: ok_func(dialog), cancel_func(dialog)
 */
export class DialogWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this._renderStage = "toplevel";
        this._pressed = null;

        /* Dialog stays hidden until prop.SHOW is set, as on a real device. */
        this.config.visible = false;

        /* A zone covering the whole screen which swallows taps on the mask. */
        this.addEventListener("onmousedown", () => {});
        this.addEventListener("onmouseup", () => { this._pressed = null; });
    }

    setProperty(prop, val) {
        if (prop === "show" || prop === "visible") {
            this.config.visible = !!val;
            if (this.runtime) this.runtime.refresh_required = "dialog";
            return;
        }

        /* prop.SHOW is not present in the simulator prop table, so official
         * code ends up passing `undefined` here. A boolean value can only
         * mean "show/hide" in that case. */
        if (prop === undefined && typeof val === "boolean") {
            this.config.visible = val;
            if (this.runtime) this.runtime.refresh_required = "dialog";
            return;
        }

        super.setProperty(prop, val);
    }

    _activate(kind) {
        if (!this.config.visible) return;

        this.config.visible = false;
        if (this.runtime) this.runtime.refresh_required = "dialog";

        const callback = kind === "ok" ? this.config.ok_func : this.config.cancel_func;
        if (typeof callback === "function") {
            try {
                callback(this);
            } catch(e) {
                console.warn("DIALOG callback failed", e);
            }
        }
    }

    async _drawButton(canvas, runtime, box, options) {
        const ctx = canvas.getContext("2d");
        const pressed = this._pressed === options.key;
        const src = pressed ? options.press_src : options.nomal_src;
        let drawn = false;

        if (src) {
            try {
                const img = await runtime.getAssetImage(src);
                ImageWidget.draw(img, canvas, runtime, {
                    x: box.x,
                    y: box.y,
                    w: box.w,
                    h: box.h,
                    auto_scale: true
                });
                drawn = true;
            } catch(e) {}
        }

        if (!drawn) {
            const color = pressed
                ? colorAt(options.press_color, 0x3a3a3a)
                : colorAt(options.nomal_color, 0x2a2a2a);
            ctx.fillStyle = zeppColorToHex(color);
            roundRect(ctx, box.x, box.y, box.w, box.h, 10);
            ctx.fill();
        }

        if (options.text === undefined || options.text === null || options.text === "") return;

        try {
            const layer = TextWidget.drawText({
                text: String(options.text),
                text_size: options.text_size,
                color: colorAt(options.text_color, 0xffffff),
                align_h: "center_h",
                align_v: "center_v",
                w: box.w,
                h: box.h,
                text_style: 0
            }, runtime);
            if (layer) ctx.drawImage(layer, box.x, box.y);
        } catch(e) {}
    }

    async render(canvas, runtime) {
        runtime = runtime || this.runtime;
        if (!runtime) return;

        const config = this.config;
        const screen = runtime.screen || [480, 480];
        const screenW = num(screen[0], 480);
        const screenH = num(screen[1], 480);
        const ctx = canvas.getContext("2d");

        // Dim overlay
        ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
        ctx.fillRect(0, 0, screenW, screenH);

        const pad = 16;
        const cardW = Math.max(120, Math.round(Math.min(screenW - 24, num(config.w, screenW * 0.86))));
        const textW = Math.max(1, cardW - pad * 2);
        const textSize = Math.max(1, Math.round(num(config.content_text_size,
            runtime.profileData && runtime.profileData.defaultFontSize || 30)));

        const hasOk = config.ok_text !== undefined && config.ok_text !== null && String(config.ok_text) !== "";
        const hasCancel = config.cancel_text !== undefined && config.cancel_text !== null
            && String(config.cancel_text) !== "";
        const hasButtons = hasOk || hasCancel;

        const btnH = Math.max(28, Math.round(textSize * 1.5));
        const gap = 10;

        const textConf = {
            text: config.text === undefined || config.text === null ? "" : String(config.text),
            text_size: textSize,
            color: colorAt(config.content_text_color, 0xffffff),
            align_h: config.content_text_align_h || "center_h",
            align_v: config.content_text_align_v || "center_v",
            w: textW,
            h: 0,
            text_style: 2,
            char_space: 0,
            line_space: 0
        };

        let textH = 0;
        if (textConf.text !== "") {
            try {
                const metrics = TextWidget.drawText({ ...textConf, _metricsOnly: true }, runtime);
                textH = Math.max(0, Math.round(num(metrics && metrics.height, 0)));
            } catch(e) {
                textH = textSize;
            }
        }

        let cardH = pad * 2 + textH + (hasButtons ? btnH + gap : 0);
        cardH = Math.max(80, Math.min(screenH - 24, Math.round(cardH)));

        let cardX = Math.round((screenW - cardW) / 2);
        if (config.dialog_align_h === "left") cardX = 12;
        else if (config.dialog_align_h === "right") cardX = screenW - cardW - 12;

        let cardY = Math.round((screenH - cardH) / 2);
        if (config.dialog_align_v === "top") cardY = 12;
        else if (config.dialog_align_v === "bottom") cardY = screenH - cardH - 12;

        ctx.fillStyle = zeppColorToHex(colorAt(config.content_bg_color, 0x111111));
        roundRect(ctx, cardX, cardY, cardW, cardH, num(config.radius, 16));
        ctx.fill();

        if (textH > 0) {
            try {
                const layer = TextWidget.drawText({
                    ...textConf,
                    h: Math.min(textH, Math.max(1, cardH - pad * 2))
                }, runtime);
                if (layer) ctx.drawImage(layer, cardX + pad, cardY + pad);
            } catch(e) {}
        }

        const zones = [];
        if (hasButtons) {
            const btnY = cardY + cardH - pad - btnH;
            const availableW = cardW - pad * 2 - (hasOk && hasCancel ? gap : 0);
            const btnW = hasOk && hasCancel ? Math.round(availableW / 2) : availableW;
            let btnX = cardX + pad;

            if (hasCancel) {
                const box = { x: btnX, y: btnY, w: btnW, h: btnH };
                await this._drawButton(canvas, runtime, box, {
                    key: "cancel",
                    text: config.cancel_text,
                    text_color: config.cancel_text_color,
                    text_size: textSize,
                    press_src: config.cancel_press_src,
                    nomal_src: config.cancel_nomal_src,
                    press_color: config.cancel_press_color,
                    nomal_color: config.cancel_nomal_color
                });
                zones.push({ kind: "cancel", box });
                if (hasOk) btnX += btnW + gap;
            }

            if (hasOk) {
                const box = { x: btnX, y: btnY, w: btnW, h: btnH };
                await this._drawButton(canvas, runtime, box, {
                    key: "ok",
                    text: config.ok_text,
                    text_color: config.ok_text_color,
                    text_size: textSize,
                    press_src: config.ok_press_src,
                    nomal_src: config.ok_nomal_src,
                    press_color: config.ok_press_color,
                    nomal_color: config.ok_nomal_color
                });
                zones.push({ kind: "ok", box });
            }
        }

        // Mask zone first, button zones on top of it.
        this.dropEvents(runtime, [0, 0, screenW, screenH]);

        for(const zone of zones) {
            const box = zone.box;
            const kind = zone.kind;
            runtime.dropEvents({
                onmousedown: () => {
                    this._pressed = kind;
                    runtime.refresh_required = "dialog";
                },
                onmouseup: () => {
                    this._pressed = null;
                    this._activate(kind);
                }
            }, box.x, box.y, box.x + box.w, box.y + box.h);
        }
    }
}

/**
 * hmUI.widget.CANVAS
 *
 * Keeps an offscreen canvas of w/h, exposes `getContext("2d")` to the app and
 * blits it on every render. Drawing is done through the official canvas API.
 */
export class CanvasWidget extends BaseWidget {
    init() {
        this._canvas = null;
        this._context = null;
        this._proxy = null;
        this._paint = { color: 0xffffff, line_width: 1 };
        this._initCanvas(this.runtime);
    }

    _initCanvas(runtime) {
        if (!runtime || typeof runtime.newCanvas !== "function") return;

        const w = Math.max(1, Math.round(num(this.config.w, 1)));
        const h = Math.max(1, Math.round(num(this.config.h, 1)));

        try {
            const canvas = runtime.newCanvas();
            canvas.width = w;
            canvas.height = h;
            this._canvas = canvas;
            this._context = canvas.getContext("2d");
            this._proxy = null;
        } catch(e) {
            console.warn("CANVAS init failed", e);
        }
    }

    _touch() {
        if (this.runtime) this.runtime.refresh_required = "canvas";
    }

    getContext(type) {
        if (type !== "2d" || !this._context) return null;
        if (this._proxy) return this._proxy;

        const target = this._context;
        const widget = this;

        try {
            this._proxy = new Proxy(target, {
                get(object, key) {
                    const value = object[key];
                    if (typeof value === "function") {
                        return function() {
                            const result = value.apply(object, arguments);
                            widget._touch();
                            return result;
                        };
                    }
                    return value;
                },
                set(object, key, value) {
                    object[key] = value;
                    widget._touch();
                    return true;
                }
            });
        } catch(e) {
            this._proxy = target;
        }

        return this._proxy;
    }

    _style(color) {
        return zeppColorToHex(colorAt(color, this._paint.color));
    }

    _strokeStyle(ctx, color) {
        ctx.strokeStyle = this._style(color);
        ctx.lineWidth = Math.max(1, num(this._paint.line_width, 1));
    }

    setPaint(option) {
        if (!option || typeof option !== "object") return;
        if (option.color !== undefined) this._paint.color = option.color;
        if (typeof option.line_width === "number") this._paint.line_width = option.line_width;
        this._touch();
    }

    drawPixel(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        ctx.fillStyle = this._style(option.color);
        ctx.fillRect(num(option.x), num(option.y), 1, 1);
        this._touch();
    }

    drawLine(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        this._strokeStyle(ctx, option.color);
        ctx.beginPath();
        ctx.moveTo(num(option.x1), num(option.y1));
        ctx.lineTo(num(option.x2), num(option.y2));
        ctx.stroke();
        this._touch();
    }

    drawRect(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        const x1 = num(option.x1), y1 = num(option.y1);
        ctx.fillStyle = this._style(option.color);
        ctx.fillRect(x1, y1, num(option.x2) - x1, num(option.y2) - y1);
        this._touch();
    }

    strokeRect(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        const x1 = num(option.x1), y1 = num(option.y1);
        this._strokeStyle(ctx, option.color);
        ctx.strokeRect(x1, y1, num(option.x2) - x1, num(option.y2) - y1);
        this._touch();
    }

    drawCircle(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        ctx.fillStyle = this._style(option.color);
        ctx.beginPath();
        ctx.arc(num(option.center_x), num(option.center_y), Math.max(0, num(option.radius)), 0, Math.PI * 2);
        ctx.fill();
        this._touch();
    }

    strokeCircle(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        this._strokeStyle(ctx, option.color);
        ctx.beginPath();
        ctx.arc(num(option.center_x), num(option.center_y), Math.max(0, num(option.radius)), 0, Math.PI * 2);
        ctx.stroke();
        this._touch();
    }

    drawEllipse(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        ctx.fillStyle = this._style(option.color);
        ctx.beginPath();
        ellipsePath(ctx, num(option.center_x), num(option.center_y),
            num(option.radius_x), num(option.radius_y));
        ctx.fill();
        this._touch();
    }

    strokeEllipse(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        this._strokeStyle(ctx, option.color);
        ctx.beginPath();
        ellipsePath(ctx, num(option.center_x), num(option.center_y),
            num(option.radius_x), num(option.radius_y));
        ctx.stroke();
        this._touch();
    }

    drawArc(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        ctx.fillStyle = this._style(option.color);
        ctx.beginPath();
        scaledArcPath(ctx, num(option.center_x), num(option.center_y),
            num(option.radius_x), num(option.radius_y),
            option.start_angle, option.end_angle, true);
        ctx.closePath();
        ctx.fill();
        this._touch();
    }

    strokeArc(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        this._strokeStyle(ctx, option.color);
        ctx.beginPath();
        scaledArcPath(ctx, num(option.center_x), num(option.center_y),
            num(option.radius_x), num(option.radius_y),
            option.start_angle, option.end_angle, false);
        ctx.stroke();
        this._touch();
    }

    _polyPath(ctx, data) {
        if (!Array.isArray(data) || data.length < 2) return false;

        let started = false;
        for(const point of data) {
            if (!point || typeof point !== "object") continue;
            const px = num(point.x), py = num(point.y);
            if (!started) {
                ctx.moveTo(px, py);
                started = true;
            } else {
                ctx.lineTo(px, py);
            }
        }

        return started;
    }

    drawPoly(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        ctx.fillStyle = this._style(option.color);
        ctx.beginPath();
        if (this._polyPath(ctx, option.data_array)) {
            ctx.closePath();
            ctx.fill();
        }
        this._touch();
    }

    strokePoly(option) {
        const ctx = this._context;
        if (!ctx || !option) return;
        this._strokeStyle(ctx, option.color);
        ctx.beginPath();
        if (this._polyPath(ctx, option.data_array)) ctx.stroke();
        this._touch();
    }

    drawText(option) {
        const ctx = this._context;
        if (!ctx || !option) return;

        const size = Math.max(1, Math.round(num(option.text_size, 18)));
        ctx.save();
        ctx.font = `${size}px allfont`;
        ctx.textBaseline = "top";
        ctx.fillStyle = this._style(option.color);
        ctx.fillText(
            option.text === undefined || option.text === null ? "" : String(option.text),
            num(option.x), num(option.y)
        );
        ctx.restore();
        this._touch();
    }

    async drawImage(option) {
        const ctx = this._context;
        if (!ctx || !option || !option.image || !this.runtime) return;

        try {
            const img = await this.runtime.getAssetImage(option.image);
            const w = num(option.w, img.width);
            const h = num(option.h, img.height);
            ctx.save();
            if (typeof option.alpha === "number") {
                ctx.globalAlpha = Math.max(0, Math.min(255, option.alpha)) / 255;
            }
            ctx.drawImage(img, num(option.x), num(option.y), w, h);
            ctx.restore();
            this._touch();
        } catch(e) {}
    }

    clear(option) {
        const ctx = this._context;
        if (!ctx || !this._canvas) return;

        if (!option) {
            ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        } else {
            ctx.clearRect(num(option.x), num(option.y),
                num(option.w, this._canvas.width), num(option.h, this._canvas.height));
        }
        this._touch();
    }

    setProperty(prop, val) {
        super.setProperty(prop, val);

        if ((prop === "w" || prop === "h" || prop === "more") && this._canvas) {
            const w = Math.max(1, Math.round(num(this.config.w, this._canvas.width)));
            const h = Math.max(1, Math.round(num(this.config.h, this._canvas.height)));
            if (this._canvas.width !== w || this._canvas.height !== h) {
                try {
                    this._canvas.width = w;
                    this._canvas.height = h;
                    this._context = this._canvas.getContext("2d");
                    this._proxy = null;
                } catch(e) {}
            }
        }
    }

    async render(canvas, runtime) {
        runtime = runtime || this.runtime;
        if (!runtime) return;
        if (!this._canvas) this._initCanvas(runtime);
        if (!this._canvas) return;

        const config = this.config;
        const x = num(config.x), y = num(config.y);
        canvas.getContext("2d").drawImage(this._canvas, x, y);

        this.dropEvents(runtime, [x, y, x + num(config.w), y + num(config.h)]);
    }
}

/**
 * hmUI.widget.GRADIENT_POLYLINE / GRADKIENT_POLYLINE
 *
 * polyline.clear(), polyline.addLine({data, count, color_from, color_to,
 * curve_style}). Point y is measured from the bottom of the widget, as stated
 * in the official documentation.
 */
export class GradientPolylineWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this._lines = [];
        this._canvas = null;
        this._context = null;
    }

    _buildCanvas() {
        const runtime = this.runtime;
        if (!runtime || typeof runtime.newCanvas !== "function") return;

        const w = Math.max(1, Math.round(num(this.config.w, 1)));
        const h = Math.max(1, Math.round(num(this.config.h, 1)));

        try {
            const canvas = runtime.newCanvas();
            canvas.width = w;
            canvas.height = h;
            this._canvas = canvas;
            this._context = canvas.getContext("2d");
        } catch(e) {
            console.warn("GRADIENT_POLYLINE init failed", e);
        }
    }

    clear() {
        this._lines = [];
        if (this._context && this._canvas) {
            this._context.clearRect(0, 0, this._canvas.width, this._canvas.height);
        }
        if (this.runtime) this.runtime.refresh_required = "polyline_canvas";
    }

    addLine(option) {
        if (!option || !Array.isArray(option.data) || option.data.length < 2) return;
        if (!this._context || !this._canvas) this._buildCanvas();
        if (!this._context || !this._canvas) return;

        const count = Math.max(2, Math.min(
            Math.round(num(option.count, option.data.length)),
            option.data.length
        ));

        const points = [];
        for(let i = 0; i < count; i++) {
            const point = option.data[i];
            if (!point || typeof point !== "object") continue;
            /* Keep raw values: the canvas can be resized later, so scaling is
             * done in _redraw against the current size. */
            points.push({
                x: num(point.x),
                y: num(point.y)
            });
        }

        if (points.length < 2) return;

        this._lines.push({
            points,
            color_from: option.color_from,
            color_to: option.color_to,
            curve_style: !!option.curve_style
        });

        this._redraw();
        if (this.runtime) this.runtime.refresh_required = "polyline_canvas";
    }

    _trace(ctx, points, curve) {
        ctx.moveTo(points[0].x, points[0].y);

        if (!curve || points.length < 3) {
            for(let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
            return;
        }

        for(let i = 1; i < points.length - 1; i++) {
            const next = points[i + 1];
            ctx.quadraticCurveTo(points[i].x, points[i].y,
                (points[i].x + next.x) / 2, (points[i].y + next.y) / 2);
        }

        const last = points[points.length - 1];
        ctx.quadraticCurveTo(last.x, last.y, last.x, last.y);
    }

    _redraw() {
        const ctx = this._context;
        const canvas = this._canvas;
        if (!ctx || !canvas) return;

        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);

        const lineColor = colorAt(this.config.line_color, 0xe60039);
        const lineWidth = Math.max(1, num(this.config.line_width, 2));

        for(const line of this._lines) {
            /* y is measured from the bottom of the widget. */
            const points = line.points.map(point => ({
                x: Math.max(0, Math.min(width, point.x)),
                y: Math.max(0, Math.min(height, height - point.y))
            }));
            if (points.length < 2) continue;

            if (line.color_from !== undefined) {
                let top = height;
                for(const point of points) top = Math.min(top, point.y);

                let fill = zeppColorToHex(line.color_from);
                try {
                    const gradient = ctx.createLinearGradient(0, top, 0, height);
                    gradient.addColorStop(0, colorWithAlpha(line.color_from, 0.6));
                    gradient.addColorStop(1, line.color_to !== undefined
                        ? colorWithAlpha(line.color_to, 0.02)
                        : colorWithAlpha(line.color_from, 0));
                    fill = gradient;
                } catch(e) {}

                ctx.beginPath();
                this._trace(ctx, points, line.curve_style);
                ctx.lineTo(points[points.length - 1].x, height);
                ctx.lineTo(points[0].x, height);
                ctx.closePath();
                ctx.fillStyle = fill;
                ctx.fill();
            }

            ctx.beginPath();
            this._trace(ctx, points, line.curve_style);
            ctx.strokeStyle = zeppColorToHex(lineColor);
            ctx.lineWidth = lineWidth;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.stroke();
        }
    }

    setProperty(prop, val) {
        super.setProperty(prop, val);

        if (prop === "more" && this._canvas) {
            const w = Math.max(1, Math.round(num(this.config.w, this._canvas.width)));
            const h = Math.max(1, Math.round(num(this.config.h, this._canvas.height)));
            if (this._canvas.width !== w || this._canvas.height !== h) {
                this._buildCanvas();
                this._redraw();
            }
        }
    }

    async render(canvas, runtime) {
        runtime = runtime || this.runtime;
        if (!runtime) return;

        const config = this.config;
        if (!this._canvas) this._buildCanvas();
        if (!this._canvas) return;

        const w = Math.max(1, Math.round(num(config.w, this._canvas.width)));
        const h = Math.max(1, Math.round(num(config.h, this._canvas.height)));
        if (this._canvas.width !== w || this._canvas.height !== h) {
            this._buildCanvas();
            this._redraw();
        }

        const x = num(config.x), y = num(config.y);
        canvas.getContext("2d").drawImage(this._canvas, x, y);

        this.dropEvents(runtime, [x, y, x + w, y + h]);
    }
}
