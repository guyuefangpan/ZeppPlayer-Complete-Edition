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

import HuamiSensorMock from "./zepp_env/HuamiSensor.js";
import {ConsoleMock} from "./zepp_env/ConsoleCatch.js";
import DeviceRuntimeCoreMock from "./zepp_env/DeviceRuntimeCore.js";
import HuamiFsMock from "./zepp_env/HuamiFs.js";
import HuamiSettingMock from "./zepp_env/HuamiSetting.js";
import HuamiUIMock from "./ui/HuamiUI.js";
import TimerMock from "./zepp_env/Timer.js";
import {HuamiBLEMock} from "./zepp_env/HuamiBLE.js";
import {MessagingMock} from "./zepp_env/MessagingMock.js";
import {HmApp} from "./zepp_env/HmApp.js";
import ZeppPlayer from "./ZeppPlayer";
import ZeppRuntime from "./ZeppRuntime";

/* ZeppOS sources position widgets in design pixels while the simulator renders
 * at the emulated screen size, so `px()` has to scale between the two. */
function designWidthOf(player: ZeppPlayer): number {
    const cfg: any = player && player.appConfig;
    if(!cfg) return 0;

    // configVersion v2 keeps one designWidth for the whole app
    if(typeof cfg.designWidth === "number" && cfg.designWidth > 0) return cfg.designWidth;

    const targets = cfg.targets;
    if(!targets) return 0;

    const ident = Object.keys(targets)[0];
    const width = targets[ident] && targets[ident].designWidth;
    return typeof width === "number" && width > 0 ? width : 0;
}

/* app.json i18n tables are the source for `getText()` in official templates. */
function appI18nTable(player: ZeppPlayer): {[key: string]: string} {
    const cfg: any = (player && player.appConfig) || {};
    const table = cfg.i18n;
    if(!table) return {};

    const language = player.deviceState && player.deviceState.OS_LANGUAGE
        ? player.deviceState.OS_LANGUAGE.value
        : null;

    return table[language] || table[cfg.defaultLanguage] || table["en-US"] || {};
}

function makePx(screenWidth: number, designWidth: number) {
    if(!screenWidth || !designWidth) return (v: number) => v;
    return (v: number) => Math.round(v * screenWidth / designWidth);
}

export class AppEnvironment {
    hmApp: HmApp;
    hmFS: HuamiFsMock;
    hmSetting: HuamiSettingMock;
    DeviceRuntimeCore: DeviceRuntimeCoreMock;
    App: (config: any) => any;
    px: (v: number) => number;
    __zp_screen_width: number;
    __zp_design_width: number;
    self: AppEnvironment;

    __$$module$$__: any = {};
    __$$hmAppManager$$__: any = {
        currentApp: {
            pid: 10,
            current: {},
            app: {
                __globals__: {}
            }
        }
    }

    constructor(player: ZeppPlayer) {
        this.self = this;
        this.hmApp = new HmApp(player);
        this.hmSetting = new HuamiSettingMock(player);
        this.hmFS = new HuamiFsMock(player);
        this.DeviceRuntimeCore = new DeviceRuntimeCoreMock(player, this.__$$hmAppManager$$__);
        /* Official templates call the bare `App(...)` global; compiled
         * packages assign `DeviceRuntimeCore.App(...)` themselves. */
        this.App = (config: any) => {
            const app = this.DeviceRuntimeCore.App(config);
            this.__$$hmAppManager$$__.currentApp.app = app;
            return app;
        };
        this.__zp_screen_width = player.profileData.screenWidth;
        this.__zp_design_width = designWidthOf(player);
        this.px = makePx(this.__zp_screen_width, this.__zp_design_width);
    }
}

export function createPageEnv(runtime: ZeppRuntime, appRuntime: AppEnvironment) {
    const object: any = {};
    object.SLEEP_REFERENCE_ZERO = 24 * 60;

    // Share global environment
    object.self = object;

    // Base libraries
    object.DeviceRuntimeCore = new DeviceRuntimeCoreMock(runtime, appRuntime.__$$hmAppManager$$__);
    object.hmUI = new HuamiUIMock(runtime);
    object.hmFS = new HuamiFsMock(runtime);
    object.hmApp = new HmApp(runtime);
    object.hmSetting = new HuamiSettingMock(runtime);
    object.hmBle = new HuamiBLEMock(runtime);
    object.messaging = new MessagingMock(runtime);
    object.hmSensor = new HuamiSensorMock(runtime);
    object.timer = new TimerMock(runtime);
    object.console = new ConsoleMock(runtime, console);

    // Design-pixel scaling used by official templates (`px(...)`)
    object.__zp_screen_width = runtime.screen[0];
    object.__zp_design_width = designWidthOf(runtime.player);
    object.px = makePx(object.__zp_screen_width, object.__zp_design_width);

    // Links
    object.__$$module$$__ = {};
    object.__$$hmAppManager$$__ = appRuntime.__$$hmAppManager$$__;
    object.Logger = object.DeviceRuntimeCore.HmLogger;
    object.WatchFace = (conf: any) => object.DeviceRuntimeCore.WatchFace(conf);
    object.Page = (conf: any) => object.DeviceRuntimeCore.Page(conf);

    // Translations declared in app.json, used by `@zos/i18n`
    object.__zp_i18n = appI18nTable(runtime.player);

    // Override x to prevent conflict with preact
    object.x = undefined;

    // Custom
    const glob = appRuntime.__$$hmAppManager$$__.currentApp.app.__globals__;
    for(let i in glob) {
        object[i] = glob[i];
    }

    // Release device-side messaging listener when this page runtime is torn down
    if(runtime && runtime.onDestroy && object.messaging) {
        const mm = object.messaging;
        runtime.onDestroy.push(() => { if(mm && mm.dispose) mm.dispose(); });
    }

    return object;
}
