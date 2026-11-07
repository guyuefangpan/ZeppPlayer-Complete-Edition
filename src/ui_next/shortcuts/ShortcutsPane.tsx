import React from "preact/compat";
import {Dialog, DialogActions, DialogContent, DialogTitle} from "../base/Modal";
import {BackdropProps} from "../base/Backdrop";
import {Button} from "../base/Button";
import I18n from "../../zepp_player/i18n.js";

import "./ShortcutsPane.css";

type ShortcutRow = {
    keys: string[],
    labelKey: string,
};

const GROUPS: {titleKey: string, rows: ShortcutRow[]}[] = [
    {
        titleKey: "shortcuts.group.playback",
        rows: [
            {keys: ["1"], labelKey: "shortcuts.mode1"},
            {keys: ["2"], labelKey: "shortcuts.mode2"},
            {keys: ["3"], labelKey: "shortcuts.mode4"},
            {keys: ["P"], labelKey: "shortcuts.pause"},
            {keys: ["Shift", "S"], labelKey: "shortcuts.shift"},
            {keys: ["Shift", "Z"], labelKey: "shortcuts.events"},
            {keys: ["Shift", "W"], labelKey: "shortcuts.reload"},
        ],
    },
    {
        titleKey: "shortcuts.group.panels",
        rows: [
            {keys: ["c"], labelKey: "shortcuts.panelConsole"},
            {keys: ["e"], labelKey: "shortcuts.panelEdit"},
            {keys: ["x"], labelKey: "shortcuts.panelExplorer"},
            {keys: ["Esc"], labelKey: "shortcuts.back"},
            {keys: ["Ctrl", "P"], labelKey: "shortcuts.palette"},
            {keys: ["F1", "?"], labelKey: "shortcuts.help"},
        ],
    },
    {
        titleKey: "shortcuts.group.project",
        rows: [
            {keys: ["+"], labelKey: "shortcuts.nextProject"},
            {keys: ["_"], labelKey: "shortcuts.prevProject"},
            {keys: ["Ctrl", "S"], labelKey: "shortcuts.saveCode"},
            {keys: ["Ctrl", "Alt", "S"], labelKey: "shortcuts.screenshot"},
            {keys: ["Ctrl", "Alt", "Shift", "S"], labelKey: "shortcuts.screenshotProject"},
            {keys: ["R"], labelKey: "shortcuts.restart"},
        ],
    },
];

export function ShortcutsPane(props: BackdropProps) {
    return (
        <Dialog {...props} maxWidth="620px">
            <DialogTitle>{I18n.t("shortcuts.title")}</DialogTitle>
            <DialogContent>
                <div className="zp-shortcuts">
                    {GROUPS.map((group) => (
                        <section className="zp-shortcuts__group" key={group.titleKey}>
                            <h4>{I18n.t(group.titleKey)}</h4>
                            {group.rows.map((row) => (
                                <div className="zp-shortcuts__row" key={row.labelKey + row.keys.join("")}>
                                    <span className="zp-shortcuts__keys">
                                        {row.keys.map((key) => (
                                            <kbd key={key}>{key}</kbd>
                                        ))}
                                    </span>
                                    <span className="zp-shortcuts__label">{I18n.t(row.labelKey)}</span>
                                </div>
                            ))}
                        </section>
                    ))}
                </div>
            </DialogContent>
            <DialogActions>
                <Button primary onClick={props.onCancel}>
                    {I18n.t("shortcuts.close")}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
