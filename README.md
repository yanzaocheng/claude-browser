[![CI](https://github.com/yanzaocheng/claude-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/yanzaocheng/claude-browser/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yanzaocheng/claude-browser?label=portable)](https://github.com/yanzaocheng/claude-browser/releases)
# Claude Browser · 指纹浏览器

类 AdsPower 的多开指纹浏览器：每个「环境」是一个独立的 Chrome 实例，拥有独立的 Cookie / 缓存 / 登录状态、独立的指纹和独立的代理；带管理界面和兼容 AdsPower Local API 的自动化接口。

零依赖，只需要 **Node.js ≥ 22** 和本机已安装的 **Chrome**（或 Edge）。

## 分发给别人用（不需要装 Node，也不需要装 Chrome）

```bash
npm run package          # = node scripts/package.mjs --zip
```

不想自己构建就直接下 Release 里的 `claude-browser-<版本>.zip`（打 tag 时由 GitHub Actions 自动构建并附在 Release 上）。

```bash
```

产物：

```
dist/claude-browser-0.1.0/            88 MB   ← 直接拷给别人的文件夹
   ├ node.exe                     （Node 运行时，自带，无需安装）
   ├ src/  public/  assets/
   ├ 启动 Claude Browser.bat
   └ 使用说明.txt
dist/claude-browser-0.1.0.zip         33 MB   ← 发这个
```

对方双击 `启动 Claude Browser.bat` 就能用：管理窗口用**系统自带的 Edge** 以 `--app` 方式打开（Windows 10/11
必装 Edge，所以不装 Chrome 也有独立窗口）；环境默认用本机 Chrome/Edge 起浏览器，也可以在「设置 → 内核」
切成 SunBrowser 内核（内核从 AdsPower CDN 下，不依赖本机 Chrome）。

设置里的「界面窗口」可选：`自动（Windows 优先 Edge）` / `Microsoft Edge` / `Google Chrome` /
`系统默认浏览器（带标签栏）`，也可以用 `--shell edge|chrome|browser` 覆盖；Edge 与 Chrome 用各自的
`ui-window-*` 目录，互不干扰。

**为什么不做 Electron / Tauri**

| | 现在（Chromium `--app` + 便携 Node） | Electron | Tauri |
| --- | --- | --- | --- |
| 分发体积 | 33 MB（压缩包） | 90–150 MB | 3–10 MB（依赖系统 WebView2） |
| 目标机要求 | 只需 Windows 自带的 Edge | 无 | Win10 21H2+ / Win11 的 WebView2 |
| 构建链 | `node scripts/package.mjs` | electron-builder + 签名 | Rust 工具链 + WebView2 打包 |
| 托盘 / 自启 / 自定义标题栏 | 没有 | 有 | 有 |
| 更新方式 | 换文件夹或增量更新代码 | 安装包 | 安装包 |

只有在需要托盘、开机自启、无浏览器痕迹的原生窗口，或者要上 macOS 时，才值得换成 Electron/Tauri。
## 启动

```bash
npm start            # 启动服务并以独立窗口打开管理界面
npm run serve        # 只启动服务（不打开窗口），适合纯 API 使用
node src/main.js --port 50325 --data ./data --debug
```

Windows 下也可以双击 `start.bat`。默认端口与 AdsPower 相同（50325）；如果该端口被系统保留（Hyper-V/WSL 常见，`netsh int ipv4 show excludedportrange protocol=tcp` 可查看），会自动改用附近的空闲端口并在控制台提示。

## 功能

| 模块 | 说明 |
| --- | --- |
| 环境管理 | 新建 / 批量创建（每行一个代理）/ 编辑 / 复制 / 删除、分组、搜索、批量打开与关闭，状态实时刷新 |
| 代理 | HTTP / HTTPS / SOCKS5，支持账号密码（本地转发，浏览器不弹认证框，DNS 由代理端解析），一键检查出口 IP |
| 基于 IP 的设置 | 打开环境时经代理查询出口 IP，自动匹配时区、语言、地理位置 |
| 指纹 | 操作系统 / UA / Client Hints、时区、语言、地理位置、分辨率（含任务栏工作区、窗口位置、按本机缩放推荐的尺寸）、色域、CPU 核心数、内存、WebRTC、Canvas、WebGL 图像与元数据、WebGPU、AudioContext、ClientRects、系统语音列表、`navigator.webdriver` |
| Cookie | 编辑环境里点「读取环境当前 Cookie」即可把该环境已产生的 Cookie 全量列出来（运行中 0.1 秒直读，没开环境时自动拉一个无头浏览器读），可一键复制；粘贴后保存 = 下次打开时导入。菜单里另有导入 / 导出 / 清空（JSON / Netscape） |
| 启动页 | 每个环境第一个标签页显示环境信息、出口 IP 和页面实测的指纹 |
| 本地 API | 兼容 AdsPower `/api/v1/browser/start` 等接口，返回的 `ws.puppeteer` 可直接给 Puppeteer / Playwright 使用 |

## 内核：AdsPower SunBrowser（可选）

不想用「Chrome + CDP/脚本注入」那套，可以直接把 AdsPower 的 SunBrowser 内核挂进来，指纹由内核自己改，
页面里看不到任何 JS 补丁。设置 → 内核 选「AdsPower SunBrowser 内核」即可，路径留空会自动找
`%APPDATA%\adspower_global\cwd_global\chrome_*\sunbrowser.exe`（取版本最高的那个）。

内核不读命令行上的 `--fingerprint`，它读三个混淆文件 + 一段启动参数，这些文件都用同一个 `594…` 自定义
字母表编码（从 AdsPower 本地服务 `main.min.js` 里的 `decodeBase64(s, C1, C2)` 还原）：

| 文件 | 内容 |
| --- | --- |
| `staticconfig` | CanvasMark / WebGLMark、CPU、内存、语言、UA metadata、各种路径 |
| `dynamicconfig` | `TimeZone`、`Geoposition` |
| `<hash>_Other` / `<hash>_Android` | WebGL 的 `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` |
| `--extended-parameters=<blob>` | 上面这些数字的又一份（浏览器进程启动时广播给子进程） |

文件名不是随便起的，AdsPower 用环境 ID 做哈希：

```
static    → md5("<环境ID>_static")
webgl     → md5("<环境ID>_webgl") + "_Other" / "_Android"
cookies   → md5("<环境ID>_cookies")
icon      → md5("<环境ID>_icon") + ".ico"
```

名字对不上内核就当没这文件、悄悄回落本机显卡（这条踩过坑：一开始沿用了种子文件名，Canvas 生效而
WebGL 厂商始终是本机 GPU）。

`src/kernel-sunbrowser.js` 负责：解码 → 按环境改写 → 用上面的名字重新编码写进 `browsers/<环境ID>`，
再用 `assets/sunbrowser/` 里的命令模板拼出启动参数。每个环境因此有独立的时区、经纬度、Canvas/WebGL
噪声与厂商（`UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL`）、CPU 核数、内存、语言、UA 与窗口
尺寸；这些值在 `fingerprint` 的 `seed` 上派生，重开环境不会变。

与 Chrome 模式的区别：

- 指纹在浏览器内核里生效，不注入任何脚本，`navigator.webdriver` 为 false，没有 `Fetch` 拦改；
- 代理仍然走「本地转发 + `--proxy-server`」，带认证的 SOCKS5 也能用；
- 环境关闭时的 Cookie 读写（导入/导出）仍用系统 Chrome 打开同一个 profile 目录，两者都是 Chromium，格式兼容；
- WebGL 厂商/渲染器已按环境隔离（`fingerprint.webgl` 写了什么就是什么，实测 AMD/NVIDIA/Intel 三台互不干扰）；
- 内核只有 Windows 版，非 Windows 一律回落到 Chrome 模式。

### 首次准备：抽一份内核种子

仓库里**不含** AdsPower 的种子配置（那是它的私有数据，也没必要跟着代码走）。第一次用内核模式前跑一次：

```bash
# 先启动一次 AdsPower 客户端并打开任意环境，让内核 profile 落到 C:\.ADSPOWER_GLOBAL\cache\
node scripts/extract-kernel-assets.mjs
# 或者手动指定 profile 目录
node scripts/extract-kernel-assets.mjs --profile "C:\.ADSPOWER_GLOBAL\cache\<环境ID>_<邀请码>"
```

生成 `assets/sunbrowser/seed/`（staticconfig / dynamicconfig / cookies / webgl / icon）和
`tpl_meta.json`（`srcDir` / `srcName` / 由种子配置重建的 `extBlob`），两者都在 `.gitignore` 里。
换机器、或者想换一套基线指纹，重跑这一条即可。
### UA-CH 与 WebGL 扩展列表

内核是 Chromium 自家构建，`navigator.userAgentData.brands` 默认是 `Chromium / … / Not A(Brand`——真
Chrome 是 `Google Chrome` 打头、`Not(A:Brand`（无空格）。这条比 WebGL 厂商更容易被查，所以在内核模式下
额外用 CDP 把 UA-CH 改写成 Chrome 的品牌表（版本跟着 UA 走，`sec-ch-ua` 头与 JS 完全一致）：

```
brands          Google Chrome/155, Chromium/155, Not(A:Brand/24
sec-ch-ua       "Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"
uaFullVersion   155.0.0.0   （与 UA 字符串一致；Chrome 自己这里会带完整 build 号）
```

WebGL 扩展列表（`SUPPORTED_EXTENSIONS`）：**内核不读这个字段**，实测把文件里的数组清空或改成两项，页面
里依然是本机显卡的完整 35 项，与同机真 Chrome 一模一样。ANGLE/D3D11 下这批扩展与厂牌无关，所以这里没有
可差异化的空间，也不需要——真要伪造只能走 JS 层，反而更容易被戳穿。
### WebRTC 与系统版本

内核默认把 `webrtc-ip-handling-policy` 设成 `disable_non_proxied_udp`，结果页面里一个候选都没有——
检测站会直接标“STUN 无响应”，这跟真实浏览器（mDNS host + srflx）差得很明显。现在按有没有代理区分：

| 情况 | 策略 | 页面看到 |
| --- | --- | --- |
| 没配代理（本来就不存在泄漏） | `default` | `host` = `xxxx.local`（mDNS）+ `srflx` = 出口 IP，与真机一致 |
| 配了代理 + `webrtc: proxy` | `disable_non_proxied_udp` | 无候选（不暴露本机 IP；代价是 STUN 探测不到） |
| `webrtc: real` | `default` | srflx 走真实链路 |

策略同时写进 `--webrtc-ip-handling-policy` 和 staticconfig 的 `command_line`（内核会读配置，只改一处不生效）。

另外 `platformVersion` 做了收敛：Windows 的 UA-CH 只会是 `10.0.0`（Win10）或 `13/14/15.0.0`（Win11），
环境里写 `19.0.0` 这种不存在的值会被拉到 `15.0.0`，避免一个数字就暴露。
### 同步官方内核（148–155…）

`scripts/sync-kernel.mjs` 用 AdsPower 客户端自己的接口（`client/sys-version/list`）拉内核清单，下载 +
md5 校验 + 解压到 `%APPDATA%\adspower_global\cwd_global\chrome_<版本>`，也就是 `findSunBrowser()`
自动扫描的位置：

```bash
node scripts/sync-kernel.mjs --list             # 列出可用内核、大小、是否已装
node scripts/sync-kernel.mjs --kernel 155       # 下载安装（约 242MB，md5 校验通过才落盘）
```

token 不用手填：脚本直接从 AdsPower 客户端的 localStorage 里读（`KEY_IN_WEBSITE`），只要启动过一次
AdsPower 就行；要给别的账号用就 `--token ...` 或 `ADSPOWER_TOKEN=...` 覆盖。

装完不用改配置：`findSunBrowser()` 取版本号最高的那个，下次开环境就是新内核。实测 153 → 155 平滑切换，
同一份种子配置在新内核上照常生效（UA 155、WebGL 厂商仍是环境里配的那个）。
验证：设置好内核后 `curl "http://127.0.0.1:50325/api/v1/browser/start?user_id=<环境ID>"`，
返回的 `ws.puppeteer` 就是内核实例；`node scripts/try-kernel.mjs <环境ID>` 会打印该环境在内核里实际
读到的时区 / 语言 / CPU / 内存 / Canvas 哈希 / WebGL 厂商。
## 自动化示例

```js
const puppeteer = require('puppeteer-core');
const { data } = await (await fetch('http://127.0.0.1:50325/api/v1/browser/start?user_id=USER_ID')).json();
const browser = await puppeteer.connect({ browserWSEndpoint: data.ws.puppeteer, defaultViewport: null });
const page = await browser.newPage();
await page.goto('https://example.com');
```

完整接口列表和 Playwright / Selenium 示例见管理界面的「API · 自动化」页面。

## 实现方式

- **进程**：每个环境用 `--user-data-dir=data/browsers/<环境ID>` 启动系统 Chrome，并通过 DevTools 协议（CDP）保持一个控制连接。
- **指纹注入**：浏览器级 `Target.setAutoAttach(waitForDebuggerOnStart)`，新页面、iframe、Worker 在执行任何网页脚本之前先被暂停，写入覆盖后再放行：
  - 原生覆盖（CDP Emulation）：UA 与 Client Hints、时区、语言区域、地理位置、CPU 核心数、屏幕尺寸（包括媒体查询）；
  - 脚本补丁（`src/inject/spoof.js`）：Canvas / WebGL / Audio / ClientRects 噪声、WebGL 厂商与渲染器、设备内存、语音列表、`webdriver` 等。替换后的函数是普通函数而不是 Proxy（Proxy 会被原型环检测识破），`toString`、`name`、`length`、原型链、非法调用报错、错误堆栈（不含补丁自身的帧）都与原生一致，可通过 CreepJS 式的 lie 检测；噪声按环境种子确定、可重复，且只作用于指纹会产生的数据（抗锯齿像素、离线渲染的音频、带小数的文字尺寸），网页自己写入再读回的值保持精确，避免被「写入已知值再读回」的陷阱识破；`about:blank` / `srcdoc` 子框架和 `window.open` 弹窗同样会被补丁；页面、Dedicated / Shared / Service Worker 看到的值一致；
  - 浏览器发起的导航（新标签、noopener 链接）的首个请求头通过浏览器级 `Fetch` 拦截改写，保证 UA 与 Client Hints 一致。
- **代理**：Chrome 不支持带认证的 SOCKS5，所以每个环境有一个 127.0.0.1 上的本地 HTTP 代理，把连接转发到上游代理（`src/proxy-chain.js`）。WebRTC 通过浏览器策略禁止非代理 UDP，防止真实 IP 泄露。

## 局限

- 指纹修改发生在 JS / CDP 层而不是浏览器内核，能对抗常见的指纹检测，但无法做到定制内核那样无痕。建议操作系统选择与本机一致。
- 字体列表是真实的：Chrome 的 `style.fontFamily` 不经过可拦截的原型属性，JS 层只能部分隐藏字体，而「这种检测方式有、那种没有」本身就是破绽，所以不做。
- WebRTC 没有「替换」模式（用代理 IP 伪造候选地址）：JS 合成的事件 `isTrusted` 为 false，比没有候选更容易识别；需要定制内核或经代理的 TURN 服务器。
- WebGL 参数 / 扩展 / 着色器精度、数学函数精度来自真实硬件，同一台电脑上的所有环境相同（AdsPower 同样如此）。
- Chrome 137 起品牌版 Chrome 不再支持 `--load-extension`，扩展请在各环境内从应用商店安装（会保存在该环境中）。

## 测试

```bash
npm test
```

包括代理链单元测试（模拟 HTTP / SOCKS5 上游，不需要外网）和端到端测试（用无头 Chrome 打开环境，从独立的 CDP 客户端检查页面、iframe、Worker、弹窗实际看到的指纹，以及 Cookie、AdsPower API）。

## 目录

```
src/
  main.js            命令行入口（端口回退、打开管理窗口、退出时关闭所有环境）
  app.js             组装 store / launcher / server
  server.js          管理界面的内部 API、SSE 推送、启动页、静态文件
  api-compat.js      AdsPower 兼容 API
  launcher.js        启动 / 关闭浏览器进程、Cookie 读写
  controller.js      CDP 指纹控制器
  inject/spoof.js    注入页面的指纹补丁脚本
  fingerprint.js     指纹生成、校验、运行时解析
  proxy-chain.js     代理解析、隧道、本地转发
  ipinfo.js          出口 IP 查询
  cookies.js         Cookie 格式转换
  store.js           JSON 数据存储（data/db.json）
public/              管理界面（原生 JS，无构建）
test/                测试
```

## 说明

- 内核模式的配置格式是从 AdsPower 客户端逆出来的，用于自己的多环境调试与指纹研究；内核二进制与种子配置
  的版权归 AdsPower（SUNFLOWER TECH PTE. LTD.）所有，本仓库不分发这些文件。
- 用本工具做什么、在哪些站点上用，由使用者自己负责并遵守相应服务条款与当地法律。
