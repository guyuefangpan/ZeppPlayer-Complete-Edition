import React from "preact/compat";
import {Dialog, DialogActions, DialogContent, DialogTitle} from "../base/Modal";
import AppSettingsManager from "../../ui_managment/AppSettingsManager";
import {ListProjectsRow} from "../types/ServerEntities";
import {OverviewCard} from "./OverviewCard";
import {Button} from "../base/Button";

import "./Overview.css";
import {ProjectPicker} from "../../ui_managment/ProjectPicker";
import I18n from "../../zepp_player/i18n.js";

export function OverviewRoot(props: {open: boolean, onClose: () => any}) {
    const items = ProjectPicker.projects;

    return (
        <Dialog open={props.open} onCancel={props.onClose}>
            <DialogTitle>{I18n.t("overview.title")}</DialogTitle>
            <DialogContent>
                <div className="zp-overview">
                    {items.map((e) => <OverviewCard key={e.title} onCancel={props.onClose} {...e} />)}
                </div>
            </DialogContent>
            <DialogActions>
                <Button primary onClick={props.onClose}>
                    {I18n.t("overview.close")}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
