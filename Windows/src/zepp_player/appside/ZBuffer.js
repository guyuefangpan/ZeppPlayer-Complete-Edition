/*
    A small Buffer-compatible helper for the app-side sandbox.
    Mirrors the subset of Node's Buffer that companion scripts use, matching
    the implementation OronBox ships for its app-side host.
*/

const HEX = "0123456789abcdef";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function utf8Encode(str) {
    return new TextEncoder().encode(str);
}

function utf8Decode(bytes) {
    return new TextDecoder().decode(bytes);
}

export class ZBuffer extends Uint8Array {
    // ------------------------------------------------------------ factories
    static from(value, encoding, length) {
        if (value instanceof ZBuffer) return value;
        if (value instanceof Uint8Array) return new ZBuffer(value.buffer, value.byteOffset, value.byteLength);
        if (value instanceof ArrayBuffer) {
            return new ZBuffer(value, 0, length === undefined ? value.byteLength : length);
        }
        if (Array.isArray(value)) return new ZBuffer(Uint8Array.from(value));
        if (typeof value === "string") {
            if (encoding === "hex") return ZBuffer.fromHex(value);
            if (encoding === "base64") return ZBuffer.fromBase64(value);
            if (encoding === "latin1" || encoding === "binary") {
                const out = new Uint8Array(value.length);
                for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
                return new ZBuffer(out);
            }
            return ZBuffer.fromUtf8(value);
        }
        if (value && typeof value === "object" && typeof value.length === "number") {
            return new ZBuffer(Uint8Array.from(value));
        }
        throw new TypeError("ZBuffer.from: unsupported value");
    }

    static fromUtf8(str) {
        return new ZBuffer(utf8Encode(String(str)));
    }

    static fromHex(hex) {
        const clean = String(hex).replace(/[^0-9a-fA-F]/g, "");
        const len = clean.length >> 1;
        const out = new Uint8Array(len);
        for (let i = 0; i < len; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
        return new ZBuffer(out);
    }

    static fromBase64(b64) {
        const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, "");
        const out = [];
        let bits = 0;
        let bitCount = 0;
        for (const char of clean) {
            const index = B64.indexOf(char);
            if (index < 0) continue;
            bits = (bits << 6) | index;
            bitCount += 6;
            if (bitCount >= 8) {
                bitCount -= 8;
                out.push((bits >> bitCount) & 0xff);
            }
        }
        return new ZBuffer(out);
    }

    static alloc(size) {
        return new ZBuffer(new Uint8Array(size));
    }

    static allocUnsafe(size) {
        return new ZBuffer(new Uint8Array(size));
    }

    static concat(list, totalLength) {
        const arrays = (list || []).map((b) => ZBuffer.from(b));
        const total = totalLength === undefined
            ? arrays.reduce((s, b) => s + b.length, 0)
            : totalLength;
        const out = new Uint8Array(total);
        let off = 0;
        for (const b of arrays) {
            if (off >= total) break;
            const take = Math.min(b.length, total - off);
            out.set(take === b.length ? b : b.subarray(0, take), off);
            off += take;
        }
        return new ZBuffer(out);
    }

    static byteLength(value, encoding) {
        if (typeof value === "string") {
            if (encoding === "hex") return Math.floor(value.replace(/\s+/g, "").length / 2);
            if (encoding === "base64") return ZBuffer.fromBase64(value).length;
            return utf8Encode(value).length;
        }
        if (value instanceof ArrayBuffer) return value.byteLength;
        if (value && typeof value.byteLength === "number") return value.byteLength;
        return 0;
    }

    static isBuffer(v) {
        return v instanceof ZBuffer;
    }

    // ------------------------------------------------------------ accessors
    get length() {
        return this.byteLength;
    }

    get parent() {
        return this.buffer;
    }

    get offset() {
        return this.byteOffset;
    }

    toString(encoding, start, end) {
        const from = start === undefined ? 0 : Math.max(0, start);
        const to = end === undefined ? this.byteLength : Math.min(this.byteLength, end);
        const slice = this.subarray(from, to);

        if (encoding === "hex" || encoding === "hexl") {
            let out = "";
            for (let i = 0; i < slice.length; i++) out += HEX[slice[i] >> 4] + HEX[slice[i] & 15];
            return out;
        }
        if (encoding === "base64") {
            let bin = "";
            for (let i = 0; i < slice.length; i++) bin += String.fromCharCode(slice[i]);
            if (typeof btoa === "function") return btoa(bin);
            return ZBuffer.toBase64(slice);
        }
        if (encoding === "latin1" || encoding === "binary") {
            let out = "";
            for (let i = 0; i < slice.length; i++) out += String.fromCharCode(slice[i]);
            return out;
        }
        return utf8Decode(slice);
    }

    toJSON() {
        return Array.from(this);
    }

    slice(start, end) {
        return new ZBuffer(super.slice(start, end));
    }

    subarray(start, end) {
        const view = super.subarray(start, end);
        return new ZBuffer(view.buffer, view.byteOffset, view.byteLength);
    }

