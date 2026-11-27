/*
    Minimal `sharp` compatibility layer for the Android build of the Zeus CLI.

    Upstream sharp ships prebuilt native binaries for desktop platforms only
    (glibc/musl), so it cannot load on Android's Bionic libc. The Zeus build
    pipeline only uses a small, well defined subset of the API to resize app
    icons and preview images; this module implements exactly that subset in
    pure JavaScript on top of pngjs.

    Supported: metadata(), resize(), extend(), trim() (bounding box), toBuffer(),
    toFile(), png()/jpeg()/webp() as format selectors (always writes PNG),
    clone(), and the no-op static helpers (cache/concurrency/simd/format).

    Anything outside that subset throws instead of silently producing wrong
    output, so a future Zeus version that starts using more of sharp is easy to
    spot.
*/
"use strict";

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

function isPng(buffer) {
    return buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50;
}

function readImage(input) {
    if (Buffer.isBuffer(input)) {
        if (!isPng(input)) throw new Error("sharp shim: only PNG input is supported");
        return PNG.sync.read(input);
    }
    if (typeof input === "string") return readImage(fs.readFileSync(input));
    if (input && input.data) return readImage(Buffer.from(input.data));
    throw new Error("sharp shim: unsupported input");
}

function resizeBilinear(img, targetWidth, targetHeight) {
    const out = new PNG({ width: targetWidth, height: targetHeight });
    const xRatio = img.width / targetWidth;
    const yRatio = img.height / targetHeight;

    for (let y = 0; y < targetHeight; y++) {
        for (let x = 0; x < targetWidth; x++) {
            const srcX = Math.min(img.width - 1, x * xRatio);
            const srcY = Math.min(img.height - 1, y * yRatio);
            const x0 = Math.floor(srcX);
            const y0 = Math.floor(srcY);
            const x1 = Math.min(img.width - 1, x0 + 1);
            const y1 = Math.min(img.height - 1, y0 + 1);
            const fx = srcX - x0;
            const fy = srcY - y0;

            for (let c = 0; c < 4; c++) {
                const p00 = img.data[(y0 * img.width + x0) * 4 + c];
                const p10 = img.data[(y0 * img.width + x1) * 4 + c];
                const p01 = img.data[(y1 * img.width + x0) * 4 + c];
                const p11 = img.data[(y1 * img.width + x1) * 4 + c];
                const top = p00 + (p10 - p00) * fx;
                const bottom = p01 + (p11 - p01) * fx;
                out.data[(y * targetWidth + x) * 4 + c] = Math.round(top + (bottom - top) * fy);
            }
        }
    }
    return out;
}

class SharpImage {
    constructor(input) {
        this.image = readImage(input);
        this._metadata = {
            format: "png",
            width: this.image.width,
            height: this.image.height,
            channels: 4,
            hasAlpha: true,
        };
    }

    metadata() {
        return Promise.resolve(Object.assign({}, this._metadata));
    }

    clone() {
        const copy = Object.create(SharpImage.prototype);
        const img = new PNG({ width: this.image.width, height: this.image.height });
        this.image.data.copy ? this.image.data.copy(img.data) : img.data.set(this.image.data);
        copy.image = img;
        copy._metadata = Object.assign({}, this._metadata);
        return copy;
    }

    resize(options) {
        const opts = options || {};
        const width = opts.width || this.image.width;
        const height = opts.height || Math.round((width / this.image.width) * this.image.height);
        this.image = resizeBilinear(this.image, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
        this._metadata.width = this.image.width;
        this._metadata.height = this.image.height;
        return this;
    }

    extend(options) {
        const opts = options || {};
        const top = opts.top || 0;
        const bottom = opts.bottom || 0;
        const left = opts.left || 0;
        const right = opts.right || 0;
        const bg = opts.background || { r: 0, g: 0, b: 0, alpha: 0 };

        const width = this.image.width + left + right;
        const height = this.image.height + top + bottom;
        const out = new PNG({ width, height });

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const at = (y * width + x) * 4;
                const inside = x >= left && x < left + this.image.width
                    && y >= top && y < top + this.image.height;
                if (inside) {
                    const src = ((y - top) * this.image.width + (x - left)) * 4;
                    out.data[at] = this.image.data[src];
                    out.data[at + 1] = this.image.data[src + 1];
                    out.data[at + 2] = this.image.data[src + 2];
                    out.data[at + 3] = this.image.data[src + 3];
                } else {
                    out.data[at] = bg.r || 0;
                    out.data[at + 1] = bg.g || 0;
                    out.data[at + 2] = bg.b || 0;
                    out.data[at + 3] = bg.alpha === undefined ? 255 : bg.alpha;
                }
            }
        }

        this.image = out;
        this._metadata.width = width;
        this._metadata.height = height;
        return this;
    }

    trim() {
        const img = this.image;
        let minX = img.width;
        let minY = img.height;
        let maxX = -1;
        let maxY = -1;

        for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
                if (img.data[(y * img.width + x) * 4 + 3] > 0) {
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
        }

        if (maxX < 0) return this;

        const width = maxX - minX + 1;
        const height = maxY - minY + 1;
        const out = new PNG({ width, height });
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const src = ((y + minY) * img.width + (x + minX)) * 4;
                const dst = (y * width + x) * 4;
                out.data[dst] = img.data[src];
                out.data[dst + 1] = img.data[src + 1];
                out.data[dst + 2] = img.data[src + 2];
                out.data[dst + 3] = img.data[src + 3];
            }
        }
        this.image = out;
        this._metadata.width = width;
        this._metadata.height = height;
        return this;
    }

    png() { return this; }
    jpeg() { return this; }
    webp() { return this; }
    toFormat() { return this; }

    toBuffer() {
        return Promise.resolve(PNG.sync.write(this.image));
    }

    toFile(destination) {
        return this.toBuffer().then((buffer) => {
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, buffer);
            return { width: this.image.width, height: this.image.height };
        });
    }
}

function sharp(input) {
    return new SharpImage(input);
}

/* Statics the CLI touches during startup. */
sharp.cache = () => {};
sharp.concurrency = () => {};
sharp.simd = () => {};
sharp.format = { png: { output: { file: true, buffer: true } } };
sharp.versions = { sharp: "zeppplayer-shim" };

module.exports = sharp;
