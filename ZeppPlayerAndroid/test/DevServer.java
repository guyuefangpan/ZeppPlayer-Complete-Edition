package com.zeppplayer.mobile;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;

/* Runs the exact LocalServer + web assets used inside the APK on the desktop
 * JVM so the front-end can be opened in a normal browser for debugging. */
public final class DevServer {
    public static void main(String[] args) throws Exception {
        File web = new File(args[0]);
        File projects = new File(args[1]);
        File saved = new File(args[2]);
        projects.mkdirs();
        saved.mkdirs();

        LocalServer server = new LocalServer(new FileStorage(projects, web), new Saver() {
            public String savePng(String name, byte[] data, File projectDir) {
                try {
                    File out = new File(saved, name);
                    FileOutputStream fos = new FileOutputStream(out);
                    fos.write(data);
                    fos.close();
                    return out.getAbsolutePath();
                } catch (Exception e) {
                    return name;
                }
            }

            public String saveText(String name, String text) {
                try {
                    File out = new File(saved, name);
                    FileOutputStream fos = new FileOutputStream(out);
                    fos.write(text.getBytes("UTF-8"));
                    fos.close();
                    return out.getAbsolutePath();
                } catch (Exception e) {
                    return name;
                }
            }

            public String saveZip(String baseName, File zipFile) {
                try {
                    File out = new File(saved, baseName + ".zip");
                    FileInputStream is = new FileInputStream(zipFile);
                    FileOutputStream os = new FileOutputStream(out);
                    try {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
                    } finally {
                        is.close();
                        os.close();
                    }
                    return out.getAbsolutePath();
                } catch (Exception e) {
                    return baseName + ".zip";
                }
            }

            public String prepareZip(String baseName, File zipFile) {
                return saveZip(baseName, zipFile);
            }

            public void toast(String message) {
                System.out.println("TOAST " + message);
            }
        });

        int port = server.start();
        System.out.println("DEVPORT=" + port);
        System.out.flush();
        Thread.sleep(Long.MAX_VALUE);
    }
}
