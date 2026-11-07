import {ProjectPicker} from "../../ui_managment/ProjectPicker";
import {CommandPaletteItem} from "../palette/CommandPaletteItem";
import React from "preact/compat";
import I18n from "../../zepp_player/i18n.js";

export function getChangeProjectCommands(onSelect: () => any) {
    const projects = ProjectPicker.projects;
    const applyProject = (url: string) => {
        console.log(url);
        ProjectPicker.applyProjectUrl(url);
        onSelect();
    }

    return projects.map((v, i) => (
        <CommandPaletteItem key={i}
                            value={v.url}
                            onSelect={() => applyProject(v.url)}>
            {`${I18n.t("cmd.setProject")}${v.title}`}
        </CommandPaletteItem>
    ))
}