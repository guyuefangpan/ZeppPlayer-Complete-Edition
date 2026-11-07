package com.zeppplayer.mobile;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/* Writes screenshots, logs and exported projects to places the user can
 * reach: the gallery, the Downloads folder, or the project itself. */
public class AndroidSaver implements Saver {
    private final Context ctx;

    public AndroidSaver(Context ctx) {
        this.ctx = ctx;
    }

    public String savePng(String name, byte[] data, File projectDir) {
        final String lower = name == null ? "" : name.toLowerCase();
        final boolean video = lower.endsWith(".mp4") || lower.endsWith(".webm");
        final String mime;
        if (video) {
            mime = lower.endsWith(".webm") ? "video/webm" : "video/mp4";
        } else {
            mime = lower.endsWith(".gif") ? "image/gif" : "image/png";
        }
        if (projectDir != null) {
            try {
                File out = new File(projectDir, name);
                FileOutputStream fos = new FileOutputStream(out);
                try {
                    fos.write(data);
                } finally {
                    fos.close();
                }
                return out.getAbsolutePath();
            } catch (IOException ignored) {
                // fall back to the gallery below
            }
        }
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                ContentValues values = new ContentValues();
                Uri collection;
                if (video) {
                    values.put(MediaStore.Video.Media.DISPLAY_NAME, name);
                    values.put(MediaStore.Video.Media.MIME_TYPE, mime);
                    values.put(MediaStore.Video.Media.RELATIVE_PATH, "DCIM/ZeppPlayer");
                    values.put(MediaStore.Video.Media.IS_PENDING, 1);
                    collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                } else {
                    values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                    values.put(MediaStore.Images.Media.MIME_TYPE, mime);
                    values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/ZeppPlayer");
                    values.put(MediaStore.Images.Media.IS_PENDING, 1);
                    collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                }
                Uri uri = ctx.getContentResolver().insert(collection, values);
                if (uri != null) {
                    OutputStream os = ctx.getContentResolver().openOutputStream(uri);
                    try {
                        os.write(data);
                    } finally {
                        os.close();
                    }
                    values.clear();
                    if (video) {
                        values.put(MediaStore.Video.Media.IS_PENDING, 0);
                    } else {
                        values.put(MediaStore.Images.Media.IS_PENDING, 0);
                    }
                    ctx.getContentResolver().update(uri, values, null, null);
                    return (video ? "DCIM/ZeppPlayer/" : "Pictures/ZeppPlayer/") + name;
                }
            } catch (Exception ignored) {
                // fall through to the app-private folder
            }
        } else {
            // Android 9 and below have no scoped MediaStore: write into the
            // public folder directly and let the scanner index it so the file
            // shows up in the system gallery.
            try {
                File dir = new File(Environment.getExternalStoragePublicDirectory(
                        video ? Environment.DIRECTORY_DCIM : Environment.DIRECTORY_PICTURES),
                        "ZeppPlayer");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("mkdirs failed");
                File out = new File(dir, name);
                FileOutputStream fos = new FileOutputStream(out);
                try {
                    fos.write(data);
                } finally {
                    fos.close();
                }
                MediaScannerConnection.scanFile(ctx, new String[]{out.getAbsolutePath()},
                        new String[]{mime}, null);
                return out.getAbsolutePath();
            } catch (Exception ignored) {
                // no storage permission or unwritable storage
            }
        }
        return writeFallback(video ? "Videos" : "Pictures", name, data);
    }

    /* WebM recordings are re-encoded to MP4 because most phone galleries only
     * index and play MP4. Returns null when the conversion fails. */
    public String saveVideo(String name, byte[] data, File projectDir) {
        String lower = name == null ? "" : name.toLowerCase();
        if (!lower.endsWith(".webm")) return savePng(name, data, projectDir);

        File tmpIn = null;
        File tmpOut = null;
        try {
            File cache = ctx.getCacheDir();
            tmpIn = new File(cache, "record_in_" + System.currentTimeMillis() + ".webm");
            FileOutputStream fos = new FileOutputStream(tmpIn);
            try {
                fos.write(data);
            } finally {
                fos.close();
            }

            tmpOut = new File(cache, "record_out_" + System.currentTimeMillis() + ".mp4");
            if (!VideoTranscoder.transcode(tmpIn, tmpOut) || tmpOut.length() == 0) {
                // Keep the recording instead of losing it; the UI warns that
                // this device could not produce MP4.
                return savePng(name, data, projectDir);
            }

            String mp4Name = name.substring(0, name.length() - 5) + ".mp4";
            return savePng(mp4Name, readAll(tmpOut), projectDir);
        } catch (Exception e) {
            return null;
        } finally {
            if (tmpIn != null) tmpIn.delete();
            if (tmpOut != null) tmpOut.delete();
        }
    }

    private static byte[] readAll(File file) throws IOException {
        FileInputStream is = new FileInputStream(file);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            is.close();
        }
    }

    public String saveText(String name, String text) {
        byte[] bytes;
        try {
            bytes = text.getBytes("UTF-8");
        } catch (Exception e) {
            bytes = text.getBytes();
        }
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
                values.put(MediaStore.Downloads.RELATIVE_PATH, "Download/ZeppPlayerLogs");
                Uri uri = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri != null) {
                    OutputStream os = ctx.getContentResolver().openOutputStream(uri);
                    try {
                        os.write(bytes);
                    } finally {
                        os.close();
                    }
                    return "Download/ZeppPlayerLogs/" + name;
                }
            } catch (Exception ignored) {
                // fall through
            }
        }
        return writeFallback("Logs", name, bytes);
    }

    public String saveZip(String baseName, File zipFile) {
        String name = baseName + ".zip";
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, "application/zip");
                values.put(MediaStore.Downloads.RELATIVE_PATH, "Download/ZeppPlayer");
                Uri uri = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri != null) {
                    OutputStream os = ctx.getContentResolver().openOutputStream(uri);
                    InputStream is = new FileInputStream(zipFile);
                    try {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
                    } finally {
                        is.close();
                        os.close();
                    }
                    return "Download/ZeppPlayer/" + name;
                }
            } catch (Exception ignored) {
                // fall through
            }
        }
        try {
            File dir = fallbackDir("Downloads");
            File out = new File(dir, name);
            InputStream is = new FileInputStream(zipFile);
            FileOutputStream fos = new FileOutputStream(out);
            try {
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) fos.write(buf, 0, n);
            } finally {
                is.close();
                fos.close();
            }
            return out.getAbsolutePath();
        } catch (IOException e) {
            return name;
        }
    }

    public String prepareZip(String baseName, File zipFile) {
        File dir = new File(ctx.getCacheDir(), "exports");
        if (!dir.exists()) dir.mkdirs();
        File out = new File(dir, baseName + ".zip");
        try {
            InputStream is = new FileInputStream(zipFile);
            FileOutputStream fos = new FileOutputStream(out);
            try {
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) fos.write(buf, 0, n);
            } finally {
                is.close();
                fos.close();
            }
            return out.getAbsolutePath();
        } catch (IOException e) {
            return zipFile.getAbsolutePath();
        }
    }

    public void toast(final String message) {
        if (ctx instanceof Activity) {
            ((Activity) ctx).runOnUiThread(new Runnable() {
                public void run() {
                    Toast.makeText(ctx, message, Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    private String writeFallback(String subDir, String name, byte[] data) {
        try {
            File dir = fallbackDir(subDir);
            File out = new File(dir, name);
            FileOutputStream fos = new FileOutputStream(out);
            try {
                fos.write(data);
            } finally {
                fos.close();
            }
            return out.getAbsolutePath();
        } catch (IOException e) {
            return name;
        }
    }

    private File fallbackDir(String subDir) {
        File base = ctx.getExternalFilesDir(null);
        if (base == null) base = ctx.getFilesDir();
        File dir = new File(base, subDir);
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }
}
