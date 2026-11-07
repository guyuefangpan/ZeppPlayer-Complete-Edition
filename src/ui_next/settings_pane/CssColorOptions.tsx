import React from "preact/compat";
import {CssSettingsOption} from "./CssSettingsOption";
import I18n from "../../zepp_player/i18n.js";

export const CSS_OPTIONS: {[id: string]: string} = {
    "accent": "settings.color.accent",
    "background": "settings.color.background",
    "foreground": "settings.color.foreground",
    "panel": "settings.color.panel",
    "panel-text": "settings.color.panelText",
    "editor": "settings.color.editor",
    "editor-text": "settings.color.editorText",
    "input": "settings.color.input",
    "input-text": "settings.color.inputText",
}

export function CssColorOptions() {
    return (
        <>
            {Object.keys(CSS_OPTIONS).map((key) => <CssSettingsOption
                title={I18n.t(CSS_OPTIONS[key])}
                description=""
                cssPropName={key}
                inputType="color" />)}
        </>
    )
}