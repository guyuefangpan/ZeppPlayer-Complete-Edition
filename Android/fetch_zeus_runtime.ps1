# Stages the native runtime the Android build needs for a real Zeus CLI:
#
#   lib/arm64-v8a/libnode_cli.so   actual Node.js 26 binary (Android/arm64)
#   lib/arm64-v8a/*.so             its shared dependencies
#   zeus/node/                     npm (pure JS, ships with Node upstream)
#   zeus/node_modules/             @zeppos/zeus-cli + pure-JS dependencies
#
# Everything is fetched from the Termux package mirror and the npm registry at
# build time; nothing binary is committed to git. Re-running is a no-op once
# the output exists, delete `.zeus_runtime` to force a refresh.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$MIRROR = "https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main"
$ARCH = "aarch64"
$OUT = Join-Path $PSScriptRoot "..\.zeus_runtime"
$CACHE = Join-Path $OUT "cache"
$LIBS = Join-Path $OUT "libs"
$ZEUS = Join-Path $OUT "zeus"
$STAMP = Join-Path $OUT "runtime.json"

$NODE_VERSION = "26.13.1"
$NPM_VERSION = "12.2.3"
$ZEUS_VERSION = "1.10.3"
$ESBUILD_VERSION = "0.28.2"

function Step($t) { Write-Host "==> $t" }

New-Item -ItemType Directory -Force -Path $CACHE, $LIBS, $ZEUS | Out-Null

if (Test-Path $STAMP) {
    Write-Host "Runtime already staged at $OUT"
    exit 0
}

# ---------------------------------------------------------------- packages
# Resolve the current pool paths from the repository index instead of pinning
# file names, so dependency bumps do not break the build.
Step "Resolving Termux packages"
$indexGz = Join-Path $CACHE "Packages.gz"
Invoke-WebRequest "$MIRROR/dists/stable/main/binary-$ARCH/Packages.gz" -OutFile $indexGz -TimeoutSec 600
$in = New-Object System.IO.FileStream($indexGz, 'Open', 'Read')
$gz = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
$reader = New-Object System.IO.StreamReader($gz)
$text = $reader.ReadToEnd()
$reader.Close()

$wanted = @("nodejs", "npm", "libc++", "openssl", "c-ares", "libicu", "libsqlite", "zlib", "libffi", "esbuild")
$files = @{}
foreach ($block in ($text -split "`n`n")) {
    $field = @{}
    foreach ($line in ($block -split "`n")) {
        $at = $line.IndexOf(": ")
        if ($at -gt 0) { $field[$line.Substring(0, $at)] = $line.Substring($at + 2).Trim() }
    }
    if ($field.ContainsKey("Package") -and ($wanted -contains $field["Package"])) {
        $files[$field["Package"]] = $field["Filename"]
    }
}
foreach ($pkg in $wanted) {
    if (-not $files.ContainsKey($pkg)) { throw "package not found in index: $pkg" }
}

Step "Downloading packages"
foreach ($pkg in $wanted) {
    $rel = $files[$pkg]
    $local = Join-Path $CACHE (($pkg -replace '[^A-Za-z0-9]', '_') + ".deb")
    if (-not (Test-Path $local)) {
        $url = "$MIRROR/" + (($rel -replace ':', '%3A'))
        Invoke-WebRequest $url -OutFile $local -TimeoutSec 900
        Write-Host ("    " + $pkg + "  " + [math]::Round((Get-Item $local).Length / 1KB) + " KB")
    }
}

Step "Extracting"
$root = Join-Path $CACHE "extract"
New-Item -ItemType Directory -Force -Path $root | Out-Null
foreach ($pkg in $wanted) {
    $deb = Join-Path $CACHE (($pkg -replace '[^A-Za-z0-9]', '_') + ".deb")
    $dir = Join-Path $root ($pkg -replace '[^A-Za-z0-9]', '_')
    if (Test-Path (Join-Path $dir "data")) { continue }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    tar -xf $deb -C $dir
    tar -xf (Join-Path $dir "data.tar.xz") -C $dir
}

function TermuxUsr($pkg) {
    $name = $pkg -replace '[^A-Za-z0-9]', '_'
    Join-Path $root "$name\data\data\com.termux\files\usr"
}

# ---------------------------------------------------------------- node + libs
Step "Staging node and shared libraries"
$usr = TermuxUsr "nodejs"
$node = Join-Path $usr "bin\node"
if (-not (Test-Path $node)) { throw "node binary not found" }
Copy-Item $node (Join-Path $LIBS "libnode_cli.so") -Force

