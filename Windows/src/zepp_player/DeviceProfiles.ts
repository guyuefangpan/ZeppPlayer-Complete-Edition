import zeppDevices from "../data/zepp_devices.json";

export type DeviceInfo = {
    screenWidth: number;
    screenHeight: number;
    deviceName: string;
    deviceSource?: number;
    hasOverlay?: boolean;
    circleScreen?: boolean;
    enablePropBanList?: boolean;
    swapRedAndBlueTGA?: boolean;
    defaultFontSize?: number,
    useAbsolutePathsInHuamiFS?: boolean,
}

export const CUSTOM_DEVICES_KEY = "zp_custom_devices";

let profilesRevision = 0;

export function getProfilesRevision() {
    return profilesRevision;
}

/**
 * Reads user supplied device definitions. Each entry uses the same fields as
 * DeviceInfo and is merged on top of the built-in table, so unsupported bands
 * can be added without touching the source.
 */
export function readCustomProfiles(): { [p: string]: Partial<DeviceInfo> } {
    try {
        const raw = window.localStorage.getItem(CUSTOM_DEVICES_KEY);
        if(!raw) return {};
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === "object") ? parsed : {};
    } catch(e) {
        console.warn("Invalid custom device profiles", e);
        return {};
    }
}

export function saveCustomProfiles(profiles: { [p: string]: Partial<DeviceInfo> }) {
    window.localStorage.setItem(CUSTOM_DEVICES_KEY, JSON.stringify(profiles || {}));
    profilesRevision++;
}

export function getDeviceProfiles(): { [p: string]: DeviceInfo } {
    const devices: {[id: string]: DeviceInfo} = {};

    for(const row of zeppDevices) {
        devices[row.id] = {
            circleScreen: row.screenShape == "round",
            deviceName: row.deviceName,
            deviceSource: row.deviceSource[0],
            screenHeight: row.screenHeight,
            screenWidth: row.screenWidth,
            hasOverlay: ["mi_band7", "band7", "gts4", "gts4mini"].indexOf(row.id) > -1,
            swapRedAndBlueTGA: ["mi_band7", "band7", "gts4mini"].indexOf(row.id) < 0,
            defaultFontSize: row.id == "gts4mini" ? 12 : null,
            enablePropBanList: row.id == "mi_band7",
            useAbsolutePathsInHuamiFS: row.id == "mi_band7",
        }
    }

    const custom = readCustomProfiles();
    for(const id of Object.keys(custom)) {
        const base = devices[id] || {
            deviceName: id,
            screenWidth: 480,
            screenHeight: 480,
            circleScreen: true,
            hasOverlay: false,
            swapRedAndBlueTGA: true,
        } as DeviceInfo;
        devices[id] = Object.assign({}, base, custom[id]);
    }

    return devices;
}
