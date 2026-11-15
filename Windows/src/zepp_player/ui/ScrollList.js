// noinspection JSUnresolvedVariable

import {BaseWidget} from "./widget/BaseWidget.ts";
import {FillRectWidget} from "./DrawingWidgets.js";
import {ImageWidget} from "./ImagingWidgets.js";
import {TextWidget} from "./widget/TextWidget.ts";

const DRAG_START = 5;

/**
 * hmUI.widget.SCROLL_LIST
 *
 * Implements the ZeppOS 2.x/3.x configuration style:
 *
 *   item_config: [{ type_id, item_height, item_bg_color, item_bg_radius,
 *                   text_view: [{x, y, w, h, key, action, ...}],
 *                   image_view: [{x, y, w, h, key, action}] }]
 *   item_config_count, data_array, data_count,
 *   item_click_func(list, index, data_key),
 *   item_enable_horizon_drag, item_drag_max_distance
 *
 * `data_key` is the `key` of the text/image view that was tapped, which is how
 * apps distinguish (for example) an item body from its swipe-to-delete button.
 */
export class ScrollList extends BaseWidget {
    constructor(conf) {
        super(conf);
        this.scrollY = 0;
        this.innerHeight = 0;
        this.isMouseDown = false;
        this.lastScrollY = 0;
        this.mouseStartEv = {x: 0, y: 0};
        this.axis = null;
        this.moved = false;
        this.itemOffsets = Object.create(null);
        this.dragIndex = -1;
        this.dragStartOffset = 0;

        this.addEventListener("onmouseup", (e) => this.eventUp(e));
        this.addEventListener("onmousedown", (e) => this.eventDown(e));
        this.addEventListener("onmousemove", (e) => this.eventMove(e));
    }

    _data() {
        return Array.isArray(this.config.data_array) ? this.config.data_array : [];
    }

    _itemConfigFor(item) {
        const list = this.config.item_config;
        if (!Array.isArray(list) || list.length === 0) return null;

        if (item && item.type_id !== undefined) {
            for (const ic of list) {
                if (ic && ic.type_id === item.type_id) return ic;
            }
        }
        return list[0];
    }

    _layout() {
        const data = this._data();
        const space = this.config.item_space ? this.config.item_space : 0;
        const rows = [];
        let y = 0;

        for (let i = 0; i < data.length; i++) {
            const ic = this._itemConfigFor(data[i]);
            if (!ic) break;
            const height = ic.item_height ? ic.item_height : 0;
            rows.push({index: i, y: y, ic: ic, item: data[i]});
            y += height + space;
        }

        return rows;
    }

    async render(canvas, player) {
        const config = this.config;
        const view = player.newCanvas();
        view.width = config.w;
        view.height = config.h;

        const rows = this._layout();

        let innerHeight = 0;
        for (const row of rows) {
            const height = row.ic.item_height ? row.ic.item_height : 0;
            if (row.y + height > innerHeight) innerHeight = row.y + height;
        }
        this.innerHeight = innerHeight;

        const maxScroll = Math.max(0, innerHeight - config.h);
        if (-this.scrollY > maxScroll) this.scrollY = -maxScroll;
        if (this.scrollY > 0) this.scrollY = 0;

        const ctx = view.getContext("2d");
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, config.w, config.h);
        ctx.clip();

        for (const row of rows) {
            const posY = row.y + this.scrollY;
            const height = row.ic.item_height ? row.ic.item_height : 0;
            if (posY + height < 0) continue;
            if (posY > config.h) break;
            await this._drawRow(ctx, row, posY, view, player);
        }

        ctx.restore();
        canvas.getContext("2d").drawImage(view, config.x, config.y);

