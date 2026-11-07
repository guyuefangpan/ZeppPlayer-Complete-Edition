# ZeppPlayer 补完版 / ZeppPlayer Complete Edition

> 基于 [MelianMiko/ZeppPlayer](https://github.com/MelianMiko/ZeppPlayer) 的非官方增强版本。**桌面端与手机端都做了大量改造**：桌面端新增代码预览/修改面板、快捷键面板、控制台工具栏、视频录制、导入导出入口、中文界面与全新的多栏布局；手机端重做响应式布局与顶栏交互；另外附带一个独立的安卓 App。

**对比基线**：上游 `melianmiko/ZeppPlayer` 的 `master` 分支，HEAD 为 `7fcd82d`（2024-05-22，`package.json` 版本 1.7.2）。

**变更规模**：共 **65 个文件**（新增 36、修改 27、删除 2），**+14779 / −802 行**；其中代码与资源 64 个文件（+14337 / −802），本文档单独计 442 行。

本文档的每一条都对应仓库中的实际 diff，可用下面两条命令复核：

```bash
git remote add upstream https://github.com/MelianMiko/ZeppPlayer.git
git fetch upstream && git diff --stat upstream/master
git diff upstream/master -- <某个文件>
```

---

## 变化总览

| 端 | 主要变化 |
| --- | --- |
| **桌面端** | 布局改为"图标栏 + 面板列 + 代码面板 + 手表画面"；新增代码预览/修改面板、快捷键面板；顶栏新增导入/打开/导出/快捷键入口；面板由独立开关改为互斥单选；控制台新增工具栏；设置面板新增语言与局域网地址；项目可删除、导入后自动选中；支持拖拽导入与浏览器 zip 导入；GIF 录制改为视频录制；新增截图；输入法下快捷键仍可用；启动流程容错与画布自适应；Electron 主进程、preload 桥与打包配置 |
| **手机端** | 响应式视图判定、竖屏/横屏两套布局；顶栏面板与文件合并为两个下拉；录屏与截图合并为向右展开；侧栏 12 键尺寸与间距校准、三个分区；代码面板改为全屏浮层；设置入口移到侧栏；触控改用 Pointer Events；独立安卓 App |
| **模拟器内核** | app-side（伴随端）运行时与进程内虚拟链路、messaging/hmBle 模拟、播放器 `dispose()` 与重启去重、日志附带脚本路径 |
| **国际化** | 新增中英双语词典（322 条词条），默认中文，全界面可切换 |

---

# 一、桌面端

## 1.1 布局：从"画面 + 右侧面板"改为四栏

原版桌面是 `图标栏 | 手表画面 | 面板（.bigscreen）`，面板只是画面右侧的一块附加区域。本版把 `app/index.html` 的面板容器移出 `.bigscreen`，变成固定的 `.left_panel`，并在画面左侧新增常驻代码面板：

```
[图标栏 #toolbar_side] [面板列 .left_panel] [代码面板 #code_panel] [手表画面 .display_base]
```

- **面板列**（`app/index.css` `.left_panel`）：宽 300px（260–340 自适应），三个面板互斥显示，高度 `calc(100vh - 176px)`，可独立滚动。
- **代码面板**（`.code_panel`）：`flex: 1 1 46%`，宽 320–640px，高 `calc(100vh - 130px)`，带圆角与阴影。
- **画面区**（`.display_base`）：固定宽度卡片，独立内边距、背景与阴影，不再被面板挤压。
- `.root` 改为 `display:flex; gap:8px; justify-content:center`，代码面板与画面作为一个整体居中。

> 这一步是手机端能复用面板的前提：面板不再依赖 `.bigscreen` 的桌面断点。

## 1.2 代码预览 / 修改面板（原版完全没有）

原版桌面**没有任何查看或修改项目源码的入口**，只能去外部编辑器打开项目目录。本版新增 `src/ui_next/panel_code/`（`PanelCode.tsx` +285、`PanelCode.css` +176），由 `RootComponent.tsx` 挂载到 `#code_panel`，常驻显示。

- **文件树**：从当前项目根目录逐层抓取目录列表（最多 5 层），跳过 `node_modules`、`.git`、`.idea`、`.vs`、`.vscode`、`__pycache__`、`dist`，只列出 `.js`、`.ts`、`.json`、`.css`、`.html`、`.wml`、`.txt`、`.md`；目录与文件分别排序，缩进按层级（每层 14px）。
- **打开文件**：点击文件 `GET` 读取文本到 `textarea`，关闭拼写检查；桌面端 `wrap="off"`，手机端 `wrap="soft"`。
- **编辑**：`Tab` 插入 2 个空格并保持光标位置（`requestAnimationFrame` 内恢复选区）。
- **保存并重载**：`PUT` 写回文件；成功后调用 `ChangesWatcher.hold(1800)` 抑制文件监听，再 `player.restart()` 重载预览，避免"保存一次、重启两次"。
- **快捷键**：`Ctrl+S` 由 `ToolbarManager` 全局处理（编辑器内只 `preventDefault`），因此输入法组合输入时也能保存。
- **自动跟随当前页面**：监听 `player.onRuntimeChanged`，模拟器切到某个页面时自动打开该页面的 `scriptPath`；用户手动点过文件后停止跟随，并在路径旁显示"手动跟随"标记（`code.manualFollow`）。
- **从控制台跳转**：`window.zpOpenCodeFile(scriptPath)` 按 URL 后缀匹配文件并打开；手机上同时调用 `zpOpenCode()` 弹出全屏面板。
- **状态反馈**：加载失败、保存失败、保存成功都有行内状态行（`zpc__status`）。
- **空状态**：项目未加载时每 600ms 轮询 `projectPath`，就绪后立即建树；`onProjectChanged` 时重建。
- **未保存提示**：`content !== orig` 视为 dirty（仅用于状态判断，不阻塞切换）。

## 1.3 快捷键面板（原版完全没有）

新增 `src/ui_next/shortcuts/`（`ShortcutsPane.tsx` +81、`ShortcutsPane.css` +55），三组快捷键以 `<kbd>` 卡片列出：

| 分组 | 快捷键 |
| --- | --- |
| 播放 | `1` 普通 UI、`2` AOD、`3` 表盘编辑、`P` 暂停、`Shift+S` 自动递增、`Shift+Z` 事件区域、`Shift+W` 恢复出厂 |
| 面板 | `c` 控制台、`e` 控件修改、`x` 资源管理器、`Esc` 返回、`Ctrl+P` 命令面板、`F1` / `?` 本面板 |
| 项目 | `+` 下一个、`_` 上一个、`Ctrl+S` 保存代码、`Ctrl+Alt+S` 截图、`Ctrl+Alt+Shift+S` 截图到项目、`R` 重启 |

入口：顶栏 `keyboard` 图标、`F1` / `?`、命令面板新增的 "Shortcuts" 项。

## 1.4 顶栏入口与面板互斥

`app/index.html` 顶栏新增四个桌面按钮（原版只能通过命令面板完成）：

| 按钮 | 图标 | 行为 |
| --- | --- | --- |
| 导入项目 | `upload_file` | `zpImportProject()` |
| 打开项目文件夹 | `folder_open` | `zpOpenProjects()` |
| 导出项目 | `archive` | `zpExportProject()` |
| 快捷键 | `keyboard` | `_setReactPane('shortcuts')` |

这些按钮都带 `.zp-desktop-only`，手机端由 CSS 隐藏（手机端走合并后的下拉）。

**面板切换语义改变**：原版 `toggle_console` / `toggle_edit` / `toggle_explorer` 是三个独立开关（`panelConsoleVisible` 等，可同时打开多个），本版改为互斥单选：

- 逻辑提升到模块作用域的 `window.zpPanelTab(panelId, el)`，即使启动流程后面失败，顶栏按钮仍可用。
- 当前面板写入 `AppSettingsManager` 的 `activePanel`，重启后恢复。
- 同时同步手机下拉的图标与菜单高亮。
- 图标修正：资源管理器由字体中不存在的 `explorer` 字形改为真实存在的 `account_tree`（原字形缺失会渲染成乱码方块）。

## 1.5 控制台工具栏

`ConsoleManager.js`（+160/−23）重写为"工具栏 + 可滚动输出区"：

- 工具栏四个动作：`delete_sweep` 清空、`content_copy` 复制全部、`download` 导出日志、`vertical_align_bottom` 自动滚动开关（默认开）。
- **条目上限 3000**（`MAX_ENTRIES`），超出后从头部丢弃，DOM 与内存数组同步裁剪。
- 每条日志记录 `{text, scriptPath}`；文本格式 `[level] runtimeID 内容`，`runtimeID` 形如 `SL:1`。
- **带 `scriptPath` 的行可点击**，直接跳到代码面板对应文件（hover 有提示）。
- **导出**：桌面/安卓走 `POST /api/save_text`，文件名为 `console_YYYYMMDD-HHmmss.log`；纯浏览器没有原生保存对话框，改为 Blob 下载同名文件。
- 复制/导出结果用轻提示反馈，失败时把错误信息一并弹出。

## 1.6 设置面板

`PlayerSettingsPane.tsx`（+98/−15）在原有开关之外新增：

- **语言选择**：中文 / English，写入 `zp_lang` 后重新加载页面生效（`I18n.setLanguage` + `location.reload`）。
- **局域网访问地址**：读取 `/api/server_info`，显示 `urls[0]`（回退 `http://127.0.0.1:<port>/`），一键复制；`mobile: true` 时（APK 自身运行）整项隐藏。
- **恢复默认设置**：原来 `localStorage.clear()` 会把语言、设备型号、当前项目一起清掉；现在只清理 `zp_*` / `zepp_player_*`，并显式保留 `zp_lang`、`zp_profile_name`、`zepp_player_last_project`、`zepp_player_rotation`、`zp_activePanel` 五个键。
- 全部文案改为 `I18n.t()`。

## 1.7 项目选择器：删除、导入后自动选中

`ProjectPicker.ts`（+168/−40）整体重写：

- **`refreshOptions(preferredUrl?)`**：可重复调用，清空并重建 `<option>`，返回最终选中的 URL；优先 `preferredUrl`（支持 `/projects/name` 前缀匹配），其次上次项目，最后第一个可用项目。
- **永远停在真实项目上**：新增 `isRealProject()`，以 `<` 开头的伪选项（打开文件夹 / 切换目录 / 删除项目）不会被当成当前项目。
- **删除项目**：列表底部新增"删除项目"，`zpConfirm` 二次确认后 `POST /api/delete_project`，删除磁盘目录并刷新列表；如果还有项目则自动切到下一个，没有则重载页面。
- **导入后自动选中**：导入回调调用 `refreshOptions(name)` + `applyProjectUrl()`，不再 `location.reload()`，导入完立即开始预览。
- **错误反馈**：打开文件夹、切换目录、打开项目、删除项目失败都会 `zpAlert` 具体原因，而不是静默失败或刷新。
- **切换失败兜底**：`applyProjectUrl` 内部 `try/catch`，失败时提示并保留原项目。

## 1.8 导入、导出与拖拽

`src/index.browser.js`（+487/−27）按运行环境分流：

- **导入**
  - 桌面（`window.zpDesktop` 存在）：`GET /api/import_project?lang=<locale>`，弹原生目录/文件对话框。
  - 纯浏览器 / 手机：动态创建 `<input type=file accept=".zip">`，`POST /api/import_zip_upload`（`X-File-Name` 传文件名，body 为 zip 二进制）。
  - 拖拽：整窗监听 `dragenter/dragover/dragleave/drop`，显示 `#zp_drop_overlay` 遮罩；用 preload 暴露的 `zpDesktop.getPathForFile()` 拿到真实路径，`POST /api/import_path`。
- **导出**
  - 桌面：`POST /api/export_project`，服务端弹保存对话框。
  - 安卓：先 `POST /api/export_project {dest:"ask"}` 打包到缓存，再 `zpAndroid.exportFileToUser(cachePath, name)` 交给系统文件选择器；结果由 `zpAndroidExportResult(requestId, status, detail)` 回调提示成功/取消/失败。
  - 纯浏览器：直接跳 `/api/download_project?projectUrl=...` 下载。
- **导入完成统一走 `afterImport()`**：刷新列表 → 选中新项目 → 轻提示；只有刷新失败才回退到整页重载。

## 1.9 录制与截图

- **GIF → 视频**：删除 `GifRecorder.js`（−90），新增 `VideoRecorder.js`（+340）。
  - 首次点击开始、再次点击停止并保存；录制中按钮图标变为 `stop_circle`，手机端合并按钮同步。
  - 编码优先 `video/mp4;codecs=avc1.42E01E` → `video/mp4` → `video/webm;codecs=vp8` → `vp9` → `webm`。
  - 30 fps；码率在 1.5–4 Mbps 之间按画布尺寸自适应。
  - **外框合成**：新增 `app/recording_frame.png`（330×948，屏幕开孔 207×526，位于 (61,202)），把手表画布合成为实拍表壳效果；`mi_band7` 画面比例 192:490 与开孔匹配。
  - 安卓端若只能录出 WebM，先提示"正在转成 MP4"，由 `VideoTranscoder.java` 转码；转码失败才提示已保存为 WebM。
- **截图**：新增 `ScreenshotManager.js`（+134）。
  - 截取 `#display` 画布为 PNG，复制到剪贴板（`ClipboardItem`，失败不影响落盘）。
  - 落盘：桌面走 `/api/save_preview`，可选"图片目录"或"当前项目"；浏览器/安卓用 Blob 下载。
  - 文件名 `${项目名|screenshot}_${设备型号}_${YYYYMMDD-HHmmss}.png`；写入项目后调用 `ChangesWatcher.hold()` 避免触发重启。
- 删除 `app/render_fail.png`（旧渲染失败占位图，已无引用）。

## 1.10 键盘：输入法下仍可用、只触发一次

`ToolbarManager.js`（+326/−77）重写了整个按键处理：

- **输入法问题**：微软拼音等 CJK 输入法组合输入时，渲染进程只能收到 `keyCode 229` / `key: "Process"`，页面监听拿不到真实按键。`electron_main.js` 用 `before-input-event`（在渲染进程处理之前触发）把物理按键通过 IPC `zp-key-event` 转发，preload 暴露 `zpDesktop.onKeyEvent()`，渲染端优先使用这份事件。
- **去重**：同一次物理按键可能同时到达 DOM 与主进程两条链路；按 `token + 修饰键` 生成签名，150ms 内相同签名只执行一次（`repeat` 事件直接忽略）。
- **规范化**：`e.code`（`KeyA` / `Digit1` / `Equal` / `Minus` / `Slash` / `Escape` / `F1`）优先，`e.key` 兜底，统一成小写字母、数字与符号 token，规避大小写与键盘布局差异。
- **作用域保护**：`INPUT` / `TEXTAREA` / `SELECT` / `contentEditable` 内不触发单键；有 `.ui-backdrop__visible` 模态时屏蔽单键；`Ctrl/Cmd/Alt` 组合除明确列出的以外一律放行给系统（`Ctrl+C`、`Alt+Tab` 等）。
- **`Esc` 优先级**：关闭代码面板 → 关闭浮层 → 退出输入框（`blur`）→ 返回上一页。
- **全局快捷键**（输入框内也生效）：`Ctrl+Alt+S` 截图（加 `Shift` 存到项目）、`Ctrl+P` 命令面板、`Ctrl+S` 保存代码。
- **空状态保护**：重启、返回、暂停、旋转、滚动、切换项目、模式切换都加了 `player` / `currentRuntime` / `projectPath` 判空；非表盘项目按 `1/2/3` 会提示"仅表盘支持"而不是报错。
- **项目切换**：`+` / `-` 改为循环切换，并跳过以 `<` 开头的伪选项。

## 1.11 启动流程容错与画布自适应

`src/index.browser.js` 的 `start()` 从"顺序 await、任何一步失败就白屏"改为分步隔离：

- 先创建 `ChromeZeppPlayer` 并立刻设置画布尺寸，再执行后续异步步骤。
- 每一步单独 `try/catch`：视图模式、拖拽、设置加载、React UI、项目列表（8s 超时）、工具栏、控制台、资源管理器。
- **字体后台加载**：`FontFace` 不再 `await`，字体慢或失败不影响启动。
- **无项目不再崩**：项目目录为空时提示"当前目录没有项目"，界面照常可用。
- 非致命问题汇总后通过 `window.__zpReport` 一次性上报（安卓端显示在底部浮层），没有 DevTools 也能定位。
- 末尾 `I18n.apply(document)` 统一翻译静态 DOM，`start().catch()` 兜底。
- **画布自适应** `fitDisplayCanvas()`：手机端按实际可用格子计算 CSS 缩放（保持画布原生分辨率，上限 3 倍），`resize` 节流 160ms、`orientationchange` 延迟 320ms，渲染循环检测到画布尺寸变化时重新适配；桌面端清空内联尺寸。

## 1.12 Electron 主进程与打包

- **`electron_main.js`（新增，+956）**
  - 本地 HTTP 服务监听 `0.0.0.0`（同 Wi-Fi 的手机可直接打开响应式界面），端口被占用时 `EADDRINUSE` 自动尝试下一个。
  - 窗口 1180×820、`autoHideMenuBar`、自定义图标、`backgroundThrottling:false`（窗口被遮挡时录制不冻结）。
  - `contextIsolation:true` + `nodeIntegration:false` + preload 桥。
  - 原生文件/目录对话框；zip 解压优先 `bsdtar`，PowerShell `Expand-Archive` 兜底；目录导出为 zip。
  - 导入时识别"压缩包内多套一层目录"。
  - 应用托管目录首次启动播种内置示例项目（用户自选目录不播种）。
  - `/projects` 前缀剥离后做路径穿越校验。
  - `/api/server_info` 枚举局域网地址。
  - `before-input-event` 转发按键（见 1.10）。
- **`preload.js`（新增，+23）**：`contextBridge` 暴露 `zpDesktop.isDesktop`、`getPathForFile`（`webUtils`）、`onKeyEvent`。
- **`package.json`（+43/−3）**：版本 1.7.2 → 1.8.14，`main` 指向 `electron_main.js`；新增 `dist:x64` / `dist:ia32` / `dist` 脚本与 electron-builder 配置（NSIS、可选安装目录、桌面与开始菜单快捷方式、`assets/icon.ico`）；新增 `electron`、`electron-builder` 依赖。
- **接口清单**（桌面与安卓一致）：`/api/list_projects`、`/api/import_project`、`/api/import_zip_upload`、`/api/import_path`、`/api/delete_project`、`/api/export_project`、`/api/download_project`、`/api/open_projects`、`/api/choose_projects_dir`、`/api/set_projects_dir`、`/api/folder_chooser`、`/api/save_preview`、`/api/save_text`、`/api/change_count`、`/api/watch`、`/api/server_info`。

---

# 二、手机端

## 2.1 视图模式判定

`ViewMode.js`（新增，+101）：

- `?zp_view=portrait|landscape|desktop` 可强制模式，便于无真机预览。
- 否则按 `min(innerWidth, screen.width) <= 900` 判定手机；宽高比决定竖屏/横屏；安卓 App 内直接按宽高比判定（规避部分 WebView 把布局宽度当成桌面宽度）。
- 结果写到 `<body>`：`zp-mobile` / `zp-portrait` / `zp-landscape`，并设 `data-zp-view`。
- 同时写入 CSS 变量 `--zp-vh`（`dvh` 兜底）与 `--zp-content-h`（扣除顶栏与页脚后的内容高度）。
- `resize` 120ms 防抖、`orientationchange` 250ms、`visualViewport.resize` 也会重新计算。
- 导出 `isMobileView()` / `isDesktopShell()` / `isAndroidApp()` / `triggerDownload()` 供各处共用。

## 2.2 竖屏与横屏

- **竖屏**：`body.zp-mobile .player_root` 改为 CSS Grid，两行两列：
  ```
  "tools console"
  "tools display"
  ```
  图标栏独占左列，控制台在上、画面在下。
- **横屏**：控制台占左半屏、手表占右半屏，画面拿到整屏高度，解决原版"控制台把屏幕挤到下面"的分配问题。
- 页面本身不纵向滚动，每个面板在自己的盒子内滚动。

## 2.3 顶栏：两个下拉

- **面板下拉** `#zp_split_panels`：控制台 / 控件修改 / 资源管理器 / 代码修改四项，默认只显示当前面板图标；右下角有小三角提示，避免看起来和普通图标一样。
- **文件下拉** `#zp_split_files`：导入项目 / 导出项目 / 项目文件夹。
- **交互实现**（`src/index.browser.js`）：`zpSplitToggle` / `zpSplitPanel` / `zpSplitCode` / `zpSplitFile`；菜单用视口坐标定位（`getBoundingClientRect` + 边界夹取），因此不会被顶栏横向滚动容器裁切；`pointerdown` 点外部关闭、侧栏滚动关闭、窗口 `resize` 关闭、同一时间只开一个。
- **滚动拆分**：`#toolbar_top` 改为 `overflow:hidden`，新增 `#toolbar_top > .tools` 作为独立横向滚动容器，项目/设备选择固定不动。
- 两个下拉在设备选择器右侧剩余空间内用 `margin:auto` 居中，空间不足时自动收缩为 0，首个按钮不会被裁掉。

## 2.4 侧栏：分组与校准

- **12 个按钮统一 32×32**（含内边距，`box-sizing:border-box`）、内边距 0、flex 居中。原版是 content-box，按钮实际 40px 宽却塞在 36px 列里，右侧被裁、图标与选中遮罩都偏。
- **选择器优先级修复**：`#toolbar_side.watchface > .btn_wf { display:block }` 会压过无 ID 的 flex 居中规则，导致三个表盘按钮图案贴左上；按应用类型分别补 `#toolbar_side.watchface > .btn_wf` 等规则。
- **分区**：三个功能区之间加大间距（对称 6px），淡灰分隔线在间隙中居中。
- **顶部三键**（暂停/重播/录屏）单独用 36px 步进 + 更大字号，让视觉节奏与下方一致；下方按钮步进 40px。
- **录屏/截图分组** `#zp_split_capture`：合并为一个按钮，点击向右展开；弹出层以切换按钮垂直中心对齐（原来是顶对齐，看起来偏低），距图标栏 6px，按钮间距 10px，去掉淡灰底色遮罩改为纯图标；触摸设备禁用残留 `:hover` 遮罩。
- **设置入口**：顶栏设置按钮在手机端隐藏，侧栏新增 `tune` 图标的 `#toggle_app_settings`，与表盘设置（齿轮）区分。

## 2.5 代码面板全屏

`window.zpOpenCode()` / `zpCloseCode()` 切换 `body.zp-code-open`：手机端代码面板变成全屏浮层（隐藏时仍挂载，编辑内容不丢），文件树变成抽屉，选中文件后自动收起，编辑器占满屏幕宽度。

## 2.6 触控

`ChromeZeppPlayer.ts`（+58/−37）：

- 鼠标事件改为 Pointer Events，鼠标/触控笔/手指共用一条路径；`setPointerCapture` 保证拖出画布仍能收到 `pointerup`。
- 画布被 CSS 缩放时，把 CSS 像素按 `canvas.width / rect.width` 映射回画布像素，并按旋转角换算，最后裁剪到画布范围内。
- `touch-action:none` 关闭浏览器手势，长按不再弹上下文菜单（`contextmenu` 也 `preventDefault`）。
- 运行时为空（项目加载中或启动失败）时忽略点击，不再报 "handleEvent of null"。

---

# 三、模拟器内核

- **app-side（伴随端）运行时**（新增 `src/zepp_player/appside/`，+419）
  - `AppSideManager`：随项目加载 `app-side.js`，维护 `appId`、会话、持久化存储与设备侧接收者集合；用进程内 `VirtualLink` 取代真实蓝牙端点 `0x00a0`。
  - `AppSideRuntime`：独立沙箱注入 `console`、`setTimeout`、`settings` 等，`onConsole` 转发到主控制台。
  - `ZBuffer`：Node `Buffer` 常用方法的兼容实现（`from` / `alloc` / `readUInt*` / `writeUInt*` / `toString` 等）。
- **messaging / hmBle 模拟**（`zepp_env/MessagingMock.js`，+69）：设备侧 `messaging` 调用路由到 `AppSideManager`；没有伴随端时为空操作，旧版 `app.js` 不受影响；页面运行时销毁时自动移除监听。
- **`SyystemEnvironment.ts`**：`createPageEnv` 注入 `messaging`，并在 `runtime.onDestroy` 上注册释放回调。
- **播放器生命周期**（`ZeppPlayer.ts`，+45/−4）
  - 新增 `dispose()`：清掉秒定时器并 `finish()`，供概览卡片等短生命周期播放器使用。
  - `restart()` 去重：文件监听、保存、工具栏可能同时请求重启，重入会留下没有 runtime 的播放器；现在用 `_restarting` 锁，失败时再 `init()` 做一次恢复。
  - 新增 `onRuntimeChanged` 信号（代码面板跟随页面用）。
  - `setProject` 末尾 `appSideManager.loadProject(path)`。
  - `_finishCurrentRuntime` 判空。
- **日志来源**（`ZeppRuntime.js`，+2/−1）：`onConsole` 附加 `scriptPath`，供控制台跳转与代码面板跟随。
- **可选文件探测**：`ChromeZeppPlayer.loadFile(path, quiet)`，探测 `app-side.js` 不存在时不再报致命错误。

---

# 四、多语言

- 新增 `src/zepp_player/i18n.js`（+415）：内置中文/英文词典共 322 条词条，默认中文（`detectDefault()`），`localStorage.zp_lang` 持久化。
- `I18n.apply(root)` 扫描 `data-i18n` / `data-i18n-title` 替换文本与 `title`；`I18n.t(key, fallback)` 供 JS/TSX 使用。
- 覆盖范围：顶栏与侧栏提示、面板名、文件操作、项目选择器、控制台工具栏、资源管理器、设置面板、命令面板、概览页、代码面板、快捷键面板、对话框、轻提示、启动提示。
- 颜色设置项（`CssColorOptions.tsx`）从硬编码英文改为词条键。

---

# 五、健壮性修复

- **localStorage 兜底**（`AppSettingsManager.js`，+29/−7）：隐私模式或受限 WebView 中 `localStorage` 会抛异常；改为"内存优先 + localStorage 尽力写入"，读取失败回退内存，JSON 解析失败回退默认值。
- **自动重启抑制**（`ChangesWatcher.js`，+37/−14）：新增 `hold(ms)`；没有项目时不启动监听；接口异常只告警不抛错；重启失败不冒泡。
- **资源管理器**（`ExplorerManager.js`，+21/−8）：无视图/无运行时直接返回；文案国际化；属性编辑改用自绘 `zpPrompt`；定时器列表在 `env.timer` 缺失时安全退出。
- **面板渲染容错**（`RootComponent.tsx`，+24/−3）：`RootComponent`、`PropEditorPanel`、`PanelCode` 三次 `render` 各自 `try/catch`，单个面板出错不会整页白屏。
- **旧 WebView 兼容**（`PropEditorEntry.tsx`）：`replaceAll` 改为 `split/join`。
- **自绘对话框**（`zpDialogs.js`，+171）：Electron 渲染进程不支持 `prompt()`，`confirm()` 也不可靠；改为 DOM 覆盖层实现 `zpAlert` / `zpConfirm` / `zpPrompt`，支持 `Esc` 取消、`Enter` 确认、点击遮罩取消。
- **轻提示**（`zpToast.js`，+49）：底部居中、`pointer-events:none`，用于截图、录制、控制台、导入导出、删除项目等反馈。
- **目录切换失败**（`ServerDirectoryPicker.tsx`，+10/−1）：显示服务端返回的具体原因。
- **概览页**（`OverviewCard.tsx`，+39/−14）：播放器实例用 `ref` 复用并在卸载时 `dispose()`；未选设备时回退 `mi_band7`；预览图重建后追加时间戳刷新 `<img>`（原来图片加载失败后不会再更新）；重建加锁防止并发。

---

# 六、安卓 App（新增 `ZeppPlayerAndroid/`）

不依赖 Gradle，`build.ps1` 直接调 aapt2 / javac / d8 / zipalign / apksigner 打包，产物 `release/ZeppPlayer-<版本号>.apk`，当前版本 **1.10.22**。

- **`MainActivity.java`（+475）**：WebView 外壳 + 文件选择器 + 下载/导出接管 + 启动错误可视化（去重、限流、自动消失）；`fullSensor` 支持横竖屏；`zpAndroid` 原生桥。
- **`LocalServer.java`（+946）**：纯 Java 本地 HTTP 服务，接口与桌面端对齐，静态资源从 APK assets 读取；每个响应带版本号查询串，避免 WebView 缓存旧文件。
- **`VideoTranscoder.java`（+181）**：WebView 只能录 WebM 时，用 MediaCodec 转成 MP4。
- **`AndroidSaver.java`（+293）**：通过 MediaStore 把图片/视频写入相册（兼容 Android 10+ 分区存储）。
- **`Json.java` / `FileStorage.java` / `Saver.java` / `Storage.java`（+168）**：轻量 JSON 与存储抽象。
- **`build.ps1`（+233）**：同步 `AndroidManifest.xml` 的 `versionCode` / `versionName`（`versionCode = major*10000 + minor*100 + patch`），注入 `__ZP_VERSION__` 缓存标记，签名并输出 APK。
- **`AndroidManifest.xml`（+34）**：`INTERNET`、`WRITE_EXTERNAL_STORAGE`（≤ API 28）、`largeHeap`、`usesCleartextTraffic`。
- **`res/`**：启动图标、应用名、全屏主题。
- **`test/`（+399）**：`DevServer` 本地调试服务与 `ServerTest` 接口自测。

---

# 七、其他

- `.gitignore`（+11）：排除 `/release`、安卓 `build`/`assets`/`release`/`keystore`、`*.apk`、`*.keystore`。
- `projects/demo/`：补充 `preview_mi_band7.png` 预览图与 `__wt2.txt` 测试文件。
- `package-lock.json`（+5543/−124）：锁定新增依赖。
- 样式主体集中在 `app/index.css`（+1056/−251）与 `app/index.html`（+126/−43）。

---

# 八、文件级差异清单

| 文件 | 增/删 | 说明 |
| --- | --- | --- |
| `app/index.html` | +126 / −43 | 顶栏新增导入/打开/导出/快捷键按钮；两个手机下拉；录屏/截图分组；侧栏设置入口；代码面板容器；面板移出 `.bigscreen`；`data-i18n` 属性；拖拽遮罩 |
| `app/index.css` | +1056 / −251 | 桌面四栏布局；代码面板；控制台工具栏；拖拽遮罩；手机竖屏/横屏网格；顶栏下拉；侧栏 12 键校准与分区；录屏弹层；代码面板全屏与抽屉 |
| `app/recording_frame.png` | 新增 | 录像手表外框（330×948，开孔 207×526） |
| `app/render_fail.png` | 删除 | 旧渲染失败占位图，已无引用 |
| `src/index.browser.js` | +487 / −27 | 画布自适应；手机下拉交互；导入/导出环境分流；拖拽导入；导入后自动选中；启动分步容错与告警上报 |
| `src/ui_next/panel_code/PanelCode.tsx` | +285 | 代码面板：文件树、编辑、保存重载、跟随页面、控制台跳转 |
| `src/ui_next/panel_code/PanelCode.css` | +176 | 代码面板基础样式（头部、文件树、编辑器、状态行）；手机全屏样式在 `app/index.css` |
| `src/ui_next/shortcuts/ShortcutsPane.tsx` | +81 | 快捷键面板 |
| `src/ui_next/shortcuts/ShortcutsPane.css` | +55 | 快捷键面板样式 |
| `src/ui_next/RootComponent.tsx` | +24 / −3 | 面板独立渲染容错；挂载代码面板；新增快捷键面板 |
| `src/ui_next/CommandPicker.tsx` | +7 / −3 | i18n；新增 Shortcuts 命令 |
| `src/ui_next/ServerDirectoryPicker.tsx` | +10 / −1 | 目录切换失败提示 |
| `src/ui_next/overview/OverviewCard.tsx` | +39 / −14 | 预览图强制刷新、播放器复用与释放、机型兜底、重建加锁 |
| `src/ui_next/overview/OverviewRoot.tsx` | +3 / −2 | i18n |
| `src/ui_next/palette/CommandPalette.tsx` | +2 / −1 | 过滤框占位文案 i18n |
| `src/ui_next/command_palette/getChangeProfileCommands.tsx` | +2 / −1 | i18n |
| `src/ui_next/command_palette/getChangeProjectCommands.tsx` | +2 / −1 | i18n |
| `src/ui_next/panels/prop_editor/PropEditorEntry.tsx` | +1 / −1 | 旧 WebView 兼容（`replaceAll` → `split/join`） |
| `src/ui_next/settings_pane/PlayerSettingsPane.tsx` | +98 / −15 | 语言切换、局域网地址复制、恢复默认时保留关键设置 |
| `src/ui_next/settings_pane/CssColorOptions.tsx` | +11 / −10 | 颜色项 i18n |
| `src/ui_managment/ToolbarManager.js` | +326 / −77 | 面板互斥切换、代码面板开关、视频/截图、键盘桥与去重、快捷键作用域、空状态保护、循环切换项目 |
| `src/ui_managment/ConsoleManager.js` | +160 / −23 | 控制台工具栏、3000 条上限、复制/导出、点击跳转代码 |
| `src/ui_managment/ProjectPicker.ts` | +168 / −40 | 删除项目、导入后自动选中、可重复刷新、错误提示 |
| `src/ui_managment/VideoRecorder.js` | +340 | 视频录制（MP4 优先、WebM 回退、外框合成） |
| `src/ui_managment/ScreenshotManager.js` | +134 | 截图（剪贴板 + 落盘 + 提示） |
| `src/ui_managment/GifRecorder.js` | −90 | 由 VideoRecorder 取代 |
| `src/ui_managment/ViewMode.js` | +101 | 响应式视图判定、CSS 变量、环境探测、下载助手 |
| `src/ui_managment/ChangesWatcher.js` | +37 / −14 | `hold()` 抑制、空项目保护、异常兜底 |
| `src/ui_managment/AppSettingsManager.js` | +29 / −7 | localStorage 不可用时回退内存 |
| `src/ui_managment/ExplorerManager.js` | +21 / −8 | 运行时保护、i18n、自绘 prompt |
| `src/zepp_player/i18n.js` | +415 | 中英词典（322 条）与切换 |
| `src/zepp_player/zpDialogs.js` | +171 | alert / confirm / prompt 替代实现 |
| `src/zepp_player/zpToast.js` | +49 | 非阻塞轻提示 |
| `src/zepp_player/ZeppPlayer.ts` | +45 / −4 | `dispose()`、重启去重与恢复、`onRuntimeChanged`、加载 app-side |
| `src/zepp_player/ChromeZeppPlayer.ts` | +58 / −37 | Pointer Events、坐标缩放与裁剪、静默探测、空运行时保护 |
| `src/zepp_player/SyystemEnvironment.ts` | +9 / −1 | 注入 messaging 并在销毁时释放 |
| `src/zepp_player/ZeppRuntime.js` | +2 / −1 | 日志附带 `scriptPath` |
| `src/zepp_player/appside/AppSideManager.js` | +148 | 伴随端运行时管理与虚拟链路 |
| `src/zepp_player/appside/AppSideRuntime.js` | +151 | app-side 沙箱执行环境 |
| `src/zepp_player/appside/ZBuffer.js` | +120 | Buffer 兼容实现 |
| `src/zepp_player/zepp_env/MessagingMock.js` | +69 | messaging / hmBle 模拟 |
| `electron_main.js` | +956 | Electron 主进程、全部后端接口、按键转发、局域网地址、示例播种 |
| `preload.js` | +23 | `zpDesktop` 桥（拖拽路径、按键事件） |
| `package.json` | +43 / −3 | 版本 1.8.14、`main`、打包脚本、electron-builder 配置 |
| `package-lock.json` | +5543 / −124 | 依赖锁定 |
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
| `README-Complete.md` | 新增 | 本文件 |
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
git merge upstream/master
```

改动集中在 `app/`、`src/ui_managment/`、`src/ui_next/`、`src/zepp_player/`、`src/index.browser.js`、`electron_main.js`、`preload.js`、`package.json` 与 `ZeppPlayerAndroid/`，合并冲突一般只出现在这些文件。

## 已知限制

沿用原版：

- 无法运行以字节码形式打包的 JavaScript 源码（如 `app.bin` / `index.bin`）。
- 不支持 `side-service` 与 `settings-app` API 的完整行为，只实现设备侧与伴随端的基本通信。
- 对 ZeppOS API 的覆盖不完整，Firefox 下可能表现异常。

本版：

- 代码面板是纯文本编辑器，没有语法高亮与自动补全。
- 手机端针对触控压缩了布局，部分面板在窄屏下需要滚动查看。
- 安卓端 WebView 若不支持 H.264 编码，录像先以 WebM 录制再由 `VideoTranscoder` 转成 MP4，耗时略长。

## 许可证与致谢

本项目基于 **GPL-3.0** 发布，原始版权归 [MelianMiko](https://melianmiko.ru) 所有。本版同样以 GPL-3.0 分发，保留原作者版权声明，修改部分同样开源。

- 原项目：https://github.com/MelianMiko/ZeppPlayer
- 原作者主页：https://melianmiko.ru
