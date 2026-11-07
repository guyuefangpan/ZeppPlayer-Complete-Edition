/* localStorage can be unavailable (privacy modes, some WebViews). Never let
 * that break the whole UI: fall back to an in-memory store. */
const memory = Object.create(null);

function read(key) {
    try {
        const value = localStorage[key];
        if (value !== undefined) return value;
    } catch (e) {}
    return memory[key];
}

function write(key, value) {
    memory[key] = value;
    try {
        localStorage[key] = value;
    } catch (e) {}
}

export default class AppSettingsManager {
    static getString(key, fallback) {
        const value = read(`zp_${key}`);
        return value === undefined ? fallback : value;
    }

    static setString(key, value) {
        write(`zp_${key}`, value);
    }

    static getObject(key, fallback) {
        const value = read(`zp_${key}`);
        if (value === undefined) return fallback;
        try {
            return JSON.parse(value);
        } catch (e) {
            return fallback;
        }
    }

    static setObject(key, value) {
        write(`zp_${key}`, JSON.stringify(value));
    }
}
