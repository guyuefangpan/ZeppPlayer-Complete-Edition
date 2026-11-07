package com.zeppplayer.mobile;

import java.io.File;

public interface Saver {
    /* Saves a preview image or video, either into the project folder or into
     * the gallery. */
    String savePng(String name, byte[] data, File projectDir);

    /* Saves a recorded video. The APK overrides this to transcode WebM into
     * MP4 first; implementations without a transcoder just store the bytes. */
    default String saveVideo(String name, byte[] data, File projectDir) {
        return savePng(name, data, projectDir);
    }

    /* Saves a text log into the public Downloads folder. */
    String saveText(String name, String text);

    /* Copies a finished zip into the public Downloads folder. */
    String saveZip(String baseName, File zipFile);

    /* Copies a finished zip into app cache and returns its path, so the UI can
     * hand it to the system file picker for a user-chosen location. */
    String prepareZip(String baseName, File zipFile);

    /* Short user feedback from the native side. */
    void toast(String message);
}
