// noinspection JSUnusedGlobalSymbols

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

const CONSTANT_FOLDER = 1;
const normalize = require('path-normalize')

export default class HuamiFsMock {
    O_RDONLY = 0;
    O_WRONLY = 0;
    O_RDWR = 0;
    O_APPEND = 1; // auto-seek to end
    O_CREAT = 2;
    O_EXCL = 0;
    O_TRUNC = 0;

    SEEK_SET = 0;

    constructor(runtime) {
        this.runtime = runtime;
        this.useAbsolutePathsInHuamiFS = runtime.profileData.useAbsolutePathsInHuamiFS;

        const setters = ["SysProSetBool", "SysProSetInt64", "SysProSetDouble", "SysProSetChars"];
        const getters = ["SysProGetBool", "SysProGetInt64", "SysProGetDouble", "SysProGetChars"];

        for(let a in setters) this[setters[a]] = this.SysProSetInt;
        for(let a in getters) this[getters[a]] = this.SysProGetInt;

        const id = runtime.appConfig.app.appId.toString(16).padStart(8, "0").toUpperCase();
        const type = runtime.appConfig.app.appType;

        this.appTypeDirName = `js_${type}s`;
        this.appDirName = id;
        this.vfs = runtime.vfs;
    }

    getFile(path) {
        if(!this.vfs[path]) {
            // Folder search
            for(let key in this.vfs) {
                if(key.startsWith(path + "/"))
                    return CONSTANT_FOLDER;
            }
        }
        return this.vfs[path];
    }

    getDataFilePath(path) {
        return `/storage/${this.appTypeDirName}/data/${this.appDirName}/${path}`
    }

    newFile(path) {
        const data = new ArrayBuffer(0);
        this.vfs[path] = data;

        return data;
    }

    stat(path) {
        path = `/storage/${this.appTypeDirName}/data/${this.appDirName}/${path}`;
        return this._performStat(normalize(path));
    }

    stat_asset(path) {
        path = `/storage/${this.appTypeDirName}/${this.appDirName}/assets/${path}`;
        return this._performStat(normalize(path));
    }

    _performStat(path) {
        const file = this.getFile(path);
        if(!file) return [null, -1];

        return [{
            mode: (file !== CONSTANT_FOLDER ? 32768 : 16384) + 511,
            size: file === CONSTANT_FOLDER ? 0 : file.byteLength,
            mtime: Date.now()
        }, 0];
    }

    open(path, flag) {
        path = this.getDataFilePath(path);
        return this._performOpen(normalize(path), flag);
    }

    open_asset(path, flag) {
        path = `/storage/${this.appTypeDirName}/${this.appDirName}/assets/${path}`;
        return this._performOpen(normalize(path), flag);
    }

    _performOpen(path, flag) {
        let f = this.getFile(path);
        if(!f && (flag & 2) !== 0) {
            f = this.newFile(path);
        }

        return {data: f, flag, path, position: flag === 1 ? f.length : 0, store: "appFs"};
    }

    seek(file, pos) {
        file.position = pos;
    }

    read(file, buffer, buffOffset, len) {
        const view = new Uint8Array(buffer);
        const {position} = file;
        const fileView = new Uint8Array(file.data);

        for(let i = 0; i < len; i++) {
            view[buffOffset + i] = fileView[position + i];
        }

        file.position += len;
        return 0;
    }

    close() {
        return 0;
    }

    write(file, buf, buffOffset, len) {
        const view = new Uint8Array(buf);
        const {data, position} = file;
        if(position + len > data.byteLength) {
            const newBuffer = new ArrayBuffer(position + len);
            new Uint8Array(newBuffer).set(new Uint8Array(file.data));
            file.data = newBuffer;
            this.vfs[file.path] = newBuffer;
        }

        const fileView = new Uint8Array(file.data);
        for(let i = 0; i < len; i++) {
            fileView[position + i] = view[buffOffset + i]
        }

        file.position += len;
        return 0;
    }

    remove(path) {
        if(!this.useAbsolutePathsInHuamiFS)
            path = normalize(this.getDataFilePath(path))
        delete this.vfs[path];
        return 0;
    }

    rename(path, dest) {
        if(!this.useAbsolutePathsInHuamiFS)
            path = normalize(this.getDataFilePath(path))
        const data = this.runtime.persistent.get('fs', path);
        this.runtime.persistent.set("fs", dest, data);
        this.runtime.persistent.del("fs", path);
        return 0;
    }

    mkdir() {
        // Nothing to do
        return 0;
    }

