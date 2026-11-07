import {Backdrop} from "./base/Backdrop";
import {CommandPalette} from "./palette/CommandPalette";
import React from "preact/compat";
import {getChangeProjectCommands} from "./command_palette/getChangeProjectCommands";
import {getChangeProfileCommands} from "./command_palette/getChangeProfileCommands";
import {CommandPaletteItem} from "./palette/CommandPaletteItem";
import I18n from "../zepp_player/i18n.js";

export type CommandPickerProps = {
    open: boolean,
    changePane: (pane: string) => any,
};

export function CommandPicker(props: CommandPickerProps) {
    const onCancel = () => props.changePane("");

    return (
        <Backdrop open={props.open}>
            <CommandPalette onCancel={onCancel}>
                <CommandPaletteItem value="ch_dir" onSelect={() => props.changePane("change_projects_dir")}>
                    {I18n.t("cmd.changeDir")}
                </CommandPaletteItem>
                <CommandPaletteItem value="p_cfg" onSelect={() => props.changePane("settings")}>
                    {I18n.t("cmd.openSettings")}
                </CommandPaletteItem>
                <CommandPaletteItem value="p_overview" onSelect={() => props.changePane("overview")}>
                    {I18n.t("cmd.overview")}
                </CommandPaletteItem>
                <CommandPaletteItem value="p_shortcuts" onSelect={() => props.changePane("shortcuts")}>
                    {I18n.t("cmd.shortcuts")}
                </CommandPaletteItem>
                {...getChangeProjectCommands(onCancel)}
                {...getChangeProfileCommands(onCancel)}
            </CommandPalette>
        </Backdrop>
    );
}