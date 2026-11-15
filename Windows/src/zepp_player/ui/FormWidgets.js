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

import { zeppColorToHex } from "../Utils.js";
import { BaseWidget } from "./widget/BaseWidget.ts";
import { FillRectWidget } from "./DrawingWidgets.js";
import { ImageWidget } from "./ImagingWidgets.js";
import {TextWidget} from "./widget/TextWidget";

/**
 * hmUI.widget.BUTTON
 */
export class ButtonWidget extends BaseWidget {
    constructor(config) {
        super(config);
        this.pressed = false;
        this._longPressTimer = null;
        this._longPressFired = false;
        config.alpha = undefined;

        const longPressDelay = typeof config.longpress_time === "number"
            ? config.longpress_time : 600;

        this.addEventListener("onmousedown", () => {
            this.pressed = true;
            this._longPressFired = false;

            // HmUI buttons emit longpress_func while the finger is held down.
            if(config.longpress_func) {
                this._longPressTimer = setTimeout(() => {
                    this._longPressTimer = null;
                    const rt = config.__runtime;
                    if(!rt || rt.widgets.indexOf(this) < 0) return;
                    this._longPressFired = true;
                    try {
                        config.longpress_func(this);
                    } catch(e) {
                        console.warn("Button longpress_func failed", e);
                    }
                }, longPressDelay);
            }

            config.__runtime.refresh_required = "button"; // we changed color/bg
        });
        this.addEventListener("onmouseup", (info) => {
            this._clearLongPress();
            this.pressed = false;
            config.__runtime.refresh_required = "button"; // we changed color/bg
            if(this._longPressFired) return;
            // Like on a real watch, releasing outside of the button cancels it.
            if(config.click_func && this._isInside(info)) config.click_func(this);
        });

        this.addEventListener = () => {}; // ignore other events
    }

    _clearLongPress() {
        if(this._longPressTimer) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
        }
    }

    _isInside(info) {
        const zone = this.positionInfo;
        if(!info || typeof info.x !== "number" || !zone) return true;
        const scroll = this.config.__runtime.player.config.renderScroll || 0;
        const y = info.y + scroll;
        return info.x >= zone[0] && info.x <= zone[2]
            && y >= zone[1] && y <= zone[3];
    }

    async render(canvas, player) {
        const config = this.config;
        const w = config.w ? config.w : 0;
        const h = config.h ? config.h : 0;

        if(config.press_src && config.normal_src) {
            // Img bg: on a real device the background picture fills the whole
            // button box, so it must be stretched to w/h as well.
            const src = this.pressed ? config.press_src : config.normal_src;
            const img = await player.getAssetImage(src);
            if(w > 0 && h > 0) {
                ImageWidget.draw(img, canvas, player, {
                    x: config.x,
                    y: config.y,
                    w: w,
                    h: h,
                    auto_scale: true
                });
            } else {
                ImageWidget.draw(img, canvas, player, {
                    x: config.x + Math.max(0, (w - img.width) / 2),
                    y: config.y + Math.max(0, (h - img.height) / 2)
                });
            }
        } else {
            const normalColor = config.normal_color ? zeppColorToHex(config.normal_color) : "#000000";
            const pressedColor = config.press_color ? zeppColorToHex(config.press_color) : "#CCCCCC";
            const color = this.pressed ? pressedColor : normalColor;

            FillRectWidget.draw(canvas, {
                ...config,
                color: color
            }, "fill", player);
        }

        if(config.text !== undefined && config.text !== "") {
            const textLayer = await TextWidget.drawText({
                ...config,
                align_h: "center_h",
                align_v: "center_v",
                color: config.color !== undefined ? config.color : 0xffffff
            }, player);
            canvas.getContext("2d").drawImage(textLayer, config.x, config.y);
        }

        this.dropEvents(player, [
            config.x,
            config.y,
            config.x + config.w,
            config.y + config.h
        ])
    }
}