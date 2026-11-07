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

import { isDesktopShell, isAndroidApp, triggerDownload } from "./ViewMode.js";
import { showToast } from "../zepp_player/zpToast.js";
import I18n from "../zepp_player/i18n.js";

const FPS = 30;
const MAX_BITRATE = 4 * 1024 * 1024;
const MIN_BITRATE = 1.5 * 1024 * 1024;

/* The recorded clip is framed by the original product photo, used exactly as
 * supplied: the strap, the case and every colour are untouched. The asset is
 * a straight crop of that photo (330x948) with only the screen opening made
 * transparent (207x526 at (61,202)), so the watch canvas shows through the
 * real display and the rest of the picture stays opaque. The watch canvas
 * fills the opening, so its own ratio must be close to 207:526 (mi_band7 is
 * 192:490). */
const FRAME_URL = "/app/recording_frame.png";
const FRAME_BG = "#f3f4f6";
const FRAME_W = 330;
const FRAME_H = 948;
const HOLE_X = 61;
const HOLE_Y = 202;
const HOLE_W = 207;
const HOLE_H = 526;
const HOLE_RATIO = HOLE_W / HOLE_H;

let framePromise = null;

function loadFrame() {
    if (!framePromise) {
        framePromise = new Promise((resolve) => {
            try {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => resolve(null);
                img.src = FRAME_URL;
            } catch (e) {
                resolve(null);
            }
        });
    }
    return framePromise;
}

function pad(value) {
    return value < 10 ? "0" + value : String(value);
}

function stamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
        + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/* Chromium can encode H.264 in MP4 on recent builds; older WebViews only ship
 * the VP8/VP9 encoders, so fall back to WebM instead of failing. VP8 comes
 * before VP9 because every Android device can decode it, which matters when
 * the phone-side transcoder turns the recording into MP4. */
function pickMime() {
    const candidates = [
        "video/mp4;codecs=avc1.42E01E",
        "video/mp4",
        "video/webm;codecs=vp8",
        "video/webm;codecs=vp9",
        "video/webm",
    ];
    for (const type of candidates) {
        try {
            if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        } catch (e) {}
    }
    return "";
}

function bitrateFor(canvas) {
    const w = canvas.width || 480;
    const h = canvas.height || 480;
    const target = Math.round(w * h * FPS / 4);
    return Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, target));
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("cannot read video"));
        reader.readAsDataURL(blob);
    });
}

export default class VideoRecorder {
    constructor(player) {
        this.player = player;
        this.blob = null;
        this.extension = ".mp4";
        this.recorder = null;
        this.stream = null;
        this.chunks = [];
        this.state = "idle";
        this.composite = null;
        this.frameTimer = 0;
    }

    isRecording() {
        return this.state === "recording";
    }

    isBusy() {
        return this.state !== "idle";
    }

    /* Draws the live watch canvas into the band's screen opening. The frame is
     * only used for recording; screenshots keep grabbing the bare canvas. */
    _buildComposite(display, frame) {
        const composite = document.createElement("canvas");
        composite.width = FRAME_W;
        composite.height = FRAME_H;
        const ctx = composite.getContext("2d");
        const draw = () => {
            ctx.fillStyle = FRAME_BG;
            ctx.fillRect(0, 0, FRAME_W, FRAME_H);
            // Solid black under the opening, one pixel wider than the hole:
            // any rounding sliver stays black instead of showing the backdrop.
            ctx.fillStyle = "#000";
            ctx.fillRect(HOLE_X - 1, HOLE_Y - 1, HOLE_W + 2, HOLE_H + 2);
            if (display.width && display.height) {
                const scale = Math.min((HOLE_W + 2) / display.width, (HOLE_H + 2) / display.height);
                const dw = Math.round(display.width * scale);
                const dh = Math.round(display.height * scale);
                ctx.drawImage(display,
                    HOLE_X - 1 + Math.floor((HOLE_W + 2 - dw) / 2),
                    HOLE_Y - 1 + Math.floor((HOLE_H + 2 - dh) / 2),
                    dw, dh);
            }
            ctx.drawImage(frame, 0, 0, FRAME_W, FRAME_H);
        };
        draw();
        // Timers, not requestAnimationFrame: rAF stops when the window is
        // covered or minimized, which used to freeze the clip after one frame.
        this.frameTimer = setInterval(draw, Math.round(1000 / FPS));
        this.composite = composite;
        return composite;
    }

    _stopFrameLoop() {
        if (this.frameTimer) {
            clearInterval(this.frameTimer);
            this.frameTimer = 0;
        }
        this.composite = null;
    }