# DT_NEEDED sonames the node binary was linked against.
$needed = @(
    @{ pkg = "libc++";     name = "libc++_shared.so" },
    @{ pkg = "c-ares";     name = "libcares.so" },
    @{ pkg = "libsqlite";  name = "libsqlite3.so" },
    @{ pkg = "libffi";     name = "libffi.so" },
    @{ pkg = "zlib";       name = "libz.so.1" },
    @{ pkg = "openssl";    name = "libcrypto.so.3" },
    @{ pkg = "openssl";    name = "libssl.so.3" },
    @{ pkg = "libicu";     name = "libicui18n.so.79" },
    @{ pkg = "libicu";     name = "libicuuc.so.79" },
    @{ pkg = "libicu";     name = "libicudata.so.79" }
)
foreach ($lib in $needed) {
    $dir = Join-Path (TermuxUsr $lib.pkg) "lib"
    $src = Join-Path $dir $lib.name
    if (-not (Test-Path $src)) { throw ("missing library " + $lib.name + " in " + $lib.pkg) }
    # Some entries are symlinks; copy the resolved file under the soname.
    $resolved = (Resolve-Path $src).Path
    Copy-Item $resolved (Join-Path $LIBS $lib.name) -Force
}

# esbuild has no official Android build; Termux ships one. The JS wrapper
# locates it through ESBUILD_BINARY_PATH at runtime.
$esbuildUsr = TermuxUsr "esbuild"
$esbuildBin = Join-Path $esbuildUsr "bin\esbuild"
if (-not (Test-Path $esbuildBin)) { throw "esbuild binary not found" }
Copy-Item $esbuildBin (Join-Path $LIBS "libesbuild.so") -Force

# ---------------------------------------------------------------- npm + zeus
Step "Staging npm"
$npmUsr = TermuxUsr "npm"
$npmModules = Join-Path $npmUsr "lib\node_modules\npm"
if (-not (Test-Path $npmModules)) { throw "npm package payload not found" }
Copy-Item $npmModules (Join-Path $ZEUS "npm") -Recurse -Force

Step "Installing @zeppos/zeus-cli $ZEUS_VERSION"
$zeusPkg = Join-Path $ZEUS "package.json"
if (-not (Test-Path $zeusPkg)) {
    Set-Content $zeusPkg -Encoding ASCII -Value '{"name":"zeus-runtime","private":true}'
}
Push-Location $ZEUS
try {
    & npm install --omit=dev --no-audit --no-fund --loglevel=error ("@zeppos/zeus-cli@" + $ZEUS_VERSION)
    if ($LASTEXITCODE -ne 0) { throw "npm install of zeus-cli failed" }
    & npm install --omit=dev --no-audit --no-fund --loglevel=error pngjs ("esbuild@" + $ESBUILD_VERSION)
    if ($LASTEXITCODE -ne 0) { throw "npm install of pngjs/esbuild failed" }
} finally {
    Pop-Location
}

# sharp ships native binaries for desktop platforms only; replace it with the
# pure-JS subset the build pipeline actually uses (see zeus-shims/sharp).
Step "Installing sharp compatibility layer"
$shim = Join-Path $PSScriptRoot "zeus-shims\sharp"
$sharpDir = Join-Path $ZEUS "node_modules\sharp"
if (Test-Path $sharpDir) { Remove-Item $sharpDir -Recurse -Force }
Copy-Item $shim $sharpDir -Recurse -Force

# Desktop-only optional binaries are dead weight on a phone.
Step "Pruning desktop-only payload"
foreach ($rel in @("@img", "@esbuild", "@types", "eslint", ".bin")) {
    $p = Join-Path $ZEUS "node_modules\$rel"
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Get-ChildItem (Join-Path $ZEUS "node_modules") -Directory | Where-Object {
    $_.Name -match "win32|darwin" -or $_.Name -like "sharp-*"
} | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
foreach ($docDir in @("doc", "man", "html", "docs")) {
    $p = Join-Path $ZEUS "npm\$docDir"
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

Step "Writing runtime stamp"
$manifest = @{
    node = $NODE_VERSION
    npm = $NPM_VERSION
    zeus = $ZEUS_VERSION
    arch = "arm64-v8a"
    stagedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json
[System.IO.File]::WriteAllText($STAMP, $manifest, (New-Object System.Text.UTF8Encoding($false)))

$mb = [math]::Round(((Get-ChildItem $OUT -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "==> Runtime staged: $OUT ($mb MB)"
