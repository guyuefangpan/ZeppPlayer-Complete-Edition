# Builds the standalone ZeppPlayer Android APK.
#
# Toolchain (already present on this machine):
#   JDK 17          C:\Android\jdk17
#   Android SDK     C:\Android\Sdk  (platform android-35, build-tools 35.0.0)
#
# The APK contains the same web front-end as the desktop build and runs it in
# a WebView over a loopback HTTP server implemented in Java.

$ErrorActionPreference = "Stop"

$SDK = "C:\Android\Sdk"
$JDK = "C:\Android\jdk17"
$BT = Join-Path $SDK "build-tools\35.0.0"
$ANDROID_JAR = Join-Path $SDK "platforms\android-35\android.jar"

$ROOT = $PSScriptRoot
$MASTER = Join-Path $ROOT "..\ZeppPlayer-master"
$BUILD = Join-Path $ROOT "build"
$ASSETS = Join-Path $ROOT "assets"
$RELEASE = Join-Path $ROOT "release"
$VERSION = "1.10.24"
$VER_PARTS = $VERSION.Split(".")
$VER_CODE = [int]$VER_PARTS[0] * 10000 + [int]$VER_PARTS[1] * 100 + [int]$VER_PARTS[2]
$OUT_APK = Join-Path $RELEASE "ZeppPlayer-$VERSION.apk"

$env:JAVA_HOME = $JDK
$env:PATH = "$JDK\bin;$env:PATH"

# Keep the manifest in sync. versionCode must increase or Android rejects the
# update, and versionName doubles as the web asset cache marker at runtime.
$MANIFEST = Join-Path $ROOT "AndroidManifest.xml"
$mf = Get-Content $MANIFEST -Raw
$mf = $mf -replace 'android:versionCode="[^"]*"', ('android:versionCode="' + $VER_CODE + '"')
$mf = $mf -replace 'android:versionName="[^"]*"', ('android:versionName="' + $VERSION + '"')
[System.IO.File]::WriteAllText($MANIFEST, $mf, (New-Object System.Text.UTF8Encoding($false)))

function Step($text) { Write-Host "==> $text" }

if (!(Test-Path $ANDROID_JAR)) { throw "android.jar not found: $ANDROID_JAR" }
if (!(Test-Path (Join-Path $MASTER "app\index.html"))) { throw "web app not found: $MASTER\app" }

New-Item -ItemType Directory -Force -Path $BUILD, $ASSETS, $RELEASE | Out-Null
Remove-Item (Join-Path $BUILD "*") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $ASSETS "*") -Recurse -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------- web assets
Step "Copying web front-end"
$WEB = Join-Path $ASSETS "web"
New-Item -ItemType Directory -Force -Path $WEB | Out-Null
Copy-Item (Join-Path $MASTER "app\*") $WEB -Recurse -Force

Step "Building web bundle for Android (es2015)"
$esbuild = Join-Path $MASTER "node_modules\.bin\esbuild.cmd"
& $esbuild --bundle --target=es2015 ("--outfile=" + (Join-Path $WEB "index.browser.js")) (Join-Path $MASTER "src\index.browser.js")
if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }

Set-Content -Path (Join-Path $WEB "package.json") -Encoding ASCII -Value ('{"name":"zeppplayer","version":"' + $VERSION + '","main":"index.browser.js"}')

Step "Bundling sample project"
New-Item -ItemType Directory -Force -Path (Join-Path $WEB "projects") | Out-Null
Copy-Item (Join-Path $MASTER "projects\demo") (Join-Path $WEB "projects\demo") -Recurse -Force

