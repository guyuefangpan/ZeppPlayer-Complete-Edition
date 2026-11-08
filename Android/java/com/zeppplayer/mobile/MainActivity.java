package com.zeppplayer.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/* Thin native shell: a WebView over a loopback HTTP server, exactly like the
 * desktop build, so the simulator engine keeps running as plain web code. */
public class MainActivity extends Activity {
    private static final int REQ_PICK_FILE = 42;
    private static final int REQ_CREATE_DOC = 43;
    private static final int REQ_WRITE_PERM = 44;

    private WebView webView;
    private volatile LocalServer server;
    private ValueCallback<Uri[]> pendingFileCallback;
    private String pendingExportPath;
    private String pendingExportName;
    private String pendingExportRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFF101010);
        getWindow().setNavigationBarColor(0xFF101010);

        final File webDir = new File(getFilesDir(), "web");
        final File projectsDir = new File(getFilesDir(), "projects");

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF101010);

        webView = new WebView(this);
        WebView.setWebContentsDebuggingEnabled(true);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(false);
        // Honour the page's viewport meta. Without this the WebView lays the
        // page out at a desktop-like width, so every phone rule stays inactive
        // and the UI turns into a horizontally pannable desktop window.
        settings.setUseWideViewPort(true);
        settings.setTextZoom(100);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.setBackgroundColor(0xFF101010);
        // A reinstall must never be shadowed by content cached by the previous
        // version, which is how a fixed bundle kept showing an old error.
        webView.clearCache(true);
        webView.addJavascriptInterface(new Bridge(projectsDir), "zpAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url != null && url.startsWith("http://127.0.0.1:")) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {}
                return true;
            }

            /* Offline guarantee: everything this app needs comes from the
             * loopback server. Any request to another host is answered with an
             * empty body, so the app itself can never reach the internet. */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri == null ? null : uri.getScheme();
                String host = uri == null ? null : uri.getHost();
                if (scheme != null && ("http".equals(scheme) || "https".equals(scheme))) {
                    if (host == null || !"127.0.0.1".equals(host)) {
                        return new WebResourceResponse("text/plain", "utf-8",
                                new ByteArrayInputStream(new byte[0]));
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                android.util.Log.i("ZeppPlayerWeb", message.message() + " (" + message.sourceId()
                        + ":" + message.lineNumber() + ")");
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择 ZIP 项目包"), REQ_PICK_FILE);
                } catch (Exception e) {
                    pendingFileCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });
        webView.setDownloadListener(new DownloadListener() {
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                // Exports are written by the native saver; nothing to do here.
            }
        });

        final TextView status = new TextView(this);
        status.setText("正在准备 ZeppPlayer…");
        status.setTextColor(0xFFEEEEEE);
        status.setTextSize(16);
        status.setGravity(Gravity.CENTER);

        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(status, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        setContentView(root);

        // Android 9 and below need a runtime grant before screenshots can be
        // written into the public Pictures folder.
        if (Build.VERSION.SDK_INT >= 23 && Build.VERSION.SDK_INT < 29
                && checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE},
                    REQ_WRITE_PERM);
        }

        // Unpacking the font and the demo project can take a few seconds on
        // slow flash, so it must not block the UI thread.
        final String webVersion = appVersionName();
        new Thread(new Runnable() {
            public void run() {
                try {
                    extractWebAssets(webDir, webVersion);
                    seedProjects(webDir, projectsDir);
                } catch (IOException e) {
                    e.printStackTrace();
                }

                final LocalServer localServer = new LocalServer(
                        new FileStorage(projectsDir, webDir), new AndroidSaver(MainActivity.this));
                int port;
                try {
                    port = localServer.start();
                } catch (IOException e) {
                    final String message = e.getMessage();
                    runOnUiThread(new Runnable() {
                        public void run() {
                            status.setText("无法启动本地服务: " + message);
                        }
                    });
                    return;
                }

                server = localServer;
                final int readyPort = port;
                runOnUiThread(new Runnable() {
                    public void run() {
                        if (webView == null) return;
                        status.setVisibility(View.GONE);
                        webView.loadUrl("http://127.0.0.1:" + readyPort + "/");
                    }
                });
            }
        }, "zp-boot").start();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                } else if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    result = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        result[i] = data.getClipData().getItemAt(i).getUri();
                    }
                }
            }
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(result);
                pendingFileCallback = null;
            }
            return;
        }
        if (requestCode == REQ_CREATE_DOC) {
            String req = pendingExportRequest;
            String src = pendingExportPath;
            pendingExportPath = null;
            pendingExportName = null;
            pendingExportRequest = null;
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                notifyExport(req, "cancelled", "");
                return;
            }
            String error = null;
            try {
                InputStream in = new FileInputStream(src);
                OutputStream os = getContentResolver().openOutputStream(data.getData());
                try {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                } finally {
                    in.close();
                    os.close();
                }
            } catch (Exception e) {
                error = String.valueOf(e.getMessage());
            }
            if (src != null) new File(src).delete();
            notifyExport(req, error == null ? "ok" : "failed", error == null ? "" : error);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        /* Ask the page first: open menus, dialogs and the code editor close
         * before the activity is allowed to exit, and the editor asks about
         * unsaved changes on its own. */
        webView.evaluateJavascript(
                "(function(){try{return (window.zpHandleBack&&window.zpHandleBack())?'1':'0'}catch(e){return '0'}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (value != null && value.indexOf('1') >= 0) return;
                        if (webView != null && webView.canGoBack()) {
                            webView.goBack();
                            return;
                        }
                        confirmExit();
                    }
                });
    }

    private void confirmExit() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.exit_title)
                .setMessage(R.string.exit_message)
                .setPositiveButton(R.string.exit_ok, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        finish();
                    }
                })
                .setNegativeButton(R.string.exit_cancel, null)
                .show();
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /* ------------------------------------------------------------- assets */

    /* The installed version is the cache marker: every new APK must replace the
     * web assets, otherwise the phone keeps running the previous bundle. */
    private String appVersionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    private void notifyExport(String requestId, String status, String detail) {
        String id = requestId == null ? "" : requestId;
        String code = "window.zpAndroidExportResult&&window.zpAndroidExportResult("
                + Json.str(id) + "," + Json.str(status) + "," + Json.str(detail == null ? "" : detail) + ")";
        final String js = code;
        runOnUiThread(new Runnable() {
            public void run() {
                if (webView != null) webView.evaluateJavascript(js, null);
            }
        });
    }

    private void extractWebAssets(File dest, String version) throws IOException {
        File marker = new File(dest, ".web_version");
        if (marker.isFile()) {
            String have = readSmall(marker);
            if (version.equals(have)) return;
        }
        deleteTree(dest);
        copyAssetDir("web", dest);
        writeSmall(marker, version);
    }

    private void copyAssetDir(String path, File dest) throws IOException {
        AssetManager am = getAssets();
        String[] children = am.list(path);
        if (children != null && children.length > 0) {
            dest.mkdirs();
            for (String child : children) {
                copyAssetDir(path + "/" + child, new File(dest, child));
            }
            return;
        }
        InputStream in;
        try {
            in = am.open(path);
        } catch (IOException e) {
            dest.mkdirs();
            return;
        }
        File parent = dest.getParentFile();
        if (parent != null) parent.mkdirs();
        OutputStream out = new FileOutputStream(dest);
        try {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            in.close();
            out.close();
        }
    }

    private void seedProjects(File webDir, File projectsDir) throws IOException {
        if (hasProjects(projectsDir)) return;
        File seed = new File(webDir, "projects/demo");
        if (!seed.isDirectory()) return;
        copyTree(seed, new File(projectsDir, "demo"));
    }

    private static boolean hasProjects(File dir) {
        File[] children = dir.listFiles();
        if (children == null) return false;
        for (File child : children) {
            if (child.isDirectory() && new File(child, "app.json").isFile()) return true;
        }
        return false;
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
        InputStream in = new FileInputStream(src);
        OutputStream out = new FileOutputStream(dest);
        try {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            in.close();
            out.close();
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

    private static String readSmall(File file) {
        try {
            FileInputStream in = new FileInputStream(file);
            byte[] buf = new byte[(int) Math.min(file.length(), 256)];
            int n = in.read(buf);
            in.close();
            return n > 0 ? new String(buf, 0, n, "UTF-8").trim() : "";
        } catch (IOException e) {
            return "";
        }
    }

    private static void writeSmall(File file, String text) {
        try {
            FileOutputStream out = new FileOutputStream(file);
            out.write(text.getBytes("UTF-8"));
            out.close();
        } catch (IOException ignored) {}
    }

    /* ------------------------------------------------------------- bridge */

    private class Bridge {
        private final File projectsDir;

        Bridge(File projectsDir) {
            this.projectsDir = projectsDir;
        }

        @JavascriptInterface
        public boolean isAndroidApp() {
            return true;
        }

        @JavascriptInterface
        public String getProjectsPath() {
            return projectsDir.getAbsolutePath();
        }

        @JavascriptInterface
        public void toast(final String message) {
            runOnUiThread(new Runnable() {
                public void run() {
                    Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show();
                }
            });
        }

        /* Hands a finished zip to the system file picker so the user can pick
         * any folder (Downloads, Drive, SD card, ...). The result comes back
         * through window.zpAndroidExportResult(id, status, detail). */
        @JavascriptInterface
        public void exportFileToUser(final String path, final String name, final String requestId) {
            runOnUiThread(new Runnable() {
                public void run() {
                    if (path == null || !new File(path).isFile()) {
                        notifyExport(requestId, "failed", "missing file");
                        return;
                    }
                    pendingExportPath = path;
                    pendingExportName = name;
                    pendingExportRequest = requestId;
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/zip");
                    if (name != null && name.length() > 0) {
                        intent.putExtra(Intent.EXTRA_TITLE, name);
                    }
                    try {
                        startActivityForResult(intent, REQ_CREATE_DOC);
                    } catch (Exception e) {
                        pendingExportPath = null;
                        pendingExportName = null;
                        pendingExportRequest = null;
                        notifyExport(requestId, "failed", "no file picker");
                    }
                }
            });
        }
    }
}
