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

import {ChangesWatcher} from "./ChangesWatcher";
import ZeppPlayer from "../zepp_player/ZeppPlayer";
import AppSettingsManager from "./AppSettingsManager";
import I18n from "../zepp_player/i18n.js";
import {zpAlert, zpConfirm} from "../zepp_player/zpDialogs.js";
import {showToast} from "../zepp_player/zpToast.js";

export type ProjectRow = {
    title: string,
    url: string,
}

/* localStorage can throw inside restricted WebViews. */
function readLocal(key: string, fallback: string): string {
    try {
        const v = localStorage[key];
        return v === undefined || v === null ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

function writeLocal(key: string, value: string) {
    try { localStorage[key] = value; } catch (e) {}
}

export class ProjectPicker {
    public static projects: ProjectRow[] = [];
    private static view: HTMLSelectElement = document.getElementById("project_select") as HTMLSelectElement;
    private static player: ZeppPlayer;

    static isRealProject(url: string) {
        return !!url && url.charAt(0) !== "<";
    }

    static getProject() {
        const value = ProjectPicker.view.value;
        return ProjectPicker.isRealProject(value) ? value : "";
    }

    static async setup(player: ZeppPlayer) {
        ProjectPicker.player = player;
        ProjectPicker.view.onchange = () => { ProjectPicker.handleChange(); };
        await ProjectPicker.refreshOptions();
    }

    /**
     * Re-reads the projects folder and rebuilds the picker. Returns the URL
     * that ended up selected (empty when the folder holds no project).
     */
    static async refreshOptions(preferredUrl?: string): Promise<string> {
        const preferBuildDir = AppSettingsManager.getObject("preferBuildDir", true);

        const response = await fetch(`/api/list_projects?preferBuildDir=${preferBuildDir}`);
        const projects = await response.json();
        ProjectPicker.projects = Array.isArray(projects) ? projects : [];

        const view = ProjectPicker.view;
        while(view.options.length > 0) view.remove(0);

        const availableURLs: string[] = [];
        for(const row of ProjectPicker.projects) {
            const opt = document.createElement("option");
            opt.value = row.url;
            opt.innerText = row.title;
            availableURLs.push(row.url);
            view.appendChild(opt);
        }

        const addAction = (value: string, label: string) => {
            const opt = document.createElement("option");
            opt.value = value;
            opt.innerText = label;
            view.appendChild(opt);
        };
        addAction("<open_folder>", I18n.t("picker.fileManager"));
        addAction("<change_folder>", I18n.t("picker.changeDir"));
        if(availableURLs.length > 0) {
            addAction("<delete_project>", I18n.t("picker.deleteProject"));
        }

        // Always end up on a real project (never on an action entry).
        let selected = "";
        if(preferredUrl) {
            for(const url of availableURLs) {
                if(url === preferredUrl || url.indexOf(preferredUrl + "/") === 0) {
                    selected = url;
                    break;
                }
            }
        }
        if(!selected) {
            const lastProject = readLocal("zepp_player_last_project", "");
            if(lastProject && availableURLs.indexOf(lastProject) > -1) {
                selected = lastProject;
            } else if(availableURLs.length > 0) {
                selected = availableURLs[0];
            }
        }

        view.value = selected;
        writeLocal("zepp_player_last_project", selected);
        return selected;
    }

    private static async handleChange() {
        const view = ProjectPicker.view;
        const value = view.value;
        const previous = readLocal("zepp_player_last_project", "");

        if(value === "<open_folder>") {
            view.value = previous;
            try {
                const r = await fetch("/api/open_projects");
                const j = await r.json();
                if (j && !j.ok) {
                    await zpAlert(I18n.t("dialog.openFolderFailed", "Cannot open the projects folder") + ": " + (j.msg || ""));
                }
            } catch (e) {
                await zpAlert(I18n.t("dialog.openFolderFailed", "Cannot open the projects folder") + ": " + e);
            }
            return;
        }

        if(value === "<change_folder>") {
            view.value = previous;
            try {
                const r = await fetch("/api/choose_projects_dir");
                const j = await r.json();
                if (j && j.ok) {
                    location.reload();
                } else if (j && j.msg) {
                    await zpAlert(j.msg);
                }
            } catch (e) {
                await zpAlert(I18n.t("dialog.changeDirFailed", "Cannot change the projects folder") + ": " + e);
            }
            return;
        }

        if(value === "<delete_project>") {
            view.value = previous;
            await ProjectPicker.deleteProject(previous);
            return;
        }

        await ProjectPicker.applyProjectUrl(value);
    }

    static async deleteProject(url: string) {
        if(!ProjectPicker.isRealProject(url)) return;

        let name = url;
        for(const row of ProjectPicker.projects) {
            if(row.url === url) { name = row.title; break; }
        }
        const parts = url.split("/").filter(Boolean);
        if(name === url && parts.length) name = parts[parts.length - 1];

        const ok = await zpConfirm(
            I18n.t("dialog.deleteProjectConfirm", "Delete project \"" + name + "\" and all of its files?")
                .replace("{name}", name)
        );
        if(!ok) return;

        try {
            const r = await fetch("/api/delete_project", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({projectUrl: url}),
            });
            const j = await r.json();
            if(!j || !j.ok) {
                await zpAlert(I18n.t("dialog.deleteProjectFailed", "Cannot delete the project") + ": " + ((j && j.msg) || ""));
                return;
            }
        } catch(e) {
            await zpAlert(I18n.t("dialog.deleteProjectFailed", "Cannot delete the project") + ": " + e);
            return;
        }

        const selected = await ProjectPicker.refreshOptions();
        if(selected) {
            await ProjectPicker.applyProjectUrl(selected);
            showToast(I18n.t("dialog.projectDeleted", "Project deleted"), false);
            return;
        }

        // Nothing left to preview: a reload rebuilds the UI without a project.
        location.reload();
    }

    static async applyProjectUrl(url: string) {
        if(!ProjectPicker.isRealProject(url)) return;
        writeLocal("zepp_player_last_project", url);
        ProjectPicker.view.value = url;
        try {
            await ProjectPicker.player.finish();
            await ProjectPicker.player.setProject(ProjectPicker.getProject());
            await ProjectPicker.player.init();
            await ChangesWatcher.onProjectChange(ProjectPicker.player);
        } catch(e) {
            console.error("Project switch failed", e);
            await zpAlert(I18n.t("dialog.openProjectFailed", "Cannot open the project") + ": " + (e && e.message || e));
        }
    }
}