        this.dropEvents(player, [
            config.x,
            config.y,
            config.x + config.w,
            config.y + config.h
        ]);
    }

    async _drawRow(ctx, row, posY, view, player) {
        const ic = row.ic;
        const item = row.item;
        const offsetX = this.itemOffsets[row.index] || 0;
        const width = this.config.w;

        FillRectWidget.draw(view, {
            x: offsetX,
            y: posY,
            w: width,
            h: ic.item_height,
            color: ic.item_bg_color === undefined ? 0x303030 : ic.item_bg_color,
            radius: ic.item_bg_radius ? ic.item_bg_radius : 0
        }, "fill", player);

        const textViews = ic.text_view || [];
        const textCount = typeof ic.text_view_count === "number" ? ic.text_view_count : textViews.length;
        for (let i = 0; i < textCount; i++) {
            const tv = textViews[i];
            if (!tv) continue;

            const text = item[tv.key];
            if (text === undefined || text === null || text === "") continue;

            const layer = TextWidget.drawText({
                ...tv,
                x: 0,
                y: 0,
                text: String(text),
                color: tv.color === undefined ? 0xffffff : tv.color,
                align_h: tv.align_h ? tv.align_h : "left",
                align_v: tv.align_v ? tv.align_v : "top"
            }, player);

            ctx.drawImage(layer, offsetX + (tv.x ? tv.x : 0), posY + (tv.y ? tv.y : 0));
        }

        const imageViews = ic.image_view || [];
        const imageCount = typeof ic.image_view_count === "number" ? ic.image_view_count : imageViews.length;
        for (let i = 0; i < imageCount; i++) {
            const iv = imageViews[i];
            if (!iv) continue;

            try {
                const img = await player.getAssetImage(item[iv.key]);
                ImageWidget.draw(img, view, player, {
                    x: offsetX + (iv.x ? iv.x : 0),
                    y: posY + (iv.y ? iv.y : 0),
                    w: iv.w,
                    h: iv.h,
                    auto_scale: true
                });
            } catch (e) {}
        }
    }

    _rowAt(localY) {
        for (const row of this._layout()) {
            const top = row.y + this.scrollY;
            const height = row.ic.item_height ? row.ic.item_height : 0;
            if (localY >= top && localY < top + height) return row;
        }
        return null;
    }

    _hitView(list, count, x, y) {
        if (!Array.isArray(list)) return null;

        const total = typeof count === "number" ? count : list.length;
        for (let i = 0; i < total; i++) {
            const view = list[i];
            if (!view || !view.action) continue;

            const w = view.w ? view.w : 0;
            const h = view.h ? view.h : 0;
            if (x >= view.x && x <= view.x + w && y >= view.y && y <= view.y + h) {
                return view;
            }
        }
        return null;
    }

    eventDown(e) {
        this.mouseStartEv = e;
        this.lastScrollY = this.scrollY;
        this.isMouseDown = true;
        this.axis = null;
        this.moved = false;

        const row = this._rowAt(e.y - this.config.y);
        this.dragIndex = row ? row.index : -1;
        this.dragStartOffset = row ? (this.itemOffsets[row.index] || 0) : 0;
    }

    eventMove(e) {
        if (!this.isMouseDown) return;

        const dx = e.x - this.mouseStartEv.x;
        const dy = e.y - this.mouseStartEv.y;

        if (!this.axis) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_START) return;

            const canDrag = this.config.item_enable_horizon_drag && this.dragIndex >= 0;
            this.axis = (canDrag && Math.abs(dx) > Math.abs(dy)) ? "h" : "v";
            this.moved = true;
        }

        if (this.axis === "h") {
            const maxDrag = typeof this.config.item_drag_max_distance === "number"
                ? this.config.item_drag_max_distance
                : 0;
            if (!maxDrag) return;

            let offset = this.dragStartOffset + dx;
            if (offset > 0) offset = 0;
            if (offset < maxDrag) offset = maxDrag;
            this.itemOffsets[this.dragIndex] = offset;
        } else {
            this.scrollY = this.lastScrollY + dy;
        }

        this.runtime.refresh_required = "scroll";
    }

    eventUp(e) {
        if (!this.isMouseDown) return;
        this.isMouseDown = false;

        if (!this.moved) this.handleClick(e);

        const limit = this.innerHeight - this.config.h;
        if (this.scrollY < -limit) this.scrollY = -limit;
        if (this.scrollY > 0) this.scrollY = 0;

        this.runtime.refresh_required = "scroll";
    }

    handleClick(e) {
        const config = this.config;
        const row = this._rowAt(e.y - config.y);
        if (!row) return;

        const offsetX = this.itemOffsets[row.index] || 0;
        const localX = e.x - config.x - offsetX;
        const localY = e.y - config.y - this.scrollY - row.y;

        const textView = this._hitView(row.ic.text_view, row.ic.text_view_count, localX, localY);
        if (textView) {
            this._click(row.index, textView.key);
            return;
        }

        const imageView = this._hitView(row.ic.image_view, row.ic.image_view_count, localX, localY);
        if (imageView) {
            this._click(row.index, imageView.key);
            return;
        }

        this._click(row.index, undefined);
    }

    _click(index, key) {
        if (typeof this.config.item_click_func !== "function") return;
        this.config.item_click_func(this._data(), index, key);
    }

    setProperty(prop, val) {
        const config = this.config;

        if (prop === "delete_item") {
            const index = val && typeof val.index === "number" ? val.index : -1;
            if (index >= 0) {
                const next = Object.create(null);
                for (const key in this.itemOffsets) {
                    const i = Number(key);
                    if (i === index) continue;
                    next[i > index ? i - 1 : i] = this.itemOffsets[key];
                }
                this.itemOffsets = next;
            }
            this.runtime.refresh_required = "del_widget";
            return;
        }

        if (prop === "scroll_to") {
            const y = val && typeof val.y === "number" ? val.y : 0;
            this.scrollY = -y;
            this.runtime.refresh_required = "scroll";
            return;
        }

        if (prop === "more" && val && typeof val === "object") {
            let reset = false;
            for (const key in val) {
                config[key] = val[key];
                if (key === "data_array" || key === "data_count") reset = true;
            }
            if (reset) {
                this.scrollY = 0;
                this.itemOffsets = Object.create(null);
            }
            this.runtime.refresh_required = "set_prop";
            return;
        }

        super.setProperty(prop, val);
    }
}
