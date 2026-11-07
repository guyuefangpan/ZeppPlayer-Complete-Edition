package com.zeppplayer.mobile;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/* Local HTTP server used by the WebView front-end.
 *
 * The desktop build runs the same routes from electron_main.js; this is a
 * plain Java port that keeps the web bundle unchanged. It only listens on
 * loopback, so nothing is exposed to the network. */
public final class LocalServer {
    private static final int BASE_PORT = 12789;
    private static final int PORT_TRIES = 10;
    private static final long MAX_JSON_BODY = 64L * 1024 * 1024;
    private static final long MAX_UPLOAD = 256L * 1024 * 1024;

    private final Storage storage;
    private final Saver saver;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    private ServerSocket serverSocket;
    private Thread acceptThread;
    private int port = -1;
    private volatile boolean running;

    private String watchedProject;
    private long changeSeq;
    private Map<String, String> changeSnapshot = new HashMap<String, String>();

    public LocalServer(Storage storage, Saver saver) {
        this.storage = storage;
        this.saver = saver;
    }

    public int start() throws IOException {
        IOException last = null;
        for (int i = 0; i < PORT_TRIES; i++) {
            int candidate = BASE_PORT + i;
            try {
                ServerSocket ss = new ServerSocket();
                ss.setReuseAddress(true);
                ss.bind(new InetSocketAddress("127.0.0.1", candidate));
                serverSocket = ss;
                port = candidate;
                running = true;
                acceptThread = new Thread(new Runnable() {
                    public void run() { acceptLoop(); }
                }, "zp-http");
                acceptThread.setDaemon(true);
                acceptThread.start();
                return port;
            } catch (IOException e) {
                last = e;
            }
        }
        throw last != null ? last : new IOException("no free port");
    }

    public int getPort() { return port; }

