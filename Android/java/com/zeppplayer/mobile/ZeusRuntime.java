package com.zeppplayer.mobile;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.Build;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Runs the real Zeus CLI on the phone.
 *
 * No JavaScript re-implementation: a genuine Node.js 26 (aarch64, upstream
 * Node built by the Termux project) is shipped as `libnode_cli.so` inside the
 * APK's native library directory, so Android extracts it at install time and
 * permits executing it on API 29+. Its shared dependencies (ICU, OpenSSL,
 * c-ares, sqlite, zlib, libffi, libc++) sit next to it, and the unmodified
 * @zeppos/zeus-cli package tree is unpacked from assets on first launch.
 *
 * Two desktop-only native pieces are supplied by the phone build:
 *   - esbuild: Termux's Android binary, selected through ESBUILD_BINARY_PATH;
 *   - sharp: pure-JavaScript compatibility layer (Android\zeus-shims\sharp).
 */
public class ZeusRuntime {
    private static final int MAX_LINES = 3000;

    private final Context context;
    private final File root;
    private final File home;
    private final File tmp;
    private final File npmCache;
    private final File projectsDir;
    private final String appVersion;

    private Process process;
    private Thread pump;
    private final List<String> lines = new ArrayList<String>();
    private String jobId = "";
    private String jobAction = "";
    private String jobProject = "";
    private String jobError = "";
    private int exitCode = -1;
    private volatile boolean running = false;
    private long startedAt = 0;

    public ZeusRuntime(Context context, File filesDir, File projectsDir, String appVersion) {
        this.context = context;
        this.root = new File(filesDir, "zeus");
        this.home = new File(filesDir, "home");
        this.tmp = new File(filesDir, "tmp");
        this.npmCache = new File(filesDir, "npm-cache");
        this.projectsDir = projectsDir;
        this.appVersion = appVersion == null ? "0" : appVersion;
    }

    // ------------------------------------------------------------- assets
    /** True when the bundled runtime has not been unpacked for this version. */
    public synchronized boolean needsInstall(String version) {
        if (!isSupportedArch()) return false;
        File stamp = new File(root, "runtime.json");
        File mark = new File(root, ".version");
        String want = version == null ? "0" : version;
        return !(stamp.isFile() && mark.isFile() && want.equals(readSmall(mark).trim()));
    }

    /** Human readable runtime size, read from the metadata written at build time. */
    public synchronized long runtimeBytes() {
        String json = readAsset("zeus-runtime.json");
        try {
            return Long.parseLong(jsonValue(json, "bytes"));
        } catch (Exception e) {
            return 0;
        }
    }

    private String readAsset(String name) {
        try {
            InputStream in = context.getAssets().open(name);
            try {
                byte[] data = new byte[(int) Math.min(in.available(), 8192)];
                int read = in.read(data);
                return new String(data, 0, Math.max(read, 0), "UTF-8");
            } finally {
                in.close();
            }
        } catch (Exception e) {
            return "";
        }
    }

    /* ---------------------------------------------------------- installer
     * The runtime is ~100 MB, so unpacking happens only when the user asks
     * for it, on a background thread, with progress exposed to the dialog. */
    public static final String IDLE = "idle";
    public static final String INSTALLING = "installing";
    public static final String DONE = "done";
    public static final String FAILED = "failed";

    private String installState = IDLE;
    private long installBytes = 0;
    private long installTotal = 0;
    private long installFiles = 0;
    private String installError = "";

    public synchronized String installProgressJson() {
        int percent = 0;
        if (installTotal > 0) percent = (int) Math.min(99, (installBytes * 100) / installTotal);
        if (DONE.equals(installState)) percent = 100;
        return Json.obj(
                "ok", "true",
                "state", Json.str(installState),
                "percent", String.valueOf(percent),
                "bytes", String.valueOf(installBytes),
                "total", String.valueOf(installTotal),
                "files", String.valueOf(installFiles),
                "error", Json.str(installError));
    }

    public synchronized boolean isInstalling() {
        return INSTALLING.equals(installState);
    }

    public synchronized void installAsync() {
        if (INSTALLING.equals(installState)) return;
        final String version = appVersion;
        installState = INSTALLING;
        installBytes = 0;
        installError = "";
        installTotal = runtimeBytes();
        installFiles = 0;

        Thread worker = new Thread(new Runnable() {
            public void run() {
                String error = null;
                try {
                    extract(version);
                } catch (Exception e) {
                    error = e.getMessage() == null ? e.toString() : e.getMessage();
                }
                synchronized (ZeusRuntime.this) {
                    if (error == null) {
                        installState = DONE;
                        installBytes = installTotal;
                    } else {
                        installState = FAILED;
                        installError = error;
                    }
                }
            }
        }, "zeus-install");
        worker.setDaemon(true);
        worker.start();
    }

