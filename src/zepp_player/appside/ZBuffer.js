/*
    A small Buffer-compatible helper for the app-side sandbox.
    Covers the commonly-used methods of Node Buffer in companion scripts.
*/

const HEX = "0123456789abcdef";

export class ZBuffer extends Uint8Array {
    static from(value, encoding) {
        if (value instanceof Uint8Array) return new ZBuffer(value);
        if (Array.isArray(value)) return new ZBuffer(value);
        if (typeof value === "string") {
            if (encoding === "hex") return ZBuffer.fromHex(value);
            if (encoding === "base64") return ZBuffer.fromBase64(value);
            return ZBuffer.fromUtf8(value);
        }
        if (value instanceof ArrayBuffer) return new ZBuffer(value);
        throw new Error("ZBuffer.from: unsupported value");
    }

    static fromUtf8(str) {
        const bytes = new TextEncoder().encode(str);
        return new ZBuffer(bytes);
    }

    static fromHex(hex) {
        const clean = hex.replace(/\s+/g, "");
        const len = clean.length >> 1;
        const out = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            out[i] = parseInt(clean.substr(i * 2, 2), 16);
        }
        return new ZBuffer(out);
    }

    static fromBase64(b64) {
        if (typeof atob === "function") {
            const bin = atob(b64);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return new ZBuffer(out);
        }
        throw new Error("ZBuffer.fromBase64: atob unavailable");
    }

    static alloc(size) {
        return new ZBuffer(new Uint8Array(size));
    }

    static allocUnsafe(size) {
        return new ZBuffer(new Uint8Array(size));
    }

    static concat(list, totalLength) {
        const total = totalLength || list.reduce((s, b) => s + b.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const b of list) { out.set(b, off); off += b.length; }
        return new ZBuffer(out);
    }

    static isBuffer(v) {
        return v instanceof ZBuffer;
    }

    get length() {
        return this.byteLength;
    }

    toString(encoding, start, end) {
        const slice = new Uint8Array(
            this.buffer, this.byteOffset + (start || 0),
            (end === undefined ? this.byteLength : end) - (start || 0)
        );
        if (encoding === "hex" || encoding === "hexl") {
            let out = "";
            for (let i = 0; i < slice.length; i++) {
                out += HEX[slice[i] >> 4] + HEX[slice[i] & 15];
            }
            return out;
        }
        if (encoding === "base64") {
            if (typeof btoa === "function") {
                let bin = "";
                for (let i = 0; i < slice.length; i++) bin += String.fromCharCode(slice[i]);
                return btoa(bin);
            }
            return "";
        }
        return new TextDecoder().decode(slice);
    }

    toJSON() {
        return Array.from(this);
    }

    indexOf(value, fromIndex) {
        const needle = Uint8Array.isArray && Array.isArray(value) ? value : [value];
        for (let i = (fromIndex || 0); i + needle.length - 1 < this.length; i++) {
            let match = true;
            for (let j = 0; j < needle.length; j++) {
                if (this[i + j] !== needle[j]) { match = false; break; }
            }
            if (match) return i;
        }
        return -1;
    }

    slice(start, end) {
        return new ZBuffer(super.slice(start, end));
    }

    write(str, offset, _len, encoding) {
        const bytes = encoding === "hex"
            ? ZBuffer.fromHex(str)
            : ZBuffer.fromUtf8(str);
        this.set(bytes, offset || 0);
        return bytes.length;
    }
}