    // ------------------------------------------------------------ mutation
    write(str, offset, length, encoding) {
        const bytes = encoding === "hex" ? ZBuffer.fromHex(str) : ZBuffer.fromUtf8(str);
        const count = length === undefined ? bytes.length : Math.min(bytes.length, length);
        this.set(count === bytes.length ? bytes : bytes.subarray(0, count), offset || 0);
        return count;
    }

    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
        if (!ArrayBuffer.isView(target)) throw new TypeError("target must be a Buffer or Uint8Array");
        targetStart = Math.max(0, Number(targetStart) || 0);
        sourceStart = Math.max(0, Number(sourceStart) || 0);
        sourceEnd = Math.min(this.length, Math.max(0, Number(sourceEnd)));
        const count = Math.max(0, Math.min(sourceEnd - sourceStart, target.length - targetStart));
        if (!count) return 0;
        target.set(Uint8Array.prototype.slice.call(this, sourceStart, sourceStart + count), targetStart);
        return count;
    }

    fill(value, start = 0, end = this.length, encoding) {
        start = Math.max(0, Number(start) || 0);
        end = Math.min(this.length, Math.max(start, Number(end)));
        if (typeof value === "number") {
            Uint8Array.prototype.fill.call(this, value & 0xff, start, end);
            return this;
        }
        const pattern = typeof value === "string" ? ZBuffer.from(value, encoding) : ZBuffer.from(value);
        if (!pattern.length) throw new TypeError("fill value must not be empty");
        for (let i = start; i < end; i++) this[i] = pattern[(i - start) % pattern.length];
        return this;
    }

    equals(other) {
        const value = ZBuffer.from(other);
        return this.length === value.length && this.every((byte, index) => byte === value[index]);
    }

    indexOf(value, fromIndex) {
        const needle = Array.isArray(value) || value instanceof Uint8Array
            ? ZBuffer.from(value)
            : [value];
        for (let i = (fromIndex || 0); i + needle.length - 1 < this.length; i++) {
            let match = true;
            for (let j = 0; j < needle.length; j++) {
                if (this[i + j] !== needle[j]) { match = false; break; }
            }
            if (match) return i;
        }
        return -1;
    }

    // ------------------------------------------------------------ integers
    readUInt8(offset = 0) { return this[offset]; }
    readUIntLE(offset, byteLength) { let value = 0; for (let i = byteLength - 1; i >= 0; i--) value = value * 256 + this[offset + i]; return value; }
    readUIntBE(offset, byteLength) { let value = 0; for (let i = 0; i < byteLength; i++) value = value * 256 + this[offset + i]; return value; }
    readUInt16LE(offset = 0) { return this.readUIntLE(offset, 2); }
    readUInt16BE(offset = 0) { return this.readUIntBE(offset, 2); }
    readUInt32LE(offset = 0) { return this.readUIntLE(offset, 4) >>> 0; }
    readUInt32BE(offset = 0) { return this.readUIntBE(offset, 4) >>> 0; }
    readIntLE(offset, byteLength) {
        const value = this.readUIntLE(offset, byteLength);
        const limit = Math.pow(2, byteLength * 8 - 1);
        return value >= limit ? value - limit * 2 : value;
    }
    readIntBE(offset, byteLength) {
        const value = this.readUIntBE(offset, byteLength);
        const limit = Math.pow(2, byteLength * 8 - 1);
        return value >= limit ? value - limit * 2 : value;
    }
    readInt8(offset = 0) { return this.readIntLE(offset, 1); }
    readInt16LE(offset = 0) { return this.readIntLE(offset, 2); }
    readInt16BE(offset = 0) { return this.readIntBE(offset, 2); }
    readInt32LE(offset = 0) { return this.readIntLE(offset, 4); }
    readInt32BE(offset = 0) { return this.readIntBE(offset, 4); }

    writeUInt8(value, offset = 0) { this[offset] = value & 0xff; return offset + 1; }
    writeUIntLE(value, offset, byteLength) { for (let i = 0; i < byteLength; i++) { this[offset + i] = value & 0xff; value = Math.floor(value / 256); } return offset + byteLength; }
    writeUIntBE(value, offset, byteLength) { for (let i = byteLength - 1; i >= 0; i--) { this[offset + i] = value & 0xff; value = Math.floor(value / 256); } return offset + byteLength; }
    writeUInt16LE(value, offset = 0) { return this.writeUIntLE(value, offset, 2); }
    writeUInt16BE(value, offset = 0) { return this.writeUIntBE(value, offset, 2); }
    writeUInt32LE(value, offset = 0) { return this.writeUIntLE(value, offset, 4); }
    writeUInt32BE(value, offset = 0) { return this.writeUIntBE(value, offset, 4); }
    writeIntLE(value, offset, byteLength) { return this.writeUIntLE(value < 0 ? value + Math.pow(2, byteLength * 8) : value, offset, byteLength); }
    writeIntBE(value, offset, byteLength) { return this.writeUIntBE(value < 0 ? value + Math.pow(2, byteLength * 8) : value, offset, byteLength); }
    writeInt8(value, offset = 0) { return this.writeIntLE(value, offset, 1); }
    writeInt16LE(value, offset = 0) { return this.writeIntLE(value, offset, 2); }
    writeInt16BE(value, offset = 0) { return this.writeIntBE(value, offset, 2); }
    writeInt32LE(value, offset = 0) { return this.writeIntLE(value, offset, 4); }
    writeInt32BE(value, offset = 0) { return this.writeIntBE(value, offset, 4); }

    static toBase64(bytes) {
        let out = "";
        let i = 0;
        for (; i + 2 < bytes.length; i += 3) {
            const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
            out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
        }
        const rest = bytes.length - i;
        if (rest === 1) {
            const n = bytes[i] << 16;
            out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
        } else if (rest === 2) {
            const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
            out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
        }
        return out;
    }
}