    private void extract(String version) throws IOException {
        File stamp = new File(root, "runtime.json");
        File mark = new File(root, ".version");
        String want = version == null ? "0" : version;
        if (stamp.isFile() && mark.isFile() && want.equals(readSmall(mark).trim())) {
            synchronized (this) {
                installState = DONE;
                installBytes = installTotal;
            }
            return;
        }

        deleteRecursive(root);
        root.mkdirs();
        home.mkdirs();
        tmp.mkdirs();
        npmCache.mkdirs();

        AssetManager assets = context.getAssets();
        ZipInputStream zip = new ZipInputStream(assets.open("zeus-runtime.zip"));
        try {
            ZipEntry entry;
            byte[] buffer = new byte[65536];
            while ((entry = zip.getNextEntry()) != null) {
                // ZipFile.CreateFromDirectory on Windows stores backslashes,
                // which are literal characters on Linux: normalise first.
                String name = entry.getName().replace('\\', '/');
                if (name.contains("..")) continue;
                File out = new File(root, name);
                if (entry.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                OutputStream os = new FileOutputStream(out);
                try {
                    int read;
                    while ((read = zip.read(buffer)) > 0) {
                        os.write(buffer, 0, read);
                        synchronized (ZeusRuntime.this) {
                            installBytes += read;
                            if (installTotal > 0 && installBytes > installTotal) installBytes = installTotal;
                        }
                    }
                } finally {
                    os.close();
                }
                synchronized (this) {
                    installFiles++;
                }
            }
        } finally {
            zip.close();
        }

        try {
            FileOutputStream os = new FileOutputStream(mark);
            os.write(want.getBytes("UTF-8"));
            os.close();
        } catch (IOException ignored) {
        }
    }

    // ------------------------------------------------------------- info
    public boolean isSupportedArch() {
        for (String abi : Build.SUPPORTED_ABIS) {
            if ("arm64-v8a".equals(abi)) return true;
        }
        return false;
    }

    public synchronized String infoJson() {
        File stamp = new File(root, "runtime.json");
        boolean extracted = stamp.isFile();
        String nodeVersion = "";
        String zeusVersion = "";
        if (extracted) {
            String json = readSmall(stamp);
            nodeVersion = jsonValue(json, "node");
            zeusVersion = jsonValue(json, "zeus");
        }
        return Json.obj(
                "ok", "true",
                "installed", Json.str(extracted && isSupportedArch() ? "true" : "false"),
                "needsInstall", Json.str(needsInstall(appVersion) ? "true" : "false"),
                "installing", Json.str(isInstalling() ? "true" : "false"),
                "runtimeBytes", String.valueOf(runtimeBytes()),
                "appVersion", Json.str(appVersion),
                "version", Json.str(zeusVersion),
                "nodeVersion", Json.str(nodeVersion),
                "arch", Json.str(Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "unknown"),
                "supported", Json.str(isSupportedArch() ? "true" : "false"),
                "login", loginStateJson(),
                "types", "[]",
                "shapes", "[]",
                "devices", "[]");
    }

    // ------------------------------------------------------------- jobs
    public static class JobStart {
        public boolean ok;
        public String message = "";
        public String jobId = "";
        public String name = "";
        public String code = "";
    }

    public synchronized JobStart startJob(String action, List<String> args, String projectUrl, String jobName) {
        JobStart result = new JobStart();
        if (running) {
            result.message = "已有命令在运行，请先停止";
            return result;
        }
        if (!isSupportedArch()) {
            result.message = "当前设备不是 arm64，内置 Node 运行时不可用";
            return result;
        }
        File cli = new File(root, "node_modules/@zeppos/zeus-cli/bin/main.js");
        if (!cli.isFile()) {
            result.message = needsInstall(appVersion)
                    ? "请先安装 Zeus 运行时"
                    : "Zeus 运行时缺失，请重新安装";
            return result;
        }
        File cwd = resolveProject(projectUrl);
        if (cwd == null) {
            result.message = "找不到项目目录";
            return result;
        }

        List<String> cmd = new ArrayList<String>();
        cmd.add(nodePath());
        cmd.add(cli.getAbsolutePath());
        for (String arg : args) {
            if (arg != null && arg.length() > 0) cmd.add(arg);
        }

        try {
            ProcessBuilder builder = new ProcessBuilder(cmd);
            builder.directory(cwd);
            builder.redirectErrorStream(true);
            Map<String, String> env = builder.environment();
            env.put("HOME", home.getAbsolutePath());
            env.put("TMPDIR", tmp.getAbsolutePath());
            env.put("PATH", nativeDir() + ":/system/bin:/system/xbin");
            env.put("LD_LIBRARY_PATH", nativeDir());
            env.put("ESBUILD_BINARY_PATH", new File(nativeDir(), "libesbuild.so").getAbsolutePath());
            env.put("NODE_USE_SYSTEM_CA", "1");
            env.put("npm_config_cache", npmCache.getAbsolutePath());
            env.put("npm_config_prefix", new File(root, "global").getAbsolutePath());
            env.put("npm_config_update_notifier", "false");
            env.put("npm_config_fund", "false");
            env.put("NO_UPDATE_NOTIFIER", "1");
            env.put("CI", "1");

            synchronized (lines) {
                lines.clear();
            }
            jobError = "";
            exitCode = -1;
            jobAction = action;
            jobProject = cwd.getName();
            jobId = "j" + System.currentTimeMillis();
            startedAt = System.currentTimeMillis();
            process = builder.start();
            process.getOutputStream().close();
            running = true;
            startPump(process);

            result.ok = true;
            result.jobId = jobId;
            result.name = cwd.getName();
            result.message = "已启动";
        } catch (Exception e) {
            running = false;
            result.message = "启动失败: " + e.getMessage();
            append("[启动失败] " + e.getMessage());
        }
        return result;
    }

    public synchronized void stopJob(String id) {
        if (id != null && id.length() > 0 && !id.equals(jobId)) return;
        if (process != null) {
            try {
                process.destroy();
                Thread.sleep(120);
                if (process.isAlive()) process.destroyForcibly();
            } catch (Exception ignored) {
            }
        }
        running = false;
    }

    public synchronized String jobJson(String id, int from) {
        if (id == null || !id.equals(jobId)) {
            return Json.obj("ok", "false", "msg", Json.str("任务不存在"));
        }
        synchronized (lines) {
            int start = Math.max(0, Math.min(from, lines.size()));
            StringBuilder arr = new StringBuilder("[");
            for (int i = start; i < lines.size(); i++) {
                if (arr.length() > 1) arr.append(',');
                arr.append(Json.str(lines.get(i)));
            }
            arr.append(']');
            return Json.obj(
                    "ok", "true",
                    "running", Json.str(running ? "true" : "false"),
                    "code", String.valueOf(exitCode),
                    "error", Json.str(jobError),
                    "action", Json.str(jobAction),
                    "project", Json.str(jobProject),
                    "lines", arr.toString(),
                    "next", String.valueOf(lines.size()));
        }
    }

    public synchronized String statusLine() {
        if (!running) return "空闲";
        return "运行中 · " + jobAction + " · " + ((System.currentTimeMillis() - startedAt) / 1000) + "s";
    }

    // ------------------------------------------------------------- login
    private static final String PREFIX = "____user_zepp_com__";

    public synchronized String login(String cookie, String cname) {
        Map<String, String> jar = parseCookie(cookie);
        String token = first(jar, "apptoken", "app_token", "token", "access_token", "zepp_token");
        String userId = first(jar, "userid", "user_id", "uid", "user");
        String host = cname != null && cname.trim().length() > 0
                ? cname.trim() : first(jar, "cname", "api_host", "subregionalhost");
        if (token.length() == 0) {
            return Json.obj("ok", "false", "msg", Json.str("Cookie 中没有 apptoken"));
        }
        if (userId.length() == 0) {
            return Json.obj("ok", "false", "msg", Json.str("Cookie 中没有 userid"));
        }
        if (host.length() == 0) host = "api-mifit.huami.com";

        File dir = new File(home, ".zepp");
        dir.mkdirs();
        File store = new File(dir, ".zeus");
        Map<String, String> values = readStore(store);
        values.put(PREFIX + "token", token);
        values.put(PREFIX + "userid", userId);
        values.put(PREFIX + "cname", host);
        StringBuilder body = new StringBuilder();
        for (Map.Entry<String, String> e : values.entrySet()) {
            body.append(e.getKey()).append('=').append(e.getValue()).append('\n');
        }
        try {
            FileOutputStream os = new FileOutputStream(store);
            os.write(body.toString().getBytes("UTF-8"));
            os.close();
        } catch (IOException e) {
            return Json.obj("ok", "false", "msg", Json.str("写入登录状态失败: " + e.getMessage()));
        }
        return Json.obj("ok", "true", "userId", Json.str(userId), "cname", Json.str(host));
    }

    public synchronized String logout() {
        File store = new File(new File(home, ".zepp"), ".zeus");
        if (store.isFile()) store.delete();
        return Json.obj("ok", "true");
    }

    public synchronized boolean isLoggedIn() {
        Map<String, String> values = readStore(new File(new File(home, ".zepp"), ".zeus"));
        return values.containsKey(PREFIX + "token") && values.containsKey(PREFIX + "userid");
    }

    public synchronized String loginStateJson() {
        Map<String, String> values = readStore(new File(new File(home, ".zepp"), ".zeus"));
        boolean loggedIn = values.containsKey(PREFIX + "token") && values.containsKey(PREFIX + "userid");
        String userId = values.get(PREFIX + "userid");
        String host = values.get(PREFIX + "cname");
        return Json.obj(
                "loggedIn", Json.str(loggedIn ? "true" : "false"),
                "userId", Json.str(userId == null ? "" : userId),
                "cname", Json.str(host == null ? "" : host));
    }

    // ------------------------------------------------------------- helpers
    private String nodePath() {
        return new File(nativeDir(), "libnode_cli.so").getAbsolutePath();
    }

    private String nativeDir() {
        return context.getApplicationInfo().nativeLibraryDir;
    }

    private File resolveProject(String projectUrl) {
        if (projectUrl == null || projectUrl.length() == 0) return projectsDir;
        String name = projectUrl;
        int at = name.lastIndexOf('/');
        if (at >= 0) name = name.substring(at + 1);
        name = name.replace("..", "").replace("\\", "");
        File candidate = new File(projectsDir, name);
        return candidate.isDirectory() ? candidate : null;
    }

    private void startPump(final Process proc) {
        pump = new Thread(new Runnable() {
            public void run() {
                BufferedReader reader = null;
                try {
                    reader = new BufferedReader(new InputStreamReader(proc.getInputStream(), "UTF-8"));
                    String line;
                    while ((line = reader.readLine()) != null) append(line);
                } catch (IOException ignored) {
                } finally {
                    try {
                        if (reader != null) reader.close();
                    } catch (IOException ignored) {
                    }
                    try {
                        exitCode = proc.waitFor();
                    } catch (InterruptedException ignored) {
                        exitCode = -1;
                    }
                    running = false;
                    append("[进程结束，退出码 " + exitCode + "]");
                }
            }
        }, "zeus-log");
        pump.setDaemon(true);
        pump.start();
    }

    private void append(String line) {
        synchronized (lines) {
            lines.add(line);
            if (lines.size() > MAX_LINES) {
                lines.subList(0, lines.size() - MAX_LINES).clear();
            }
        }
    }

    private static void deleteRecursive(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteRecursive(child);
            }
        }
        file.delete();
    }

    private static String readSmall(File file) {
        try {
            byte[] data = new byte[(int) Math.min(file.length(), 8192)];
            java.io.FileInputStream in = new java.io.FileInputStream(file);
            try {
                int read = in.read(data);
                return new String(data, 0, Math.max(read, 0), "UTF-8");
            } finally {
                in.close();
            }
        } catch (Exception e) {
            return "";
        }
    }

    private static String jsonValue(String json, String key) {
        String needle = "\"" + key + "\"";
        int at = json.indexOf(needle);
        if (at < 0) return "";
        int colon = json.indexOf(':', at + needle.length());
        if (colon < 0) return "";
        int start = json.indexOf('"', colon + 1);
        if (start < 0) return "";
        int end = json.indexOf('"', start + 1);
        if (end < 0) return "";
        return json.substring(start + 1, end);
    }

    private static Map<String, String> readStore(File store) {
        Map<String, String> out = new HashMap<String, String>();
        if (!store.isFile()) return out;
        for (String raw : readSmall(store).split("\n")) {
            String line = raw.trim();
            if (line.length() == 0 || line.charAt(0) == '#') continue;
            int eq = line.indexOf('=');
            if (eq < 1) continue;
            out.put(line.substring(0, eq), line.substring(eq + 1));
        }
        return out;
    }

    private static Map<String, String> parseCookie(String raw) {
        Map<String, String> out = new HashMap<String, String>();
        String text = raw == null ? "" : raw.trim();
        if (text.length() == 0) return out;

        int query = text.indexOf('?');
        if (query > -1) {
            for (String part : text.substring(query + 1).split("[&;]+")) putPair(out, part);
            return out;
        }
        if (text.charAt(0) == '{') {
            for (String part : text.replaceAll("[{}\"]", "").split(",")) putPair(out, part);
            return out;
        }
        for (String part : text.split("[;\\n]+")) putPair(out, part);
        return out;
    }

    private static void putPair(Map<String, String> out, String part) {
        String item = part.trim();
        int eq = item.indexOf('=');
        if (eq < 1) return;
        String key = item.substring(0, eq).trim().toLowerCase();
        String value = item.substring(eq + 1).trim();
        if (value.length() > 1 && value.charAt(0) == '"' && value.charAt(value.length() - 1) == '"') {
            value = value.substring(1, value.length() - 1);
        }
        try {
            value = java.net.URLDecoder.decode(value, "UTF-8");
        } catch (Exception ignored) {
        }
        if (key.length() > 0) out.put(key, value);
    }

    private static String first(Map<String, String> map, String... keys) {
        for (String key : keys) {
            String value = map.get(key);
            if (value != null && value.length() > 0) return value;
        }
        return "";
    }
}
