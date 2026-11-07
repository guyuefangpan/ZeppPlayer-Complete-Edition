import {render} from "preact";
import React from "preact/compat";
import {ServerDirectoryPicker} from "./ServerDirectoryPicker";
import {PropEditorPanel} from "./panels/PropEditorPanel";
import ZeppPlayer from "../zepp_player/ZeppPlayer";
import {CommandPicker} from "./CommandPicker";
import {Dialog, DialogActions, DialogContent, DialogTitle} from "./base/Modal";
import {Button} from "./base/Button";
import {PlayerSettingsPane} from "./settings_pane/PlayerSettingsPane";
import {OverviewRoot} from "./overview/OverviewRoot";
import {PanelCode} from "./panel_code/PanelCode";
import {ShortcutsPane} from "./shortcuts/ShortcutsPane";


export function RootComponent(props: {player: ZeppPlayer}) {
    const [pane, setPane] = React.useState<string>("");
    (window as any)._setReactPane = setPane;

    return (
        <>
            <ServerDirectoryPicker open={pane == "change_projects_dir"}
                                   onCancel={() => setPane("")} />
            <CommandPicker open={pane == "command_picker"}
                           changePane={setPane} />
            <OverviewRoot open={pane == "overview"}
                          onClose={() => setPane("")} />
            <PlayerSettingsPane open={pane == "settings"}
                                onCancel={() => setPane("")} />
            <ShortcutsPane open={pane == "shortcuts"}
                           onCancel={() => setPane("")} />
        </>
    )
}

export function start(node: HTMLElement, player: ZeppPlayer) {
    // Each root renders independently: a broken panel must never take the
    // whole interface down on a device without DevTools.
    try {
        render(<RootComponent player={player} />, node);
    } catch (e) {
        console.error("UI root failed", e);
    }

    // Override legacy components
    try {
        render(<PropEditorPanel player={player} />, document.getElementById("view_edit"));
    } catch (e) {
        console.error("Property editor failed", e);
    }

    // Persistent code panel (always visible, follows current page)
    try {
        render(<PanelCode player={player} />, document.getElementById("code_panel"));
    } catch (e) {
        console.error("Code panel failed", e);
    }
}
