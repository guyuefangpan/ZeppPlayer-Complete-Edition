# ZeppPlayer 补完版 / ZeppPlayer Complete Edition

> 基于 [MelianMiko/ZeppPlayer](https://github.com/MelianMiko/ZeppPlayer) 的非官方增强版本。桌面端界面保持不变，重点补齐手机端体验，并附带可直接安装的安卓 App。

在原版 ZeppPlayer（非官方 ZeppOS 模拟器）的基础上，本版把"在手机上预览表盘/应用"这条链路补齐了：顶栏与侧栏重新组织、面板切换与文件操作合并为下拉、横竖屏分别布局，安卓端以独立 App 形式运行同一套前端；同时补上了代码面板、快捷键面板、中文界面、app-side（伴随端）运行时等能力。

**对比基线**：上游 `melianmiko/ZeppPlayer` 的 `master` 分支，HEAD 为 `7fcd82d`（2024-05-22，版本号 1.8.14）。本版基于该提交，共变更 **64 个文件，+13950 / −775 行**：新增 36 个、修改 26 个、删除 2 个。

---

## 一、手机端界面

原版只有一套桌面布局（四列横排），在手机上按钮互相挤压、图标错位。本版新增响应式模式判定与两套手机布局。

- **新增视图模式判定**（`src/ui_managment/ViewMode.js`，+101）：按窗口宽度（阈值 900px）与设备类型计算，把 `zp-mobile` / `zp-portrait` / `zp-landscape` 写到 `<body>`；支持 `?zp_view=portrait|landscape|desktop` 强制模式，便于在没有真机时预览两种朝向。
- **竖屏布局**：顶栏只保留项目/设备选择，工具区独立横向滚动；侧栏固定在左侧，主区域为屏幕 + 面板上下堆叠。
- **横屏布局**：左侧控制台、右侧屏幕，避免原版"控制台把屏幕挤到下面"的分配。
- **顶栏横向滚动拆分**：`#toolbar_top` 改为 `overflow: hidden`，新增 `#toolbar_top > .tools` 作为独立滚动容器，项目/设备选择不再被推出屏幕。
- **侧栏按钮校准**：12 个按钮统一 32×32 盒模型、内边距 0、flex 居中；选中态深灰遮罩与按钮本身、图标全部对齐（原版部分按钮图标偏左上、遮罩与按钮错位）。
- **侧栏分区**：三个功能区的间距加大，区间的淡灰分隔线在间隙中居中；顶部三个按钮（暂停/重播/录屏）单独调整步进与字号，与下方按钮的视觉节奏一致。
- **顶栏设置入口**：顶栏的设置按钮在手机端隐藏，改到侧栏，用 `tune` 图标与表盘设置（齿轮）区分。
- **手机端隐藏**：预览图概览、快捷键查看、顶栏设置三个按钮（桌面端仍保留）。
- 样式集中在 `app/index.css`（+1307），结构改动在 `app/index.html`（+169）。

## 二、顶栏与侧栏的交互改造

- **面板下拉**（`#zp_split_panels`）：控制台、控件修改、资源管理器、代码修改四个按钮合并为一个下拉，默认只显示当前面板图标，右下角带小三角提示；菜单用视口固定定位，不会被横向滚动容器裁切。
- **文件下拉**（`#zp_split_files`）：导入项目、导出、打开项目文件夹三个按钮合并为一个下拉。
- **录屏/截图分组**（`#zp_split_capture`）：侧栏两个按钮合并为一个，点击向右展开录像与拍照；展开项间距 28px，去掉淡灰底色遮罩，改为浮层纯图标。
- **面板切换逻辑上移**：`window.zpPanelTab` 从 `init()` 内部提升到模块作用域，即使启动流程异常，顶栏面板按钮仍然可用；同时同步下拉图标与菜单项高亮，并把当前面板写入 `zp_activePanel`。
- **代码面板开关**：新增 `window.zpOpenCode` / `window.zpCloseCode`，手机端以全屏浮层打开，桌面端保持内嵌。
- **图标修正**：资源管理器图标由字体中不存在的 `explorer` 字形改为真实存在的 `account_tree`（原字形缺失会导致图标显示错乱）。

## 三、项目与文件管理

- **删除项目**：项目选择器底部新增"删除项目"，二次确认后调用 `POST /api/delete_project`，删除磁盘目录并刷新列表；桌面端（`electron_main.js`）与安卓端（`LocalServer.java`）后端都已实现。
- **导入后自动选中**：导入文件夹 / zip / 路径三种方式完成后，直接刷新列表并切换到新项目，不再整页刷新。
- **选择器重写**（`ProjectPicker.ts`，+208）：`refreshOptions()` 可反复重建列表并返回最终选中项；选项永远落在真实项目上（不会停在"操作项"）；上次项目丢失时回退到第一个可用项目。
- **错误反馈**：打开文件夹、切换目录、打开项目、删除项目失败都会弹出提示，而不是静默失败。
- **拖拽导入**：新增 `preload.js`（+23），通过 `contextBridge` 暴露 `zpDesktop.getPathForFile`，在 `contextIsolation` 下拿到拖入文件的真实路径。

## 四、录制与截图

- **录像重写**（`VideoRecorder.js`，+340，取代原 `GifRecorder.js`）：优先 `video/mp4;codecs=avc1.42E01E`，不支持时回退 WebM（VP8/VP9）；码率按画布尺寸在 1.5–4 Mbps 之间自适应；录制时叠加 `app/recording_frame.png` 外框；手机端录制结束后由安卓端转码为 MP4。
- **截图**（`ScreenshotManager.js`，+134）：截取 `#display` 画布为 PNG，写入剪贴板并落盘（用户图片目录或当前项目），用轻提示反馈结果。
- 删除 `app/render_fail.png`（旧渲染失败占位图，已无引用）。

## 五、代码面板与快捷键面板

- **代码面板**（`src/ui_next/panel_code/`，+461）：文件树 + 编辑器，可查看并修改项目源码、保存后触发热重载；手机端全屏显示，桌面端内嵌在左侧面板；保存时调用 `ChangesWatcher.hold()` 避免触发二次重启。
- **快捷键面板**（`src/ui_next/shortcuts/`，+136）：分组列出全部快捷键，桌面顶栏新增 `keyboard` 入口，命令面板新增 "Shortcuts" 项。
- **面板容错**：`RootComponent` 中每个根节点独立 `try/catch` 渲染，单个面板出错不会让整个界面白屏（手机上没有 DevTools，这点尤其重要）。

## 六、控制台

`ConsoleManager.js`（+183）新增：

- 顶部工具栏：清空、复制全部、导出日志、自动滚动开关
- 日志上限 3000 条，避免长时间运行后内存膨胀
- 每条日志带时间戳，导出文件名为 `zeppplayer-log-YYYYMMDD-HHmmss.txt`
- 复制/导出结果通过轻提示反馈，失败时给出原因

## 七、运行时与模拟器能力

- **app-side（伴随端）运行时**（新增 `src/zepp_player/appside/`，+419）：`AppSideManager` 负责加载项目的 `app-side.js`，`AppSideRuntime` 提供沙箱执行环境，`ZBuffer` 提供 Node `Buffer` 常用方法的兼容实现；设备侧与伴随端通过进程内虚拟链路通信，取代真实蓝牙端点 `0x00a0`。
- **messaging / hmBle 模拟**（`zepp_env/MessagingMock.js`，+69）：把设备侧 `messaging` 调用路由到 `AppSideManager`；没有伴随端时为空操作，旧版 `app.js` 不受影响；页面运行时销毁时自动释放监听器（`SyystemEnvironment.ts`）。
- **触摸输入**（`ChromeZeppPlayer.ts`，+95）：鼠标事件改为 Pointer Events，鼠标/触控笔/手指统一处理；画布被 CSS 缩小后按比例把 CSS 像素映射回画布像素并做越界裁剪；`touch-action: none` 关闭浏览器手势，长按不再弹出上下文菜单；运行时为空时忽略点击，不再报 "handleEvent of null"。
- **播放器生命周期**（`ZeppPlayer.ts`，+49）：新增 `dispose()` 供概览卡片等短生命周期播放器释放定时器；重启请求去重，避免文件监听、保存、工具栏同时触发多次重启；新增 `onRuntimeChanged` 信号；加载项目时同时加载 app-side。
- **控制台消息**（`ZeppRuntime.js`）：日志附加 `scriptPath`，控制台可定位来源文件。
- **可选文件探测**（`ChromeZeppPlayer.ts`）：探测 `app-side.js` 是否存在时使用静默模式，缺失不再报致命错误。

## 八、多语言

- 新增 `src/zepp_player/i18n.js`（+415）：内置中文/英文词典，默认中文，可在设置中切换并持久化到 `zp_lang`。
- 全部界面文案改为 `data-i18n` / `data-i18n-title` 属性或 `I18n.t()` 调用，覆盖：顶栏提示、侧栏按钮、面板名称、文件操作、项目选择器、控制台工具栏、资源管理器、设置面板、命令面板、概览页、对话框与提示。
- 颜色设置项（`CssColorOptions.tsx`）从硬编码英文改为词条键。

## 九、健壮性修复

- **localStorage 兜底**（`AppSettingsManager.js`，+36）：隐私模式或受限 WebView 中 `localStorage` 会抛异常，改为内存回退，不再让整个 UI 崩掉。
- **自动重启抑制**（`ChangesWatcher.js`，+51）：手动保存后 1.5 秒内忽略文件变更通知；没有项目时不启动监听；接口异常时只告警不抛错。
- **资源管理器**（`ExplorerManager.js`，+29）：无运行时/无视图时直接返回；文案国际化；属性编辑改用自绘 `zpPrompt`。
- **概览卡片**（`OverviewCard.tsx`，+53）：预览图重建后追加时间戳刷新 `<img>`（原来图片加载失败后不会更新）；播放器实例复用并在卸载时 `dispose()`；未选设备时回退 `mi_band7`。
- **旧 WebView 兼容**（`PropEditorEntry.tsx`）：`replaceAll` 改为 `split/join`。
- **自绘对话框**（`zpDialogs.js`，+171）：Electron 渲染进程不支持 `prompt()`，`confirm()` 也不可靠，改为 DOM 覆盖层实现 `zpAlert` / `zpConfirm` / `zpPrompt`。
- **轻提示**（`zpToast.js`，+49）：截图、控制台、删除项目等操作的非阻塞反馈，不拦截点击。

## 十、桌面端（Electron）

- **主进程**（新增 `electron_main.js`，+956）：内置本地 HTTP 服务（监听 `0.0.0.0`），实现与安卓端一致的接口；原生文件/目录对话框；项目导入（文件夹/zip/路径）与导出；截图、录像、文本落盘；窗口管理与下载接管；通过 `before-input-event` 把原始按键转发给渲染进程，保证输入法组合输入时快捷键依然有效。
- **接口清单**（桌面与安卓一致）：`/api/list_projects`、`/api/import_project`、`/api/import_zip_upload`、`/api/import_path`、`/api/delete_project`、`/api/export_project`、`/api/download_project`、`/api/open_projects`、`/api/choose_projects_dir`、`/api/set_projects_dir`、`/api/folder_chooser`、`/api/save_preview`、`/api/save_text`、`/api/change_count`、`/api/watch`、`/api/server_info`。
- **打包**（`package.json`，+46）：版本号 1.8.14，`main` 指向 `electron_main.js`；新增 `dist:x64` / `dist:ia32` / `dist` 脚本与 electron-builder 配置（NSIS、可选安装目录、桌面与开始菜单快捷方式、`assets/icon.ico`）；新增依赖 `electron`、`electron-builder`。
- **局域网访问**：设置面板显示本机服务地址，可一键复制，方便手机浏览器直接打开。
- 桌面端界面与交互保持原版，只新增上述功能入口。

## 十一、安卓 App（新增 `ZeppPlayerAndroid/`）

不依赖 Gradle，直接用 `build.ps1` 调 aapt2 / javac / d8 / zipalign / apksigner 打包，产物为 `release/ZeppPlayer-<版本号>.apk`。

- **`MainActivity.java`（+475）**：WebView 外壳 + 文件选择器 + 下载/导出接管 + 启动错误可视化（去重、限流、自动消失），全屏 `fullSensor` 支持横竖屏切换。
- **`LocalServer.java`（+946）**：纯 Java 的本地 HTTP 服务，接口与桌面端对齐，静态资源从 APK 的 assets 读取；每个响应带版本号查询串，避免 WebView 缓存旧文件。
- **`VideoTranscoder.java`（+181）**：WebView 只能录 WebM 时，用 MediaCodec 转成 MP4。
- **`AndroidSaver.java`（+293）**：通过 MediaStore 把图片/视频写入相册（兼容 Android 10+ 分区存储）。
- **`Json.java` / `FileStorage.java` / `Saver.java` / `Storage.java`（+168）**：轻量 JSON 与存储抽象。
- **`build.ps1`（+233）**：自动同步 `AndroidManifest.xml` 的 `versionCode` / `versionName`（`versionCode = major*10000 + minor*100 + patch`），签名并输出 APK。
- **`AndroidManifest.xml`（+34）**：`INTERNET`、`WRITE_EXTERNAL_STORAGE`（≤ API 28）、`largeHeap`、`usesCleartextTraffic`。
- **`res/`**：启动图标、应用名、全屏主题。
- **`test/`（+399）**：`DevServer` 本地调试服务与 `ServerTest` 接口自测。

## 十二、其他

- `.gitignore`（+11）：排除 `/release`、安卓 `build`/`assets`/`release`/`keystore`、`*.apk`、`*.keystore`。
- `projects/demo/`：补充 `preview_mi_band7.png` 预览图与 `__wt2.txt` 测试文件。
- `package-lock.json`（+5667）：锁定新增依赖。

---

## 文件级差异清单

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `app/index.html` | +169 | 两个顶栏下拉、录屏分组、侧栏设置入口、代码面板容器、i18n 属性 |
| `app/index.css` | +1307 | 手机端布局、侧栏校准、下拉与录屏菜单、代码面板全屏 |
| `app/recording_frame.png` | 新增 | 录像外框 |
| `app/render_fail.png` | 删除 | 旧渲染失败占位图，已无引用 |
| `src/ui_managment/ViewMode.js` | +101 | 响应式视图模式判定 |
| `src/ui_managment/ToolbarManager.js` | +403 | 面板切换上移、代码面板开关、录像/截图、键盘桥、i18n |
| `src/ui_managment/ConsoleManager.js` | +183 | 控制台工具栏、日志上限、时间戳、导出 |
| `src/ui_managment/ProjectPicker.ts` | +208 | 删除项目、导入后自动选中、错误提示 |
| `src/ui_managment/VideoRecorder.js` | +340 | 录像（MP4 优先、WebM 回退） |
| `src/ui_managment/ScreenshotManager.js` | +134 | 截图（剪贴板 + 落盘 + 提示） |
| `src/ui_managment/GifRecorder.js` | 删除 | 由 VideoRecorder 取代 |
| `src/ui_managment/ChangesWatcher.js` | +51 | 重启抑制、空项目保护、异常兜底 |
| `src/ui_managment/AppSettingsManager.js` | +36 | localStorage 不可用时回退内存 |
| `src/ui_managment/ExplorerManager.js` | +29 | 运行时保护、i18n、自绘 prompt |
| `src/zepp_player/i18n.js` | +415 | 中英文词典与切换 |
| `src/zepp_player/zpDialogs.js` | +171 | alert / confirm / prompt 替代实现 |
| `src/zepp_player/zpToast.js` | +49 | 轻提示 |
| `src/zepp_player/ZeppPlayer.ts` | +49 | dispose、重启去重、app-side 加载、运行时信号 |
| `src/zepp_player/ChromeZeppPlayer.ts` | +95 | Pointer Events、坐标缩放、越界裁剪、可选文件静默 |
| `src/zepp_player/SyystemEnvironment.ts` | +10 | messaging 注入与销毁 |
| `src/zepp_player/ZeppRuntime.js` | +3 | 日志附带 scriptPath |
| `src/zepp_player/appside/AppSideManager.js` | +148 | 伴随端运行时管理 |
| `src/zepp_player/appside/AppSideRuntime.js` | +151 | app-side 沙箱执行环境 |
| `src/zepp_player/appside/ZBuffer.js` | +120 | Buffer 兼容实现 |
| `src/zepp_player/zepp_env/MessagingMock.js` | +69 | messaging / hmBle 模拟 |
| `src/ui_next/panel_code/PanelCode.tsx` | +285 | 代码面板 |
| `src/ui_next/panel_code/PanelCode.css` | +176 | 代码面板样式 |
| `src/ui_next/shortcuts/ShortcutsPane.tsx` | +81 | 快捷键面板 |
| `src/ui_next/shortcuts/ShortcutsPane.css` | +55 | 快捷键面板样式 |
| `src/ui_next/RootComponent.tsx` | +27 | 面板独立渲染容错、代码面板挂载 |
| `src/ui_next/CommandPicker.tsx` | +10 | i18n、快捷键入口 |
| `src/ui_next/ServerDirectoryPicker.tsx` | +11 | 目录切换失败提示 |
| `src/ui_next/overview/OverviewCard.tsx` | +53 | 预览图刷新、播放器释放、机型兜底 |
| `src/ui_next/overview/OverviewRoot.tsx` | +5 | i18n |
| `src/ui_next/palette/CommandPalette.tsx` | +3 | i18n |
| `src/ui_next/command_palette/getChangeProfileCommands.tsx` | +3 | i18n |
| `src/ui_next/command_palette/getChangeProjectCommands.tsx` | +3 | i18n |
| `src/ui_next/panels/prop_editor/PropEditorEntry.tsx` | +2 | 旧 WebView 兼容 |
| `src/ui_next/settings_pane/PlayerSettingsPane.tsx` | +113 | 语言切换、局域网地址、恢复默认 |
| `src/ui_next/settings_pane/CssColorOptions.tsx` | +21 | 颜色项 i18n |
| `electron_main.js` | +956 | Electron 主进程与全部后端接口 |
| `preload.js` | +23 | `zpDesktop` 桥（拖拽导入取路径等） |
| `package.json` | +46 | 版本、main、打包脚本、electron-builder 配置 |
| `package-lock.json` | +5667 | 依赖锁定 |
| `assets/icon.ico` | 新增 | Electron 应用图标 |
| `ZeppPlayerAndroid/AndroidManifest.xml` | +34 | 权限、Activity、版本号 |
| `ZeppPlayerAndroid/build.ps1` | +233 | 无 Gradle 打包脚本 |
| `ZeppPlayerAndroid/java/.../MainActivity.java` | +475 | WebView 外壳与原生交互 |
| `ZeppPlayerAndroid/java/.../LocalServer.java` | +946 | 本地 HTTP 服务 |
| `ZeppPlayerAndroid/java/.../VideoTranscoder.java` | +181 | WebM → MP4 |
| `ZeppPlayerAndroid/java/.../AndroidSaver.java` | +293 | MediaStore 保存 |
| `ZeppPlayerAndroid/java/.../Json.java` | +116 | JSON 解析/生成 |
| `ZeppPlayerAndroid/java/.../FileStorage.java` | +16 | 文件存储 |
| `ZeppPlayerAndroid/java/.../Saver.java` | +28 | 保存接口 |
| `ZeppPlayerAndroid/java/.../Storage.java` | +8 | 存储抽象 |
| `ZeppPlayerAndroid/res/**` | 新增 | 图标、应用名、主题 |
| `ZeppPlayerAndroid/test/**` | +399 | 调试服务与接口自测 |
| `.gitignore` | +11 | 构建产物与签名文件排除 |
| `README-Complete.md` | +100 | 本文件 |
| `projects/demo/preview_mi_band7.png` | 新增 | 示例项目预览图 |
| `projects/demo/__wt2.txt` | +1 | 示例项目测试文件 |

---

## 下载与安装

- 安卓：安装 `ZeppPlayerAndroid/release/ZeppPlayer-<版本号>.apk`（minSdk 24，targetSdk 34）。
- 桌面：使用 electron-builder 生成的安装包，或按下方步骤自行打包。

## 从源码构建

### 桌面端

```bash
npm install
npm run browser:build     # 打包前端到 app/
npm run dist:x64          # 生成 Windows 安装包到 release/
```

### 安卓端

需要 JDK 17、Android SDK（platform 35、build-tools 35.0.0）：

```powershell
powershell -ExecutionPolicy Bypass -File ZeppPlayerAndroid\build.ps1
```

产物为 `ZeppPlayerAndroid/release/ZeppPlayer-<版本号>.apk`，已用本地 keystore 签名。`versionCode = major*10000 + minor*100 + patch`，升级时必须递增，否则 Android 会拒绝覆盖安装。

## 与上游同步

```bash
git remote add upstream https://github.com/MelianMiko/ZeppPlayer.git
git fetch upstream
git merge upstream/main
```

## 已知限制

沿用原版：

- 无法运行以字节码形式打包的 JavaScript 源码（如 `app.bin` / `index.bin`）。
- 不支持 `side-service` 与 `settings-app` API 的完整行为，只实现设备侧与伴随端的基本通信。
- 对 ZeppOS API 的覆盖不完整，Firefox 下可能表现异常。

本版：

- 手机端针对触控压缩了布局，部分面板在窄屏下需要滚动查看。
- 安卓端 WebView 若不支持 H.264 编码，录像先以 WebM 录制再由 `VideoTranscoder` 转成 MP4，耗时略长。

## 许可证与致谢

本项目基于 **GPL-3.0** 发布，原始版权归 [MelianMiko](https://melianmiko.ru) 所有。本版同样以 GPL-3.0 分发，保留原作者版权声明，修改部分同样开源。

- 原项目：https://github.com/MelianMiko/ZeppPlayer
- 原作者主页：https://melianmiko.ru
