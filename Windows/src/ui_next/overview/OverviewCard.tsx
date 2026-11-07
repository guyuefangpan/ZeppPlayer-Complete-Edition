import {ListProjectsRow} from "../types/ServerEntities";
import React from "preact/compat";
import {ChromeZeppPlayer} from "../../zepp_player/ChromeZeppPlayer";
import {ProjectPicker} from "../../ui_managment/ProjectPicker";
import {getDeviceProfiles} from "../../zepp_player/DeviceProfiles";


export function OverviewCard(props: ListProjectsRow & {onCancel: () => any}) {
    const playerRef = React.useRef<ChromeZeppPlayer | null>(null);
    if(!playerRef.current) {
        const p = new ChromeZeppPlayer();
        p.config.persistentKeyName = "disabled";
        const saved = localStorage.zp_profile_name;
        const profiles = getDeviceProfiles();
        p.profileName = (saved && profiles[saved]) ? saved : "mi_band7";
        playerRef.current = p;
    }
    const player = playerRef.current;

    const ref = React.createRef<HTMLCanvasElement>();
    const previewUrl = `${props.url}/preview_${player.profileName}.png`;
    const [previewSrc, setPreviewSrc] = React.useState(previewUrl);
    const building = React.useRef(false);

    const rebuildPreview = async () => {
        if(building.current) return;
        building.current = true;
        try {
            await player.setProject(props.url);
            await player.init();

            const canvas = await player.render(true);
            if(ref.current) ref.current.getContext("2d").drawImage(canvas, 0, 0);

            const blob = await (await fetch(canvas.toDataURL("image/png"))).blob();
            await fetch(previewUrl, {method: "PUT", body: blob});

            // The image element already failed to load; point it at a fresh
            // URL so the newly written preview is actually displayed.
            setPreviewSrc(previewUrl + "?t=" + Date.now());
        } catch(e) {
            console.warn("Preview rebuild failed", props.url, e);
        } finally {
            building.current = false;
        }
    };

    React.useEffect(() => {
        return () => player.dispose();
    }, [player]);

    const changeProject = () => {
        ProjectPicker.applyProjectUrl(props.url);
        props.onCancel();
    };

    return (
        <div onClick={changeProject} className="zp-overview__card">
            <img src={previewSrc}
                 onError={rebuildPreview}
                 alt="" />
            <canvas width={player.profileData.screenWidth}
                 height={player.profileData.screenHeight}
                 ref={ref} />
            <span>{props.title}</span>
        </div>
    )
}
