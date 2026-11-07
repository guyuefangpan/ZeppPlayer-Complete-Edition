import AppSettingsManager from "./AppSettingsManager";

export class ChangesWatcher {
    static lastChangesCount = "";
    static suppressUntil = 0;

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
            try {
                await player.restart();
            } catch(e) {
                console.warn("Auto restart failed", e);
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
