# ZeppPlayer 补完版 / ZeppPlayer Complete Edition

> 基于 [MelianMiko/ZeppPlayer](https://github.com/MelianMiko/ZeppPlayer) 的非官方增强版本：桌面端保持原样，重点补齐手机端体验，并附带可直接安装的安卓 App。

在原版 ZeppPlayer（非官方 ZeppOS 模拟器）的基础上，本版把"在手机上预览表盘/应用"这条链路补齐了：顶栏与侧栏重新组织、面板切换与文件操作合并为下拉、横竖屏分别布局，安卓端则以独立 App 形式运行同一套前端。桌面端的功能与界面与原版保持一致，只增加了项目删除和导入后自动选中。

---

## 相比原版的变化

### 新增

| 能力 | 说明 |
| --- | --- |
| 手机端界面 | 新增响应式视图模式判定（`src/ui_managment/ViewMode.js`），按窗口宽高比与设备类型写入 `zp-mobile` / `zp-portrait` / `zp-landscape`，竖屏与横屏各有一套布局；横屏为左侧控制台、右侧屏幕 |
| 顶栏面板下拉 | 控制台、控件修改、资源管理器、代码修改四个按钮合并为一个下拉，默认只显示当前面板图标，右下角带小三角提示可展开 |
| 顶栏文件下拉 | 导入项目、导出、打开文件夹三个按钮合并为一个下拉 |
| 录屏 / 截图分组 | 侧栏的两个按钮合并为一个，点击后向右展开录像与拍照两个选项，不再占两行 |
| 删除项目 | 项目选择器底部新增删除操作，桌面端与安卓端后端均新增 `POST /api/delete_project` |
| 导入后自动选中 | 导入项目（文件夹 / zip / 路径）完成后直接追加到列表并切换到该项目，不再整页刷新 |
| 安卓 App | `ZeppPlayerAndroid` 工程：Java 实现的本地 HTTP 服务 + WebView 运行同一套前端，可打包为独立 APK |
| 启动诊断 | 安卓端启动异常会直接绘制在页面上（去重、限流、自动消失），手机上没有 DevTools 也能看到原因 |
| 手机端设置入口 | 顶栏设置按钮移到侧栏，使用 `tune` 图标，与表盘设置（齿轮）区分 |

### 手机端界面调整

- 顶栏：项目 / 设备选择保持固定，只有工具区横向滚动，避免整条顶栏被推走。
- 手机端隐藏预览图概览、快捷键查看、顶栏设置按钮，减少顶栏拥挤。
- 侧栏 12 个按钮统一为 32×32 盒模型，图标与选中态深灰遮罩全部居中（原版部分按钮存在图标偏左上、遮罩与按钮错位的问题）。
- 侧栏按三个功能区分组，区域之间间距加大，淡灰分隔线在间隙中居中。
- 顶部三个按钮（暂停 / 重播 / 录屏）图标偏小、视觉间距偏大，单独调整了步进与字号，与下方按钮节奏一致。
- 录屏展开菜单：两个选项间距 28px，并去掉淡灰底色遮罩，改为浮层上的纯图标。
- 代码修改面板在手机端可全屏打开 / 关闭，并与顶栏下拉的选中态联动。

### 修改与修复

- 资源管理器图标由字体中不存在的 `explorer` 字形改为真实存在的 `account_tree`（原字形缺失会导致图标显示错乱）。
- 下拉菜单使用视口固定定位，避免被顶栏横向滚动容器裁切。
- 补齐中英文词条：面板名称、文件操作、录屏分组等。
- 安卓端每个资源请求都带版本号查询串，WebView 即使缓存了旧文件也一定会加载新包内容。

### 桌面端

界面与交互保持原版不变，仅有两处功能补充：项目选择器可删除项目、导入项目后自动选中。

---

## 下载与安装

- 安卓：安装 `ZeppPlayerAndroid/release/ZeppPlayer-<版本号>.apk`（minSdk 24，targetSdk 34）。
- 桌面：使用原版的 Electron 构建产物，或按下方步骤自行打包。

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

产物为 `ZeppPlayerAndroid/release/ZeppPlayer-<版本号>.apk`，已用本地 keystore 签名。脚本会自动同步 `AndroidManifest.xml` 中的 `versionCode` / `versionName`：`versionCode = major*10000 + minor*100 + patch`，升级时必须递增，否则 Android 会拒绝覆盖安装。

## 与上游同步

```bash
git remote add upstream https://github.com/MelianMiko/ZeppPlayer.git
git fetch upstream
git merge upstream/main
```

本版的改动集中在 `app/index.html`、`app/index.css`、`src/index.browser.js`、`src/ui_managment/ToolbarManager.js`、`src/ui_managment/ViewMode.js`、`src/ui_managment/ProjectPicker.ts`、`src/zepp_player/i18n.js`、`electron_main.js`，以及新增的 `ZeppPlayerAndroid/` 目录，合并冲突一般只出现在这些文件。

## 已知限制

沿用原版的限制：

- 无法运行以字节码形式打包的 JavaScript 源码（如 `app.bin` / `index.bin`）。
- 不支持 `side-service` 与 `settings-app` API，只实现了 ZeppOS 设备侧行为。
- 对 ZeppOS API 的覆盖不完整，Firefox 下可能表现异常。

本版额外说明：

- 手机端针对触控做了布局压缩，部分面板在窄屏下需要滚动查看。

## 许可证与致谢

本项目基于 **GPL-3.0** 发布，原始版权归 [MelianMiko](https://melianmiko.ru) 所有。本版同样以 GPL-3.0 分发，保留原作者版权声明，修改部分同样开源。

- 原项目：https://github.com/MelianMiko/ZeppPlayer
- 原作者主页：https://melianmiko.ru
