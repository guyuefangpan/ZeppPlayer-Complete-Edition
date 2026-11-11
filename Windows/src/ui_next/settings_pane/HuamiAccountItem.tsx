import React from "preact/compat";

import {SettingsListItem} from "./SettingsListItem";
import {Button} from "../base/Button";
import I18n from "../../zepp_player/i18n.js";
import {zpConfirm} from "../../zepp_player/zpDialogs.js";
import {zeusInfo, zeusLogout} from "../../ui_managment/ZeusClient.js";
import {openHuamiLoginDialog} from "../../ui_managment/HuamiLoginDialog.js";

/* zeus keeps its login state in ~/.zepp/.zeus; this row writes the three
 * values there from a pasted browser cookie instead of running `zeus login`. */
export function HuamiAccountItem() {
    const [login, setLogin] = React.useState<any>(null);
    const [available, setAvailable] = React.useState(true);

    const refresh = () => {
        zeusInfo()
            .then((j) => setLogin((j && j.login) || {loggedIn: false}))
            .catch(() => setAvailable(false));
    };

    React.useEffect(refresh, []);

    if (!available) return null;

    const loggedIn = !!(login && login.loggedIn);
    const description = loggedIn
        ? I18n.t("settings.huamiLoggedIn", "已登录") + " · ID " + login.userId
        : I18n.t("settings.huamiLoggedOut", "未登录，真机预览与联调需要华米账号");

    const logout = async () => {
        if (!(await zpConfirm(I18n.t("settings.huamiLogoutConfirm", "退出华米账号登录？")))) return;
        try {
            const res = await zeusLogout();
            setLogin((res && res.login) || {loggedIn: false});
        } catch (e) {}
    };

    return (
        <SettingsListItem title={I18n.t("settings.huamiAccount", "华米账号")}
            description={description} noClickHandler>
            {loggedIn ? (
                <div style={{display: "flex", alignItems: "center", gap: "8px"}}>
                    <Button onClick={() => openHuamiLoginDialog(refresh)}>
                        {I18n.t("settings.huamiRelogin", "重新登录")}
                    </Button>
                    <Button onClick={logout}>
                        {I18n.t("settings.huamiLogout", "退出登录")}
                    </Button>
                </div>
            ) : (
                <Button primary onClick={() => openHuamiLoginDialog(refresh)}>
                    {I18n.t("settings.huamiLogin", "粘贴 Cookie 登录")}
                </Button>
            )}
        </SettingsListItem>
    );
}
