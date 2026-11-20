import AppSettingsManager from "./AppSettingsManager";

export class ChangesWatcher {
    static lastChangesCount = "";
    static suppressUntil = 0;
    static restarting = false;

    /**
     * Temporarily ignore file-change notifications. Used after a manual save
     * so the same write doesn't trigger a second automatic restart.
     */
    static hold(ms) {
        ChangesWatcher.suppressUntil = Date.now() + (ms || 1500);
    }

    static async init(player) {
        if(!AppSettingsManager.getObject("cfgAutoRefresh", true)) return;
        if(!player.projectPath) return;

        await ChangesWatcher.onProjectChange(player);
        setInterval(async () => {
            const changed = await ChangesWatcher.isChanged();
            if(!changed) return;
            if(Date.now() < ChangesWatcher.suppressUntil) return;
            /* A save often bumps the counter more than once (write + rename).
             * Restarting again while the first restart is still running made
             * the preview flicker, so overlapping runs are skipped and the
             * counter is re-synced afterwards. */
            if(ChangesWatcher.restarting) return;
            ChangesWatcher.restarting = true;
            try {
                await player.restart();
                await ChangesWatcher.isChanged();
            } catch(e) {
                console.warn("Auto restart failed", e);
            } finally {
                ChangesWatcher.restarting = false;
            }
        }, 2500);
    }

    static async onProjectChange(player) {
        if(!AppSettingsManager.getObject("cfgAutoRefresh", true)) return;
        if(!player.projectPath) return;

        const projectName = player.projectPath.substring(10);
        try {
            await fetch("/api/watch/" + projectName);
            await ChangesWatcher.isChanged();
            console.log("Now watching for changes in", projectName);
        } catch(e) {
            console.warn("Cannot watch project", e);
        }
    }

    static async isChanged() {
        try {
            const resp = await fetch("/api/change_count");
            const value = await resp.text();
            const result = value !== ChangesWatcher.lastChangesCount;
            ChangesWatcher.lastChangesCount = value;

            if(result) {
                console.info("Detect changes in proj", value);
            }

            return result;
        } catch(e) {
            return false;
        }
    }
}