    public void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {}
        pool.shutdownNow();
    }

    private void acceptLoop() {
        while (running) {
            Socket socket = null;
            try {
                socket = serverSocket.accept();
            } catch (IOException e) {
                if (!running) return;
                continue;
            }
            final Socket s = socket;
            pool.execute(new Runnable() {
                public void run() { handle(s); }
            });
        }
    }

    private void handle(Socket socket) {
        try {
            socket.setSoTimeout(60000);
            BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
            OutputStream out = new BufferedOutputStream(socket.getOutputStream());

            String requestLine = readLine(in);
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) {
                sendText(out, 400, "text/plain", "Bad request");
                return;
            }
            String method = parts[0].toUpperCase(Locale.US);
            String target = parts[1];

            Map<String, String> headers = new HashMap<String, String>();
            while (true) {
                String line = readLine(in);
                if (line == null || line.length() == 0) break;
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(Locale.US),
                            line.substring(colon + 1).trim());
                }
            }

            String rawPath = target;
            String query = "";
            int q = target.indexOf('?');
            if (q >= 0) {
                rawPath = target.substring(0, q);
                query = target.substring(q + 1);
            }
            String path = urlDecode(rawPath);
            Map<String, String> params = parseQuery(query);

            long length = 0;
            String cl = headers.get("content-length");
            if (cl != null) {
                try { length = Long.parseLong(cl); } catch (NumberFormatException ignored) {}
            }

            if (path.startsWith("/api/")) {
                handleApi(method, path, params, headers, in, length, out);
            } else if (path.startsWith("/projects")) {
                handleProjects(method, path, in, length, out);
            } else {
                serveStatic(path, out);
            }
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            try { socket.close(); } catch (IOException ignored) {}
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c == '\r') continue;
            buf.write(c);
        }
        if (c == -1 && buf.size() == 0) return null;
        return new String(buf.toByteArray(), "UTF-8");
    }

    private static String urlDecode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (Exception e) {
            return value;
        }
    }

    private static Map<String, String> parseQuery(String query) {
        Map<String, String> out = new HashMap<String, String>();
        if (query == null || query.length() == 0) return out;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq < 0) {
                out.put(urlDecode(pair), "");
            } else {
                out.put(urlDecode(pair.substring(0, eq)), urlDecode(pair.substring(eq + 1)));
            }
        }
        return out;
    }

    /* ---------------------------------------------------------------- output */

    private void sendText(OutputStream out, int status, String type, String body) throws IOException {
        sendBytes(out, status, type, body.getBytes("UTF-8"), null);
    }

    private void sendJson(OutputStream out, String json) throws IOException {
        sendBytes(out, 200, "application/json; charset=utf-8", json.getBytes("UTF-8"), null);
    }

    private void sendJson(OutputStream out, int status, String json) throws IOException {
        sendBytes(out, status, "application/json; charset=utf-8", json.getBytes("UTF-8"), null);
    }

    private void sendBytes(OutputStream out, int status, String type, byte[] body, String extra) throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        head.append("Content-Type: ").append(type).append("\r\n");
        head.append("Content-Length: ").append(body.length).append("\r\n");
        head.append("Cache-Control: no-cache\r\n");
        if (extra != null) head.append(extra);
        head.append("Connection: close\r\n\r\n");
        out.write(head.toString().getBytes("UTF-8"));
        out.write(body);
        out.flush();
    }

    private void sendFile(OutputStream out, File file, String extraHeaders, boolean cacheable) throws IOException {
        long size = file.length();
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 200 OK\r\n");
        head.append("Content-Type: ").append(mimeOf(file.getName())).append("\r\n");
        head.append("Content-Length: ").append(size).append("\r\n");
        head.append(cacheable ? "Cache-Control: max-age=86400\r\n" : "Cache-Control: no-store\r\n");
        if (extraHeaders != null) head.append(extraHeaders);
        head.append("Connection: close\r\n\r\n");
        out.write(head.toString().getBytes("UTF-8"));
        FileInputStream fis = new FileInputStream(file);
        try {
            copy(fis, out);
        } finally {
            fis.close();
        }
        out.flush();
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 411: return "Length Required";
            case 413: return "Payload Too Large";
            case 500: return "Internal Server Error";
            default: return "Error";
        }
    }

    private static String mimeOf(String name) {
        String lower = name.toLowerCase(Locale.US);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".ttf")) return "font/ttf";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".zip")) return "application/zip";
        if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private static byte[] readBody(InputStream in, long length) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        long remaining = length;
        byte[] chunk = new byte[8192];
        while (remaining > 0) {
            int want = (int) Math.min(chunk.length, remaining);
            int n = in.read(chunk, 0, want);
            if (n <= 0) break;
            buf.write(chunk, 0, n);
            remaining -= n;
        }
        return buf.toByteArray();
    }

    /* --------------------------------------------------------------- static */

    private void serveStatic(String path, OutputStream out) throws IOException {
        File web = storage.webDir();
        String rel;
        if (path.equals("/") || path.equals("/app")) {
            rel = "index.html";
        } else if (path.startsWith("/app/")) {
            rel = path.substring("/app/".length());
        } else {
            rel = path.startsWith("/") ? path.substring(1) : path;
        }
        if (rel.contains("..")) {
            sendText(out, 403, "text/plain", "Forbidden");
            return;
        }
        File file = new File(web, rel);
        if (!file.exists() || file.isDirectory()) {
            sendText(out, 404, "text/plain", "Not found");
            return;
        }
        // Nothing is cacheable: the files live on local storage, so re-reading
        // them is free, and a stale WebView cache is what made an updated APK
        // keep running the previous (broken) bundle.
        sendFile(out, file, null, false);
    }

    /* ------------------------------------------------------------- projects */

    private void handleProjects(String method, String path, InputStream in, long length, OutputStream out)
            throws IOException {
        String rel = path.substring("/projects".length());
        if (rel.startsWith("/")) rel = rel.substring(1);
        rel = rel.replace('\\', '/');
        File projects = storage.projectsDir();
        File target = resolveInside(projects, rel);
        if (target == null) {
            sendText(out, 403, "text/plain", "Forbidden");
            return;
        }

        if ("PUT".equals(method)) {
            if (length <= 0) {
                sendText(out, 411, "text/plain", "Length required");
                return;
            }
            File parent = target.getParentFile();
            if (parent != null) parent.mkdirs();
            FileOutputStream fos = new FileOutputStream(target);
            try {
                long remaining = length;
                byte[] buf = new byte[8192];
                while (remaining > 0) {
                    int want = (int) Math.min(buf.length, remaining);
                    int n = in.read(buf, 0, want);
                    if (n <= 0) break;
                    fos.write(buf, 0, n);
                    remaining -= n;
                }
            } finally {
                fos.close();
            }
            sendText(out, 200, "text/plain", "");
            return;
        }

        if (!target.exists()) {
            sendText(out, 404, "text/plain", "Not found");
            return;
        }

        if (target.isDirectory()) {
            File[] children = target.listFiles();
            StringBuilder html = new StringBuilder("<!DOCTYPE html><html><body>");
            if (children != null) {
                for (File child : children) {
                    String name = child.getName();
                    String suffix = child.isDirectory() ? "/" : "";
                    String esc = escapeHtml(name);
                    html.append("<a href=\"").append(esc).append(suffix).append("\">")
                            .append(esc).append(suffix).append("</a>\n");
                }
            }
            html.append("</body></html>");
            sendText(out, 200, "text/html; charset=utf-8", html.toString());
            return;
        }

        sendFile(out, target, null, false);
    }

    /* ----------------------------------------------------------------- api */

    private void handleApi(String method, String path, Map<String, String> params,
                           Map<String, String> headers, InputStream in, long length, OutputStream out)
            throws IOException {

        if (path.equals("/api/list_projects")) {
            boolean preferBuild = "true".equals(params.get("preferBuildDir"));
            sendJson(out, listProjectsJson(preferBuild));
            return;
        }

        if (path.equals("/api/open_projects")) {
            File dir = storage.projectsDir();
            dir.mkdirs();
            saver.toast("项目目录：" + dir.getAbsolutePath());
            sendJson(out, Json.obj("ok", "true", "path", Json.str(dir.getAbsolutePath())));
            return;
        }

        if (path.equals("/api/import_project")) {
            sendJson(out, "{\"ok\":false,\"cancelled\":true}");
            return;
        }

        if (path.equals("/api/choose_projects_dir")) {
            sendJson(out, "{\"ok\":false,\"msg\":\"Android 版使用应用内项目目录\"}");
            return;
        }

        if (path.equals("/api/save_preview")) {
            if (!"POST".equals(method)) {
                sendText(out, 405, "text/plain", "Method not allowed");
                return;
            }
            if (length <= 0 || length > MAX_JSON_BODY) {
                sendJson(out, 413, "{\"ok\":false,\"msg\":\"媒体数据过大\"}");
                return;
            }
            byte[] raw = readBody(in, length);
            Map<String, String> body = Json.parseObject(new String(raw, "UTF-8"));
            String dataUrl = body.get("dataUrl");
            String marker = "base64,";
            int at = dataUrl == null ? -1 : dataUrl.indexOf(marker);
            if (at < 0) {
                sendJson(out, 400, "{\"ok\":false,\"msg\":\"无效的媒体数据\"}");
                return;
            }
            byte[] png;
            try {
                png = decodeBase64(dataUrl.substring(at + marker.length()));
            } catch (Exception e) {
                sendJson(out, 400, "{\"ok\":false,\"msg\":\"无效的媒体数据\"}");
                return;
            }
            String name = sanitizeName(body.get("name"), ".png");
            if (name.length() == 0) name = "preview_" + System.currentTimeMillis() + ".png";
            File projectDir = null;
            if ("project".equals(body.get("dest"))) {
                projectDir = resolveProject(body.get("projectUrl"));
            }
            String lower = name.toLowerCase();
            boolean video = lower.endsWith(".mp4") || lower.endsWith(".webm");
            try {
                String saved = video
                        ? saver.saveVideo(name, png, projectDir)
                        : saver.savePng(name, png, projectDir);
                if (saved == null) {
                    sendJson(out, 500, Json.obj("ok", "false", "msg", Json.str("视频转码为 MP4 失败")));
                    return;
                }
                sendJson(out, Json.obj("ok", "true", "path", Json.str(saved)));
            } catch (Exception e) {
                sendJson(out, 500, Json.obj("ok", "false", "msg", Json.str(String.valueOf(e.getMessage()))));
            }
            return;
        }

        if (path.equals("/api/save_text")) {
            if (!"POST".equals(method)) {
                sendText(out, 405, "text/plain", "Method not allowed");
                return;
            }
            if (length <= 0 || length > MAX_JSON_BODY) {
                sendJson(out, 413, "{\"ok\":false,\"msg\":\"请求体过大\"}");
                return;
            }
            Map<String, String> body = Json.parseObject(new String(readBody(in, length), "UTF-8"));
            String name = sanitizeName(body.get("name"), ".log");
            if (name.length() == 0) name = "log_" + System.currentTimeMillis() + ".log";
            String text = body.get("text");
            try {
                String saved = saver.saveText(name, text == null ? "" : text);
                sendJson(out, Json.obj("ok", "true", "path", Json.str(saved)));
            } catch (Exception e) {
                sendJson(out, 500, Json.obj("ok", "false", "msg", Json.str(String.valueOf(e.getMessage()))));
            }
            return;
        }

        if (path.equals("/api/export_project")) {
            if (!"POST".equals(method)) {
                sendText(out, 405, "text/plain", "Method not allowed");
                return;
            }
            if (length <= 0 || length > MAX_JSON_BODY) {
                sendJson(out, 413, "{\"ok\":false,\"msg\":\"请求体过大\"}");
                return;
            }
            Map<String, String> body = Json.parseObject(new String(readBody(in, length), "UTF-8"));
            File dir = resolveProject(body.get("projectUrl"));
            if (dir == null) {
                sendJson(out, 404, "{\"ok\":false,\"msg\":\"找不到项目目录\"}");
                return;
            }
            File tmp = null;
            try {
                tmp = File.createTempFile("zp_export", ".zip");
                zipProject(dir, tmp);
                if ("ask".equals(body.get("dest"))) {
                    // The phone lets the user pick the destination through the
                    // system file picker, so the zip waits in app cache.
                    String cached = saver.prepareZip(dir.getName(), tmp);
                    sendJson(out, Json.obj("ok", "true", "cachePath", Json.str(cached),
                            "name", Json.str(dir.getName() + ".zip")));
                } else {
                    String saved = saver.saveZip(dir.getName(), tmp);
                    sendJson(out, Json.obj("ok", "true", "path", Json.str(saved)));
                }
            } catch (Exception e) {
                sendJson(out, 500, Json.obj("ok", "false", "msg", Json.str("打包失败：" + e.getMessage())));
            } finally {
                if (tmp != null) tmp.delete();
            }
            return;
        }

        if (path.equals("/api/import_path")) {
            sendJson(out, "{\"ok\":false,\"msg\":\"Android 版请使用 ZIP 导入\"}");
            return;
        }

        if (path.equals("/api/import_zip_upload")) {
            if (!"POST".equals(method)) {
                sendText(out, 405, "text/plain", "Method not allowed");
                return;
            }
            if (length <= 0) {
                sendText(out, 411, "text/plain", "Length required");
                return;
            }
            if (length > MAX_UPLOAD) {
                sendJson(out, 413, "{\"ok\":false,\"msg\":\"压缩包过大\"}");
                return;
            }
            String displayBase = "";
            String headerName = headers.get("x-file-name");
            if (headerName != null) {
                displayBase = urlDecode(headerName);
                if (displayBase.toLowerCase(Locale.US).endsWith(".zip")) {
                    displayBase = displayBase.substring(0, displayBase.length() - 4);
                }
            }
            File tmpZip = null;
            try {
                tmpZip = File.createTempFile("zp_upload", ".zip");
                FileOutputStream fos = new FileOutputStream(tmpZip);
                try {
                    long remaining = length;
                    byte[] buf = new byte[8192];
                    while (remaining > 0) {
                        int want = (int) Math.min(buf.length, remaining);
                        int n = in.read(buf, 0, want);
                        if (n <= 0) break;
                        fos.write(buf, 0, n);
                        remaining -= n;
                    }
                } finally {
                    fos.close();
                }
                String result = importZip(tmpZip, displayBase);
                sendJson(out, result);
            } catch (Exception e) {
                sendJson(out, 500, Json.obj("ok", "false", "msg", Json.str(String.valueOf(e.getMessage()))));
            } finally {
                if (tmpZip != null) tmpZip.delete();
            }
            return;
        }

        if (path.equals("/api/delete_project")) {
            if (!"POST".equals(method)) {
                sendText(out, 405, "text/plain", "Method not allowed");
                return;
            }
            if (length <= 0 || length > MAX_JSON_BODY) {
                sendJson(out, 413, "{\"ok\":false,\"msg\":\"请求体过大\"}");
                return;
            }
            Map<String, String> body = Json.parseObject(new String(readBody(in, length), "UTF-8"));
            File dir = resolveProject(body.get("projectUrl"));
            if (dir == null) {
                sendJson(out, 404, "{\"ok\":false,\"msg\":\"找不到项目目录\"}");
                return;
            }
            // The change watcher polls the tree by path; drop it so a deleted
            // project cannot keep reporting phantom changes.
            if (dir.getName().equals(watchedProject)) {
                watchedProject = null;
                changeSnapshot = null;
            }
            try {
                deleteTree(dir);
                sendJson(out, "{\"ok\":true}");
            } catch (Exception e) {
                sendJson(out, 500, Json.obj("ok", "false", "msg", Json.str(String.valueOf(e.getMessage()))));
            }
            return;
        }

        if (path.equals("/api/download_project")) {
            File dir = resolveProject(params.get("projectUrl"));
            if (dir == null) {
                sendJson(out, 404, "{\"ok\":false,\"msg\":\"找不到项目目录\"}");
                return;
            }
            File tmp = null;
            try {
                tmp = File.createTempFile("zp_download", ".zip");
                zipProject(dir, tmp);
                String ascii = dir.getName().replaceAll("[^\\x20-\\x7e]", "_").replaceAll("[\"\\\\]", "_");
                String disposition = "Content-Disposition: attachment; filename=\"" + ascii
                        + ".zip\"; filename*=UTF-8''" + encodeURIComponent(dir.getName()) + ".zip\r\n";
                sendFile(out, tmp, disposition, false);
            } finally {
                if (tmp != null) tmp.delete();
            }
            return;
        }

        if (path.equals("/api/server_info")) {
            sendJson(out, Json.obj(
                    "ok", "true",
                    "port", String.valueOf(port),
                    "desktop", "false",
                    "mobile", "true",
                    "urls", "[]"));
            return;
        }

        if (path.equals("/api/change_count")) {
            refreshChanges();
            sendText(out, 200, "text/plain", String.valueOf(changeSeq));
            return;
        }

        if (path.startsWith("/api/watch/")) {
            String name = urlDecode(path.substring("/api/watch/".length()));
            setWatchedProject(name);
            sendText(out, 200, "text/plain", String.valueOf(changeSeq));
            return;
        }

        if (path.startsWith("/api/folder_chooser")) {
            sendJson(out, "{\"current_path\":\"\",\"contents\":[]}");
            return;
        }

        if (path.startsWith("/api/set_projects_dir")) {
            sendJson(out, "{\"ok\":false,\"msg\":\"Android 版项目目录由应用管理\"}");
            return;
        }

        sendText(out, 404, "text/plain", "Not found");
    }

    /* ------------------------------------------------------------- projects */

    private String listProjectsJson(boolean preferBuild) {
        File dir = storage.projectsDir();
        List<File> items = new ArrayList<File>();
        File[] children = dir.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory() && new File(child, "app.json").isFile()) items.add(child);
            }
        }
        Collections.sort(items, new Comparator<File>() {
            public int compare(File a, File b) { return a.getName().compareTo(b.getName()); }
        });
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) sb.append(',');
            File item = items.get(i);
            String url = "/projects/" + item.getName();
            if (preferBuild && new File(item, "build/app.json").isFile()) url += "/build";
            sb.append(Json.obj("title", Json.str(item.getName()), "url", Json.str(url)));
        }
        return sb.append(']').toString();
    }

    private File resolveProject(String projectUrl) {
        String rel = projectUrl == null ? "" : projectUrl;
        if (rel.startsWith("/projects/")) rel = rel.substring("/projects/".length());
        else if (rel.startsWith("/projects")) rel = rel.substring("/projects".length());
        rel = rel.replace('\\', '/');
        if (rel.startsWith("/")) rel = rel.substring(1);
        int q = rel.indexOf('?');
        if (q >= 0) rel = rel.substring(0, q);
        if (rel.length() == 0) return null;
        String root = rel.split("/")[0];
        File dir = new File(storage.projectsDir(), root);
        return dir.isDirectory() ? dir : null;
    }

    private static File resolveInside(File root, String rel) {
        File target = root;
        if (rel.length() > 0) {
            for (String part : rel.split("/")) {
                if (part.length() == 0) continue;
                target = new File(target, part);
            }
        }
        String rootPath = root.getAbsolutePath();
        String targetPath = target.getAbsolutePath();
        if (!targetPath.equals(rootPath) && !targetPath.startsWith(rootPath + File.separator)) return null;
        return target;
    }

    private String importZip(File zip, String displayBase) throws IOException {
        File projects = storage.projectsDir();
        projects.mkdirs();
        File tmp = new File(projects, ".__import_tmp_" + System.nanoTime());
        tmp.mkdirs();
        try {
            unzip(zip, tmp);
            File root = findProjectRoot(tmp);
            if (root == null) {
                return Json.obj("ok", "false", "msg", Json.str("压缩包中没有找到 app.json"));
            }
            boolean atRoot = root.getAbsolutePath().equals(tmp.getAbsolutePath());
            String base = atRoot ? displayBase : root.getName();
            if (base == null || base.trim().length() == 0) base = "project";
            String unique = uniqueName(projects, base);
            File dest = new File(projects, unique);
            if (atRoot) {
                if (!tmp.renameTo(dest)) {
                    copyTree(tmp, dest);
                }
            } else {
                copyTree(root, dest);
            }
            return Json.obj("ok", "true", "name", Json.str(dest.getName()), "path", Json.str(dest.getAbsolutePath()));
        } finally {
            if (tmp.exists()) deleteTree(tmp);
        }
    }

    private static File findProjectRoot(File dir) {
        if (new File(dir, "app.json").isFile()) return dir;
        File[] children = dir.listFiles();
        File found = null;
        int count = 0;
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory() && new File(child, "app.json").isFile()) {
                    found = child;
                    count++;
                }
            }
        }
        return count == 1 ? found : null;
    }

    private static String uniqueName(File dir, String base) {
        String candidate = base;
        int i = 1;
        while (new File(dir, candidate).exists()) {
            candidate = base + " (" + (i++) + ")";
        }
        return candidate;
    }

    private static void unzip(File zip, File dest) throws IOException {
        ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)));
        try {
            byte[] buf = new byte[8192];
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                String name = entry.getName().replace('\\', '/');
                while (name.startsWith("/")) name = name.substring(1);
                if (name.contains("..")) continue;
                File out = new File(dest, name);
                if (entry.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                FileOutputStream fos = new FileOutputStream(out);
                try {
                    int n;
                    while ((n = zis.read(buf)) > 0) fos.write(buf, 0, n);
                } finally {
                    fos.close();
                }
            }
        } finally {
            zis.close();
        }
    }

    private static void zipProject(File dir, File out) throws IOException {
        ZipOutputStream zos = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(out)));
        try {
            addToZip(dir, dir.getName(), zos);
        } finally {
            zos.close();
        }
    }

    private static void addToZip(File file, String prefix, ZipOutputStream zos) throws IOException {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) return;
            for (File child : children) {
                addToZip(child, prefix + "/" + child.getName(), zos);
            }
            return;
        }
        zos.putNextEntry(new ZipEntry(prefix));
        FileInputStream fis = new FileInputStream(file);
        try {
            copy(fis, zos);
        } finally {
            fis.close();
        }
        zos.closeEntry();
    }

    private static void copyTree(File src, File dest) throws IOException {
        if (src.isDirectory()) {
            dest.mkdirs();
            File[] children = src.listFiles();
            if (children == null) return;
            for (File child : children) {
                copyTree(child, new File(dest, child.getName()));
            }
            return;
        }
        File parent = dest.getParentFile();
        if (parent != null) parent.mkdirs();
        FileInputStream fis = new FileInputStream(src);
        FileOutputStream fos = new FileOutputStream(dest);
        try {
            copy(fis, fos);
        } finally {
            fis.close();
            fos.close();
        }
    }

    private static void deleteTree(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteTree(child);
            }
        }
        file.delete();
    }

    /* ------------------------------------------------------------- watchers */

    private void setWatchedProject(String name) {
        watchedProject = name;
        changeSnapshot = snapshotOf(name);
    }

    private void refreshChanges() {
        if (watchedProject == null) return;
        Map<String, String> now = snapshotOf(watchedProject);
        if (!now.equals(changeSnapshot)) {
            changeSnapshot = now;
            changeSeq++;
        }
    }

    private Map<String, String> snapshotOf(String name) {
        Map<String, String> out = new HashMap<String, String>();
        File dir = resolveProject("/projects/" + name);
        if (dir != null) walk(dir, "", out);
        return out;
    }

    private static void walk(File dir, String prefix, Map<String, String> out) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            String rel = prefix.length() == 0 ? child.getName() : prefix + "/" + child.getName();
            if (child.isDirectory()) {
                walk(child, rel, out);
            } else {
                out.put(rel, child.lastModified() + ":" + child.length());
            }
        }
    }

    /* --------------------------------------------------------------- utils */

    private static String sanitizeName(String name, String fallbackExt) {
        if (name == null) return "";
        String base = name;
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[<>:\"/\\\\|?*\\x00-\\x1f]", "_").trim();
        if (base.length() == 0) return "";
        if (base.contains(".")) return base;
        return base + fallbackExt;
    }

    private static String escapeHtml(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private static String encodeURIComponent(String value) throws IOException {
        return java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20");
    }

    private static byte[] decodeBase64(String input) {
        String s = input.replaceAll("[^A-Za-z0-9+/=]", "");
        int len = s.length();
        if (len % 4 != 0) throw new IllegalArgumentException("bad base64");
        int pad = 0;
        if (len >= 2 && s.charAt(len - 1) == '=') pad++;
        if (len >= 2 && s.charAt(len - 2) == '=') pad++;
        byte[] out = new byte[len / 4 * 3 - pad];
        int o = 0;
        for (int i = 0; i < len; i += 4) {
            int a = b64(s.charAt(i));
            int b = b64(s.charAt(i + 1));
            int c = b64(s.charAt(i + 2));
            int d = b64(s.charAt(i + 3));
            int triple = (a << 18) | (b << 12) | (c << 6) | d;
            if (o < out.length) out[o++] = (byte) (triple >> 16);
            if (o < out.length) out[o++] = (byte) (triple >> 8);
            if (o < out.length) out[o++] = (byte) triple;
        }
        return out;
    }

    private static int b64(char c) {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return 0;
    }
}
