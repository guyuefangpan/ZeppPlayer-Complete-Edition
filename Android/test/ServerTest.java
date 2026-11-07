package com.zeppplayer.mobile;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/* JVM smoke test for the HTTP layer that ships inside the APK. It runs the
 * exact same LocalServer code against a real web folder and a temp projects
 * folder, so routing, project IO, zip import/export and change tracking are
 * exercised without an Android device. */
public final class ServerTest {
    private static int failures = 0;
    private static int checks = 0;
    private static FakeSaver saver;
    private static File projectsDir;

    public static void main(String[] args) throws Exception {
        File assetsWeb = new File(args[0]);
        File work = new File(args[1]);
        projectsDir = new File(work, "projects");
        if (!projectsDir.exists()) projectsDir.mkdirs();

        File demo = new File(projectsDir, "demo");
        if (!demo.exists()) copyTree(new File(assetsWeb, "projects/demo"), demo);

        saver = new FakeSaver(new File(work, "saved"));
        LocalServer server = new LocalServer(new FileStorage(projectsDir, assetsWeb), saver);
        int port = server.start();
        String base = "http://127.0.0.1:" + port;

        check("GET / returns html", get(base + "/").status == 200
                && get(base + "/").body.contains("<title>ZeppPlayer</title>"));
        check("GET /app/index.browser.js", get(base + "/app/index.browser.js").status == 200
                && get(base + "/app/index.browser.js").body.length() > 100000);
        check("GET /app/allfont-Medium.ttf", get(base + "/app/allfont-Medium.ttf").status == 200
                && get(base + "/app/allfont-Medium.ttf").bytes.length > 1000000);
        check("GET /package.json", get(base + "/package.json").status == 200
                && get(base + "/package.json").body.contains("\"name\":\"zeppplayer\""));
        check("GET /api/server_info", get(base + "/api/server_info").status == 200
                && get(base + "/api/server_info").body.contains("\"mobile\":true"));
        dump("server_info", get(base + "/api/server_info"));
        check("GET /api/list_projects", get(base + "/api/list_projects").status == 200
                && get(base + "/api/list_projects").body.contains("\"title\":\"demo\""));
        check("GET /projects/demo/app.json", get(base + "/projects/demo/app.json").status == 200
                && get(base + "/projects/demo/app.json").body.length() > 0);
        check("GET /projects/demo (dir listing)", get(base + "/projects/demo/").status == 200
                && get(base + "/projects/demo/").body.contains("<a href=\"app.json\">"));
        check("GET missing file is 404", get(base + "/app/nope.js").status == 404);

        Result put = request("PUT", base + "/projects/demo/test_write.txt", "hello android".getBytes("UTF-8"), null);
        check("PUT /projects file", put.status == 200);
        check("GET written file", get(base + "/projects/demo/test_write.txt").body.contains("hello android"));

        // change tracking: register the project, mutate a file, expect a bump
        get(base + "/api/watch/demo");
        String before = get(base + "/api/change_count").body.trim();
        FileOutputStream fos = new FileOutputStream(new File(projectsDir, "demo/test_write.txt"));
        fos.write("changed".getBytes("UTF-8"));
        fos.close();
        Thread.sleep(20);
        String after = get(base + "/api/change_count").body.trim();
        check("change_count bumps on file change", before.equals("0") && after.equals("1"));

        String png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        String previewBody = "{\"dataUrl\":\"data:image/png;base64," + png1x1
                + "\",\"name\":\"shot.png\",\"dest\":\"pictures\",\"projectUrl\":\"/projects/demo\"}";
        Result preview = request("POST", base + "/api/save_preview", previewBody.getBytes("UTF-8"), "application/json");
        check("POST /api/save_preview", preview.status == 200 && preview.body.contains("\"ok\":true")
                && saver.lastPng != null && saver.lastPng.length > 0);
        dump("save_preview", preview);

        String logBody = "{\"text\":\"console line\\nsecond\",\"name\":\"console.log\"}";
        Result log = request("POST", base + "/api/save_text", logBody.getBytes("UTF-8"), "application/json");
        check("POST /api/save_text", log.status == 200 && log.body.contains("\"ok\":true")
                && saver.lastText != null && saver.lastText.contains("console line"));
        dump("save_text", log);

        Result export = request("POST", base + "/api/export_project",
                "{\"projectUrl\":\"/projects/demo\"}".getBytes("UTF-8"), "application/json");
        check("POST /api/export_project", export.status == 200 && export.body.contains("\"ok\":true"));
        dump("export_project", export);
        check("exported zip has app.json", saver.lastZip != null && zipHas(saver.lastZip, "demo/app.json"));

        Result download = get(base + "/api/download_project?projectUrl=/projects/demo");
        check("GET /api/download_project streams zip", download.status == 200
                && download.contentType != null && download.contentType.contains("application/zip")
                && download.bytes.length > 1000 && download.bytes[0] == 'P' && download.bytes[1] == 'K');

        File uploadZip = new File(work, "upload.zip");
        zipDir(new File(assetsWeb, "projects/demo"), uploadZip);
        byte[] zipBytes = readAll(uploadZip);
        Result upload = request("POST", base + "/api/import_zip_upload", zipBytes, "application/zip",
                "X-File-Name: my-demo.zip");
        check("POST /api/import_zip_upload", upload.status == 200 && upload.body.contains("\"ok\":true"));
        dump("import_zip_upload", upload);
        check("imported project appears", get(base + "/api/list_projects").body.contains("demo (1)"));

        File nestedZip = new File(work, "nested.zip");
        zipNested(new File(assetsWeb, "projects/demo"), nestedZip);
        Result nested = request("POST", base + "/api/import_zip_upload", readAll(nestedZip), "application/zip",
                "X-File-Name: wrapped.zip");
        check("import zip with wrapper folder", nested.status == 200 && nested.body.contains("\"ok\":true"));
        dump("import_nested", nested);

        server.stop();

        System.out.println();
        System.out.println("CHECKS: " + checks + ", FAILURES: " + failures);
        if (failures > 0) System.exit(1);
    }

