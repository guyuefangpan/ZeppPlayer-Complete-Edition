/* Minimal preload bridge. The renderer runs with contextIsolation and no
 * node integration, so the only way to resolve a dropped File back to its
 * absolute path (needed by drag & drop import) is webUtils here. */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("zpDesktop", {
    isDesktop: true,
    getPathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file) || "";
        } catch (e) {
            return "";
        }
    },
    /* Raw key events forwarded from the main process. They are captured
     * before the renderer applies IME composition, so shortcuts keep working
     * while a Chinese/Japanese IME is active. */
    onKeyEvent: (callback) => {
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on("zp-key-event", handler);
        return () => ipcRenderer.removeListener("zp-key-event", handler);
    },
});