    /* Starts capturing the watch canvas. The recorder keeps running until
     * stop() is called, so the user decides how long the clip is. */
    async start() {
        if (this.state !== "idle") return;

        const display = document.getElementById("display");
        if (!display || !display.width || !display.height) {
            throw new Error(I18n.t("dialog.videoFailed", "Failed to record video"));
        }
        if (typeof display.captureStream !== "function" || typeof MediaRecorder === "undefined") {
            throw new Error(I18n.t("dialog.videoUnsupported",
                "Video recording is not supported on this device"));
        }

        const frame = await loadFrame();
        const ratio = display.width / display.height;
        const source = (frame && Math.abs(ratio - HOLE_RATIO) <= 0.03)
            ? this._buildComposite(display, frame)
            : display;

        const stream = source.captureStream(FPS);
        const mime = pickMime();
        const options = { videoBitsPerSecond: bitrateFor(source) };

        let recorder = null;
        if (mime) {
            try {
                recorder = new MediaRecorder(stream, Object.assign({mimeType: mime}, options));
            } catch (e) {}
            if (!recorder) {
                try { recorder = new MediaRecorder(stream, {mimeType: mime}); } catch (e) {}
            }
        }
        if (!recorder) {
            try {
                recorder = new MediaRecorder(stream);
            } catch (e) {
                stream.getTracks().forEach((track) => track.stop());
                this._stopFrameLoop();
                throw new Error(I18n.t("dialog.videoUnsupported",
                    "Video recording is not supported on this device"));
            }
        }

        this.chunks = [];
        this.recorder = recorder;
        this.stream = stream;

        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size) this.chunks.push(e.data);
        };

        try {
            recorder.start(1000);
        } catch (e) {
            stream.getTracks().forEach((track) => track.stop());
            this.recorder = null;
            this.stream = null;
            this._stopFrameLoop();
            throw new Error(I18n.t("dialog.videoFailed", "Failed to record video"));
        }
        this.state = "recording";
    }

    /* Stops the recorder and turns the collected chunks into a single blob. */
    async stop() {
        if (this.state !== "recording") return null;
        this.state = "stopping";

        const recorder = this.recorder;
        await new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve();
            };
            recorder.onstop = finish;
            recorder.onerror = finish;
            try { recorder.stop(); } catch (e) { finish(); }
            // Never leave the UI stuck if the platform skips onstop.
            setTimeout(finish, 3000);
        });

        if (this.stream) this.stream.getTracks().forEach((track) => track.stop());
        this._stopFrameLoop();

        const type = String(recorder.mimeType || "").split(";")[0] || "video/webm";
        const blob = new Blob(this.chunks, {type});

        this.chunks = [];
        this.recorder = null;
        this.stream = null;
        this.state = "idle";

        if (!blob.size) {
            throw new Error(I18n.t("dialog.videoEmpty", "Nothing was recorded"));
        }

        this.blob = blob;
        this.extension = type.indexOf("mp4") >= 0 ? ".mp4" : ".webm";
        return blob;
    }

    /* The desktop shell and the APK save through the app server: the video
     * lands in the Videos folder on a computer and in the system gallery on
     * a phone. A plain browser has no such channel and downloads it instead. */
    async export() {
        if (!this.blob) return;

        const projectPath = (this.player && this.player.projectPath) || "";
        const rawName = projectPath.split("/").filter(Boolean).pop() || "zepp";
        // Project names may contain characters Windows rejects in file names.
        const safe = rawName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "zepp";
        const fileName = `${safe}_${stamp()}${this.extension}`;

        if (!isDesktopShell() && !isAndroidApp()) {
            const url = URL.createObjectURL(this.blob);
            triggerDownload(url, fileName);
            setTimeout(() => URL.revokeObjectURL(url), 8000);
            return;
        }

        // A phone WebView usually encodes WebM, and the APK transcodes it to
        // MP4 before saving so the file opens in the system gallery.
        if (isAndroidApp() && this.extension === ".webm") {
            showToast(I18n.t("dialog.recordingProcessing", "Converting video to MP4…"), false, 8000);
        }

        try {
            const dataUrl = await blobToDataUrl(this.blob);
            const resp = await fetch("/api/save_preview", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    dataUrl,
                    name: fileName,
                    dest: "pictures",
                    projectUrl: projectPath,
                }),
            });

            let data = null;
            try {
                data = await resp.json();
            } catch (e) {}

            if (!resp.ok || !data || !data.ok) {
                throw new Error((data && data.msg) || ("HTTP " + resp.status));
            }

            const savedPath = String(data.path || "");
            if (savedPath.toLowerCase().endsWith(".webm")) {
                showToast(I18n.t("dialog.videoWebmFallback",
                    "Saved as WebM; this device could not convert it to MP4:") + " " + savedPath, true);
            } else {
                const head = isAndroidApp()
                    ? I18n.t("dialog.videoGallery", "Video saved to the gallery:")
                    : I18n.t("dialog.videoSaved", "Video saved to");
                showToast(head + " " + savedPath, false);
            }
            console.log("[ZeppPlayer] video saved:", savedPath);
        } catch (e) {
            console.error("Video export failed", e);
            showToast(I18n.t("dialog.videoFailed", "Failed to record video")
                + ": " + (e && e.message || e), true);
        }
    }
}