    private static void check(String name, boolean ok) {
        checks++;
        if (ok) {
            System.out.println("PASS " + name);
        } else {
            failures++;
            System.out.println("FAIL " + name);
        }
    }

    private static void dump(String name, Result r) {
        String body = r.body == null ? "" : r.body;
        if (body.length() > 300) body = body.substring(0, 300) + "...";
        System.out.println("DEBUG " + name + " status=" + r.status + " body=" + body);
    }

    private static Result get(String url) throws Exception {
        return request("GET", url, null, null);
    }

    private static Result request(String method, String url, byte[] body, String type) throws Exception {
        return request(method, url, body, type, null);
    }

    private static Result request(String method, String url, byte[] body, String type, String extraHeader)
            throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(5000);
        conn.setReadTimeout(15000);
        if (type != null) conn.setRequestProperty("Content-Type", type);
        if (extraHeader != null) {
            int colon = extraHeader.indexOf(':');
            conn.setRequestProperty(extraHeader.substring(0, colon).trim(), extraHeader.substring(colon + 1).trim());
        }
        if (body != null) {
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(body.length);
            OutputStream os = conn.getOutputStream();
            os.write(body);
            os.close();
        }
        Result r = new Result();
        r.status = conn.getResponseCode();
        r.contentType = conn.getContentType();
        InputStream in = r.status >= 400 ? conn.getErrorStream() : conn.getInputStream();
        r.bytes = in == null ? new byte[0] : readAll(in);
        r.body = new String(r.bytes, "UTF-8");
        conn.disconnect();
        return r;
    }

    private static final class Result {
        int status;
        String body;
        String contentType;
        byte[] bytes;
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }

    private static byte[] readAll(File f) throws Exception {
        return readAll(new FileInputStream(f));
    }

    private static boolean zipHas(File zip, String entryName) throws Exception {
        ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)));
        try {
            ZipEntry e;
            while ((e = zis.getNextEntry()) != null) {
                if (e.getName().equals(entryName)) return true;
            }
        } finally {
            zis.close();
        }
        return false;
    }

    private static void zipDir(File dir, File out) throws Exception {
        ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(out));
        try {
            add(dir, dir.getName(), zos);
        } finally {
            zos.close();
        }
    }

    private static void zipNested(File dir, File out) throws Exception {
        ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(out));
        try {
            add(dir, "wrapper", zos);
        } finally {
            zos.close();
        }
    }

    private static void add(File file, String name, ZipOutputStream zos) throws Exception {
        if (file.isDirectory()) {
            File[] kids = file.listFiles();
            if (kids == null) return;
            for (File kid : kids) add(kid, name + "/" + kid.getName(), zos);
            return;
        }
        zos.putNextEntry(new ZipEntry(name));
        FileInputStream in = new FileInputStream(file);
        try {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) zos.write(buf, 0, n);
        } finally {
            in.close();
        }
        zos.closeEntry();
    }

    private static void copyTree(File src, File dest) throws Exception {
        if (src.isDirectory()) {
            dest.mkdirs();
            File[] kids = src.listFiles();
            if (kids == null) return;
            for (File kid : kids) copyTree(kid, new File(dest, kid.getName()));
            return;
        }
        File parent = dest.getParentFile();
        if (parent != null) parent.mkdirs();
        FileInputStream in = new FileInputStream(src);
        FileOutputStream out = new FileOutputStream(dest);
        try {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            in.close();
            out.close();
        }
    }

    private static final class FakeSaver implements Saver {
        private final File dir;
        byte[] lastPng;
        String lastText;
        File lastZip;

        FakeSaver(File dir) {
            this.dir = dir;
            dir.mkdirs();
        }

        public String savePng(String name, byte[] data, File projectDir) {
            lastPng = data;
            try {
                File out = new File(dir, name);
                FileOutputStream fos = new FileOutputStream(out);
                fos.write(data);
                fos.close();
                return out.getAbsolutePath();
            } catch (Exception e) {
                return name;
            }
        }

        public String saveText(String name, String text) {
            lastText = text;
            return name;
        }

        public String prepareZip(String baseName, File zipFile) {
            return saveZip(baseName, zipFile);
        }

        public String saveZip(String baseName, File zipFile) {
            try {
                File out = new File(dir, baseName + ".zip");
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
                lastZip = out;
                return out.getAbsolutePath();
            } catch (Exception e) {
                lastZip = null;
                return baseName + ".zip";
            }
        }

        public void toast(String message) {
            System.out.println("TOAST " + message);
        }
    }
}