# On a phone there is no way to open DevTools, so any boot failure is painted
# straight onto the page. Desktop builds are untouched.
Step "Injecting boot diagnostics"
$htmlPath = Join-Path $WEB "index.html"
$html = Get-Content $htmlPath -Raw
$reporter = @'
<script>
(function () {
    var seen = {};
    var shown = 0;
    var timer = null;
    function hide() {
        try {
            var el = document.getElementById("zp_boot_error");
            if (el && el.parentNode) el.parentNode.removeChild(el);
        } catch (e) {}
        seen = {};
        shown = 0;
        timer = null;
    }
    /* A phone has no DevTools, so real boot failures must stay visible. But
     * repeating errors (a dead runtime hit on every tap) must not build a
     * permanent wall of text: duplicates are ignored and the bar hides itself
     * shortly after the last new message. */
    function report(msg) {
        try {
            msg = String(msg == null ? "unknown error" : msg);
            var key = msg.split("\n")[0].slice(0, 160);
            if (seen[key]) return;
            if (shown >= 4) return;
            var el = document.getElementById("zp_boot_error");
            if (!el) {
                el = document.createElement("div");
                el.id = "zp_boot_error";
                el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;max-height:22vh;overflow:auto;"
                    + "background:rgba(176,0,32,0.94);color:#fff;font:12px/1.45 monospace;padding:8px 10px;white-space:pre-wrap;"
                    + "pointer-events:none;border-radius:8px 8px 0 0;";
                document.body.appendChild(el);
            }
            var line = document.createElement("div");
            line.style.cssText = "margin:2px 0;";
            line.textContent = msg;
            el.appendChild(line);
            seen[key] = true;
            shown++;
            if (timer) clearTimeout(timer);
            timer = setTimeout(hide, 8000);
        } catch (e) {}
    }
    window.__zpReport = report;
    try { console.log("[boot] ZeppPlayer web __ZP_VERSION__"); } catch (e) {}
    window.addEventListener("error", function (e) {
        if (e && e.message) {
            report("Error: " + e.message + "\n" + (e.filename || "") + ":" + (e.lineno || 0) + ":" + (e.colno || 0));
        } else if (e && e.target && e.target.tagName === "SCRIPT") {
            report("Failed to load script: " + (e.target.src || ""));
        }
    }, true);
    window.addEventListener("unhandledrejection", function (e) {
        var r = e && e.reason;
        report("Rejected: " + (r && (r.stack || r.message) || r || "unknown"));
    });
})();
</script>
'@
$html = $html.Replace('<script src="/app/lib/gif.js"></script>', $reporter + '<script src="/app/lib/gif.js" onerror="__zpReport(''gif.js failed to load'')"></script>')
$html = $html.Replace('<script src="/app/index.browser.js"></script>', '<script src="/app/index.browser.js" onerror="__zpReport(''index.browser.js failed to load'')"></script>')
$html = $html.Replace("__ZP_VERSION__", $VERSION)
# Cache-busting: every /app/ asset link carries the build version. Even if a
# WebView keeps an old entry in its HTTP cache, the URL itself is new, so the
# freshly installed bundle is always the one that runs.
$html = [regex]::Replace($html, '(href|src)="/app/([^"?]+)"', {
    param($m)
    $m.Groups[1].Value + '="/app/' + $m.Groups[2].Value + '?v=' + $VERSION + '"'
})
[System.IO.File]::WriteAllText($htmlPath, $html, (New-Object System.Text.UTF8Encoding($false)))
if (-not (Select-String -Path $htmlPath -Pattern '__zpReport' -Quiet)) { throw "diagnostics injection failed" }

# ------------------------------------------------------------------ resources
Step "Preparing resources"
New-Item -ItemType Directory -Force -Path (Join-Path $ROOT "res\drawable") | Out-Null
Copy-Item (Join-Path $MASTER "app\icon.png") (Join-Path $ROOT "res\drawable\ic_launcher.png") -Force

