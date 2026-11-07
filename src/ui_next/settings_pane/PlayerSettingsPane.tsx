import React from "preact/compat";
import {Dialog, DialogActions, DialogContent, DialogTitle} from "../base/Modal";
import {BackdropProps} from "../base/Backdrop";
import {Button} from "../base/Button";
import {BooleanSettingsOption} from "./BooleanSettingsOption";
import {CssSettingsOption} from "./CssSettingsOption";
import {CssColorOptions} from "./CssColorOptions";
import AppSettingsManager from "../../ui_managment/AppSettingsManager";
import {SettingsListItem} from "./SettingsListItem";
import I18n from "../../zepp_player/i18n.js";
import {zpConfirm} from "../../zepp_player/zpDialogs.js";

function LanguageSelector() {
    const [locale, setLocale] = React.useState(I18n.locale);
    const change = (e) => {
        I18n.setLanguage(e.target.value);
        location.reload();
    };
    return (
        <SettingsListItem title={I18n.t("settings.language")} onClick={() => {}}>
            <select value={locale} onChange={change}
                style={{color: "#000", background: "#fff"}}>
                <option value="zh">{I18n.t("lang.zh")}</option>
                <option value="en">{I18n.t("lang.en")}</option>
            </select>
        </SettingsListItem>
    );
}

function MobileAccessItem() {
    const [url, setUrl] = React.useState("");
    const [copied, setCopied] = React.useState(false);
    const [isMobileApp, setIsMobileApp] = React.useState(false);

    React.useEffect(() => {
        let alive = true;
        fetch("/api/server_info").then((r) => r.json()).then((j) => {
            if(!alive || !j) return;
            // The APK runs on the phone itself, a LAN address is meaningless.
            if(j.mobile) {
                setIsMobileApp(true);
                return;
            }
            setUrl((j.urls && j.urls.length) ? j.urls[0] : `http://127.0.0.1:${j.port}/`);
        }).catch(() => {});
        return () => { alive = false; };
    }, []);

    if(isMobileApp) return null;
    if(!url) return null;

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch (e) {}
    };

    return (
        <SettingsListItem title={I18n.t("settings.mobileAccess")}
            description={I18n.t("settings.mobileAccessDesc")} noClickHandler>
            <div style={{display: "flex", alignItems: "center", gap: "8px"}}>
                <span style={{
                    fontSize: "12px", opacity: .85, userSelect: "text", maxWidth: "220px",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
                }}>{url}</span>
                <Button onClick={copy}>
                    {copied ? I18n.t("settings.copied") : I18n.t("settings.copy")}
                </Button>
            </div>
        </SettingsListItem>
    );
}

const RESTORE_KEEP_KEYS = [
    "zp_lang",                    // language choice
    "zp_profile_name",            // device model
    "zepp_player_last_project",   // current project
    "zepp_player_rotation",       // screen rotation
    "zp_activePanel",             // visible side panel
];

export function PlayerSettingsPane(props: BackdropProps) {
    const performWipe = async () => {
        if(await zpConfirm(I18n.t("settings.confirmRestore"))) {
            // Restore player settings only. Clearing everything would also
            // drop the language, the selected project and the device model.
            for(const key of Object.keys(localStorage)) {
                if(!key.startsWith("zp_") && !key.startsWith("zepp_player_")) continue;
                if(RESTORE_KEEP_KEYS.indexOf(key) > -1) continue;
                localStorage.removeItem(key);
            }
            location.reload();
        }
    }

    return (
        <Dialog {...props} maxWidth="500px">
            <DialogTitle>
                {I18n.t("settings.title")}
            </DialogTitle>
            <DialogContent noMargin>
                <LanguageSelector />
                <hr />
                <MobileAccessItem />
                <hr />
                <BooleanSettingsOption
                    title={I18n.t("settings.keepState")}
                    description={I18n.t("settings.keepStateDesc")}
                    configKey="cfgKeepState"
                    fallback={true} />
                <BooleanSettingsOption
                    title={I18n.t("settings.autoRestart")}
                    description={I18n.t("settings.autoRestartDesc")}
                    configKey="cfgAutoRefresh"
                    fallback={true} />
                <BooleanSettingsOption
                    title={I18n.t("settings.preferBuild")}
                    description={I18n.t("settings.preferBuildDesc")}
                    configKey="preferBuildDir"
                    fallback={true} />
                <hr />
                <CssColorOptions />
                <hr />
                <CssSettingsOption
                    title={I18n.t("settings.displaySize")}
                    description={I18n.t("settings.displaySizeDesc")}
                    cssPropName={'display-size'}
                    inputType="range" />

            </DialogContent>
            <DialogActions>
                <Button primary onClick={props.onCancel}>
                    {I18n.t("settings.close")}
                </Button>
                <Button onClick={performWipe}>
                    {I18n.t("settings.restore")}
                </Button>
            </DialogActions>
        </Dialog>
    )
}