    readdir(path) {
        if(!this.useAbsolutePathsInHuamiFS)
            path = normalize(this.getDataFilePath(path))
        path = normalize(path);

        let content = [];
        if(path[path.length-1] !== "/" && path !== "") path += "/";

        for(let a in this.vfs) {
            if(a.startsWith(path)) {
                const fn = a.substring(path.length).split("/")[0];
                if(content.indexOf(fn) < 0) content.push(fn);
            }
        }

        return [content, 0];
    }

    SysProGetInt(key) {
        return this.runtime.persistent.get("SysProRegistery", key);
    }

    SysProSetInt(key, val) {
        this.runtime.persistent.set("SysProRegistery", key, val);
    }

    /* ------------------- @zos/fs 2.x (sync) compatibility -------------------
     * ZeppOS 3 exposes a synchronous, object-argument based fs API. The legacy
     * positional API above is kept as-is and reused here through a descriptor
     * table so both call styles work. */
    _fdTable = {};
    _fdCounter = 1;

    _conf(first, second) {
        if(first !== null && typeof first === "object") return first;
        return {path: first, flag: second};
    }

    _v2stat(path) {
        const result = this._performStat(normalize(path));
        const info = result[0];
        if(!info) return null;
        const out = {
            size: info.size,
            mode: info.mode,
            mtime: info.mtime,
            isFile: () => info.mode >= 32768,
            isDirectory: () => info.mode < 32768
        };
        return out;
    }

    statSync(arg) {
        const conf = this._conf(arg);
        const path = conf.path;
        if(conf.isAsset) return this._v2stat(`/storage/${this.appTypeDirName}/${this.appDirName}/assets/${path}`);
        return this._v2stat(this.getDataFilePath(path));
    }

    statAssetsSync(arg) {
        const conf = this._conf(arg);
        return this._v2stat(`/storage/${this.appTypeDirName}/${this.appDirName}/assets/${conf.path}`);
    }

    openSync(arg, flag) {
        const conf = this._conf(arg, flag);
        const file = this._performOpen(
            normalize(this.getDataFilePath(conf.path)),
            conf.flag === undefined ? this.O_RDONLY : conf.flag
        );
        if(!file || !file.data) return {fd: -1};
        const fd = this._fdCounter++;
        this._fdTable[fd] = file;
        return {fd, path: file.path};
    }

    openAssetsSync(arg, flag) {
        const conf = this._conf(arg, flag);
        const file = this._performOpen(
            normalize(`/storage/${this.appTypeDirName}/${this.appDirName}/assets/${conf.path}`),
            conf.flag === undefined ? this.O_RDONLY : conf.flag
        );
        if(!file || !file.data) return {fd: -1};
        const fd = this._fdCounter++;
        this._fdTable[fd] = file;
        return {fd, path: file.path};
    }

    closeSync(arg) {
        const conf = this._conf(arg);
        if(conf.fd !== undefined) delete this._fdTable[conf.fd];
        return 0;
    }

    readSync(arg) {
        const conf = this._conf(arg);
        const file = this._fdTable[conf.fd];
        if(!file) return {bytesRead: 0};
        const length = conf.length || (conf.buffer ? conf.buffer.byteLength - (conf.offset || 0) : 0);
        this.read(file, conf.buffer, conf.offset || 0, length);
        return {bytesRead: length};
    }

    writeSync(arg) {
        const conf = this._conf(arg);
        const file = this._fdTable[conf.fd];
        if(!file) return {bytesWritten: 0};
        const length = conf.length || conf.buffer.byteLength;
        this.write(file, conf.buffer, conf.offset || 0, length);
        return {bytesWritten: length};
    }

    readdirSync(arg) {
        const conf = this._conf(arg);
        return this.readdir(conf.path)[0] || [];
    }

    mkdirSync() {
        return 0;
    }

    rmSync(arg) {
        const conf = this._conf(arg);
        return this.remove(conf.path);
    }

    renameSync(arg) {
        const conf = this._conf(arg);
        return this.rename(conf.path, conf.newPath || conf.new_path);
    }

    readFileSync(arg) {
        const conf = this._conf(arg);
        const file = this.getFile(normalize(this.getDataFilePath(conf.path)));
        if(!file || file === CONSTANT_FOLDER) return new ArrayBuffer(0);
        return file;
    }

    writeFileSync(arg) {
        const conf = this._conf(arg);
        const path = normalize(this.getDataFilePath(conf.path));
        this.vfs[path] = conf.data || conf.buffer || new ArrayBuffer(0);
        return 0;
    }
}