# ------------------------------------------------------------------- package
Step "aapt2 compile"
& (Join-Path $BT "aapt2.exe") compile --dir (Join-Path $ROOT "res") -o (Join-Path $BUILD "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

# Assets are added by the zip step below instead of `-A`: aapt2 on Windows
# stores their names with backslashes ("assets/web\index.html"), which the
# Android AssetManager cannot resolve, so the WebView would open an empty page.
Step "aapt2 link"
# --java emits R.java, which the activity needs for its string resources.
Remove-Item (Join-Path $BUILD "gen") -Recurse -Force -ErrorAction SilentlyContinue
& (Join-Path $BT "aapt2.exe") link -o (Join-Path $BUILD "base.apk") `
    -I $ANDROID_JAR `
    --manifest (Join-Path $ROOT "AndroidManifest.xml") `
    -R (Join-Path $BUILD "res.zip") `
    --java (Join-Path $BUILD "gen") `
    --min-sdk-version 24 `
    --target-sdk-version 34 `
    --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Step "Compiling Java"
$sources = Get-ChildItem (Join-Path $ROOT "java") -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$genSources = Get-ChildItem (Join-Path $BUILD "gen") -Recurse -Filter *.java -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
New-Item -ItemType Directory -Force -Path (Join-Path $BUILD "classes") | Out-Null
& (Join-Path $JDK "bin\javac.exe") -encoding UTF-8 -source 8 -target 8 `
    -bootclasspath $ANDROID_JAR `
    -d (Join-Path $BUILD "classes") $sources $genSources
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Step "Dexing"
$classes = Get-ChildItem (Join-Path $BUILD "classes") -Recurse -Filter *.class | ForEach-Object { $_.FullName }
New-Item -ItemType Directory -Force -Path (Join-Path $BUILD "dex") | Out-Null
& (Join-Path $BT "d8.bat") --min-api 24 --lib $ANDROID_JAR --output (Join-Path $BUILD "dex") $classes
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Step "Adding classes.dex and assets"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$baseApk = Join-Path $BUILD "base.apk"
$zip = [System.IO.Compression.ZipFile]::Open($baseApk, [System.IO.Compression.ZipArchiveMode]::Update)
try {
    $entry = $zip.CreateEntry("classes.dex", [System.IO.Compression.CompressionLevel]::Optimal)
    $es = $entry.Open()
    try {
        $fs = [System.IO.File]::OpenRead((Join-Path $BUILD "dex\classes.dex"))
        try { $fs.CopyTo($es) } finally { $fs.Dispose() }
    } finally { $es.Dispose() }

    $assetFiles = Get-ChildItem $ASSETS -Recurse -File
    foreach ($file in $assetFiles) {
        $rel = $file.FullName.Substring($ASSETS.Length + 1).Replace('\', '/')
        $name = "assets/$rel"
        if ($zip.GetEntry($name) -ne $null) { continue }
        $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
        $es = $entry.Open()
        try {
            $fs = [System.IO.File]::OpenRead($file.FullName)
            try { $fs.CopyTo($es) } finally { $fs.Dispose() }
        } finally { $es.Dispose() }
    }
} finally { $zip.Dispose() }
Write-Host "    assets: $($assetFiles.Count) files"

Step "Aligning"
& (Join-Path $BT "zipalign.exe") -f 4 (Join-Path $BUILD "base.apk") (Join-Path $BUILD "aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Step "Signing"
$KS = Join-Path $ROOT "keystore\zeppplayer.keystore"
if (!(Test-Path $KS)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $ROOT "keystore") | Out-Null
    & (Join-Path $JDK "bin\keytool.exe") -genkeypair -keystore $KS -alias zeppplayer `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass zeppplayer -keypass zeppplayer `
        -dname "CN=ZeppPlayer, OU=Mobile, O=ZeppPlayer, L=NA, ST=NA, C=CN"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}
if (Test-Path $OUT_APK) { Remove-Item $OUT_APK -Force }
& (Join-Path $BT "apksigner.bat") sign `
    --ks $KS --ks-key-alias zeppplayer `
    --ks-pass pass:zeppplayer --key-pass pass:zeppplayer `
    --out $OUT_APK (Join-Path $BUILD "aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

Step "Verifying signature"
& (Join-Path $BT "apksigner.bat") verify --print-certs $OUT_APK
if ($LASTEXITCODE -ne 0) { throw "signature verification failed" }

$size = [math]::Round((Get-Item $OUT_APK).Length / 1MB, 1)
Step "Done: $OUT_APK ($size MB)"
