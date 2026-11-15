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
import {MissingWidget} from "../ImagingWidgets.js";

const DRAG_START = 6;

/**
 * hmUI.widget.VIEW_CONTAINER
 *
 * Clipped box which renders child widgets created through
 * `container.createWidget(type, config)`. Child coordinates are relative to
 * the container, exactly like on a real device. With `scroll_enable` the
 * content can be dragged vertically; `bounce` is accepted but the scroll
 * position is clamped so content never leaves its bounds.
 */
export class ViewContainerWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this.widgets = [];
        config.__content = this.widgets;

        this.scrollY = 0;
        this.innerHeight = 0;
        this.isMouseDown = false;
        this.isDragging = false;
        this.mouseStartEv = null;
        this.lastScrollY = 0;
        this._childCounter = 0;

        this.addEventListener("onmousedown", (e) => this.eventDown(e));
        this.addEventListener("onmousemove", (e) => this.eventMove(e));
        this.addEventListener("onmouseup", (e) => this.eventUp(e));
    }

    createWidget(type, config) {
        let Widget = new HuamiUIMock()._widget[type];
        if (!Widget) Widget = MissingWidget;

        if (typeof config !== "object" || config === null) config = {};

        config.__widget = type;
        config.__id = ((this.config.__id + 1) << 10) + this._childCounter;
        config.__runtime = this.runtime;

        const i = new Widget(config);
        this._childCounter++;
        this.widgets.push(i);
        this.runtime.refresh_required = "add_widget_container";

        return i;
    }

    _contentHeight() {
        let height = 0;
        for (const widget of this.widgets) {
            const config = widget.config;
            if (!config || config.visible === false) continue;
            const bottom = (config.y ? config.y : 0) + (config.h ? config.h : 0);
            if (bottom > height) height = bottom;
        }
        return height;
    }

    _clampScroll() {
        const maxScroll = Math.max(0, this.innerHeight - this.config.h);
        if (-this.scrollY > maxScroll) this.scrollY = -maxScroll;
        if (this.scrollY > 0) this.scrollY = 0;
    }

    async render(canvas, runtime) {
        const config = this.config;
        const view = runtime.newCanvas();
        view.width = config.w;
        view.height = config.h;

        this.innerHeight = this._contentHeight();
        this._clampScroll();

        const ctx = view.getContext("2d");
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, config.w, config.h);
        ctx.clip();
        ctx.translate(0, this.scrollY);

        /* Children may be much taller than the container. Their event zones
         * must not extend beyond it: `dropEvents` also grows the page-level
         * contentHeight, which would otherwise make the whole page scroll
         * together with the container content. */
        const eventStart = runtime.events.length;
        const pageHeight = runtime.contentHeight;

        for (const widget of this.widgets) {
            widget.config.__eventOffsetX = config.x;
            widget.config.__eventOffsetY = config.y + this.scrollY;
            await runtime.renderWidget(widget, view);
        }

        for (let i = eventStart; i < runtime.events.length; i++) {
            const zone = runtime.events[i];
            zone.x1 = Math.max(zone.x1, config.x);
            zone.y1 = Math.max(zone.y1, config.y);
            zone.x2 = Math.min(zone.x2, config.x + config.w);
            zone.y2 = Math.min(zone.y2, config.y + config.h);
        }
        runtime.contentHeight = pageHeight;

        ctx.restore();
        canvas.getContext("2d").drawImage(view, config.x, config.y);

        this.dropEvents(runtime, [
            config.x,
            config.y,
            config.x + config.w,
            config.y + config.h
        ]);
    }

    /* The container is checked before its children (its event zone is
     * registered last), so clicks have to be forwarded manually when the
     * gesture did not turn into a scroll. */
    _findChildZone(runtime, x, y) {
        const events = runtime.events;
        for (let i = events.length - 1; i >= 0; i--) {
            const zone = events[i];
            if (!zone || zone.events === this.events) continue;
            if (zone.x1 < x && x < zone.x2 && zone.y1 < y && y < zone.y2) return zone;
        }
        return null;
    }

    eventDown(e) {
        this.mouseStartEv = e;
        this.lastScrollY = this.scrollY;
        this.isMouseDown = true;
        this.isDragging = false;
    }

    eventMove(e) {
        if (!this.isMouseDown) return;
        if (!this.config.scroll_enable) return;

        const dy = e.y - this.mouseStartEv.y;
        if (!this.isDragging) {
            if (Math.abs(dy) < DRAG_START) return;
            this.isDragging = true;
        }

        this.scrollY = this.lastScrollY + dy;
        this.runtime.refresh_required = "scroll";
    }

    eventUp(e) {
        if (!this.isMouseDown) return;
        this.isMouseDown = false;

        const wasDragging = this.isDragging;
        this.isDragging = false;
        this._clampScroll();

        if (!wasDragging) {
            const y = e.y + this.runtime.player.config.renderScroll;
            const zone = this._findChildZone(this.runtime, e.x, y);
            if (zone && zone.events && zone.events.onmouseup) {
                zone.events.onmouseup(e);
            }
        }

        this.runtime.refresh_required = "scroll";
    }
}
