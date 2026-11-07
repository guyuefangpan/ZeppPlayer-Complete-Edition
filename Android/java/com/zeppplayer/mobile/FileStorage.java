package com.zeppplayer.mobile;

import java.io.File;

public class FileStorage implements Storage {
    private final File projects;
    private final File web;

    public FileStorage(File projects, File web) {
        this.projects = projects;
        this.web = web;
    }

    public File projectsDir() { return projects; }
    public File webDir() { return web; }
}
