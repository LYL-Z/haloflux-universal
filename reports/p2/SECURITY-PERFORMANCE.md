# P2 · 安全 / 性能 / 无障碍验收报告

- 任务板：`task-7`（P6 gate），执行人 `sec-perf`
- 仓库：`D:\HALOFLUX`，分支 `feat/paper-lab-p2`；任务指定起点 HEAD `0a9e389`。执行期间 Lead 提交了 `4b83647`、`2d90b68`，**最终测量对象为 HEAD `2d90b68` 的干净工作区**（未切换分支、未 commit、未 push）
- 执行时间：2026-11-09 04:23–05:00（America/Los_Angeles，UTC-8）
- 约束遵守：**未修改任何源码 / 宿主配置**；新增文件仅限本报告与 `tests/evidence/p2-security/**`、`tests/evidence/p2-perf/**`（探针脚本放在证据目录内，不属于产品源码）
- 机器：Windows 11 10.0.26200 x64，Intel Core Ultra 9 290HX（24 核），Node v24.16.0，Electron 43.3.0（DSH 自带）
- 主显示器：1536×960 逻辑 @ DPR 2.5（物理 3840×2400），工作区 1536×912 → 1600×900 窗口被系统钳制为内容区 **1524×878**（与 docs/06 记录的 1600×900 口径不同，见 §2.2）
- 测量对象锁定：`tests/evidence/p2-security/worktree-hashes.json` 记录 pre/post 两次快照；**`changedDuringMeasurement = []`（测量期间源码零变化）**，终态 `modifiedTracked` 只含本轮证据 JSON，无源码。关键 SHA256：
  - `apps/companion/renderer/app.js` = `7a5abe76346ca86b9b1534aa271110c62db4467bbe9a1ef51e1b05cc33591eee`
  - `apps/companion/renderer/styles.css` = `0760b0cb968ae08773491b44163c96058d95cd98e8e08bd83040f57ef8aefd59`
  - `apps/companion/renderer/monitor-projection.mjs` = `5cddf37d772fd862d6dd03819bfc7839a6f765b6d840698342ec94267fc0ca09`
  - `packages/event-bridge/src/server.mjs` = `c53b7c33cecccd5e2a2e35236baeb74ce4309fb264ae7ca2ebd67059436b3213`
  - `packages/session-manager/src/index.mjs` = `ddd2f053e7e6b97da75a7d3c20a1537c8968a899aeda72c55565816c57175ca1`
  - 完整 12 个文件见该 JSON

## 0. 结论总表

| # | 项目 | 状态 | 摘要 |
|---|---|---|---|
| 1 | `npm run test:security` | **PASS** | exit 0；13 tests / 13 pass / 0 fail / 0 skip |
| 2 | 定向安全探针（21 项，Windows 实测） | **PASS** | 21/21 PASS；回环、401、Origin/Host、413、429、穿越、幂等、重连、日志脱敏全部实测 |
| 3 | 事件 metadata → Paper Lab DOM 的 XSS | **PASS** | 恶意 toolName 经真实 bridge 进入 `/v1/state`，渲染为纯文本；0 注入元素 / 0 内联事件 / 0 脚本执行 |
| 4 | 30 分钟 soak（bridge，无 renderer） | **PASS（稳定性）** | 30.02 min；11311/11311 accepted，postErrors=0；RSS 59.89→74.67 MB（+14.78）；CPU 平均 0.016% / 峰值 0.07%；**泄漏未证实也未排除** |
| 5 | 可见窗口 fps 抽样 | **PASS（口径需注意）** | window 30.3–30.6 fps（12 s rAF 均值×3）/ 40（HUD 单次）；overlay 37；compact 60（docs/06 §3：31/24/24）；software 合成、短窗口采样 |
| 6 | 键盘可达与可操作 | **PASS** | 6 预设按钮、6 host 按钮、Obsidian file input 均在真实 Tab 序列内；Enter 激活 host 按钮生效 |
| 7 | focus-visible | **PASS（弱）** | 18/18 tab 停靠均命中 `:focus-visible` 且有 outline；全局 outline 实测仅 0.8px |
| 8 | 8–9px 文本对比度 | **PARTIAL** | 43 个 8–9px 文本节点中 4 个失败（状态栏分隔符 1.30:1）；设置抽屉打开后另有 6 处 `--faint` 3.51:1 失败 |
| 9 | reduced-motion | **PASS** | 媒体查询命中，动画/过渡降为 1e-06s，状态栏显示 `reduce-motion` |
| 10 | 200% 缩放 / 小窗口 | **PARTIAL** | 无横向溢出/无裁切，但 Paper Lab 控制台整体 `display:none`（新功能内容与交互丢失） |
| 11 | 日志不回显 token | **PASS** | 真实 debug 日志 503 B / 10 行，0 次 token、0 个 64-hex；logger 单测 4/4 脱敏 |
| 12 | token 文件权限 | **PARTIAL** | 生成式 token 文件 65 B、落在临时 HOME；Windows 实测 mode 0666（chmod 映射只读位，非 POSIX 0600） |

---

## 1. 安全（Windows 实测）

### 1.1 官方安全套件

```powershell
cd D:\HALOFLUX
npm run test:security   # = node --test "tests/security/*.test.mjs"
```

| 指标 | 实测 |
|---|---|
| exit code | **0** |
| tests / pass / fail / skipped | **13 / 13 / 0 / 0** |
| 套件耗时 | 10,742 ms（wall 11.22 s，终态 HEAD 复跑） |
| 端口 | 179xx 随机（`tests/helpers/bridge.mjs`），未使用 17817 |
| 覆盖 | 无 token 401、错误 token 401、X-Haloflux-Token、SSE query token、>256 KB 413、坏 JSON 400、慢速 trickle、Origin/Host 拒绝、path traversal、非回环不可达、token 不回显 |

证据：`tests/evidence/p2-security/test-security.stdout.txt`、`test-security.stderr.txt`

### 1.2 定向探针（21 项）

探针：`tests/evidence/p2-security/probe.mjs`（可重跑）。真实 bridge 子进程，隔离端口 **18010–18099**、临时 `HALOFLUX_HOME`、显式 64-hex token、`HALOFLUX_LOG_LEVEL=debug`；生产端口 17817 全程未触碰（S20 实测 0 条监听）。

本次运行（终态，HEAD 2d90b68）：`port=18070`、`pid=16840`、`home=%TEMP%\haloflux-p2sec-kEs1J3`。

```powershell
node tests\evidence\p2-security\probe.mjs   # exit 0
```

结果：**21/21 PASS，0 FAIL，0 SKIP**（`tests/evidence/p2-security/security-probe.json`）

| ID | 检查 | 实测结果 |
|---|---|---|
| S1 | 回环绑定 / 非 127.0.0.1 不可达 | 非回环 IPv4（10.99.0.1、10.133.166.169、172.26.192.1）全部**不可达**；`::1` 不可达；`127.0.0.1:18070` 已被占用（EADDRINUSE），而 `10.99.0.1:18070` 仍可绑定（证明只绑 loopback、未开 wildcard） |
| S2 | 无 token → 401 | 6 个端点（`/v1/state`、`/v1/stack`、`/v1/settings`、`/v1/stream`、`/v1/events`、`/v1/simulate`）全部 401，响应体固定 `{"error":"unauthorized"}` |
| S3 | 错误 token → 401 且不回显 | 3 端点 + malformed / empty / `X-Haloflux-Token` 3 变体全部 401；响应不含提交的 token 或真实 token |
| S4 | query token 仅限 SSE | `/v1/state?token=`、`/v1/settings?token=` → 401；`/v1/stream?token=` → 200 且首帧为 `snapshot`；错误 query token → 401 |
| S5 | Origin / Host 拒绝 | 4 个敌对 Origin（`https://evil.example.com`、`http://127.0.0.1.evil.example`、`http://10.0.0.1:8080`、`http://localhost.evil.example:3000`）→ 403；`null` / `file://` / loopback http 放行（202）；4 个敌对 Host → 403，`127.0.0.1`/`localhost` → 200 |
| S6 | >256 KB → 413 | 声明 300 KB → 413 `{"error":"payload_too_large","limitBytes":262144}`；无 Content-Length 的 chunked 384 KB → 413；之后 health 200 |
| S7 | 批量/单事件上限 | 101 条批量 → 400 `batch exceeds 100 events`；9,300 B 单事件 → 400（`bad_string` + `metadata_too_large`）；`__proto__` metadata → 400；health 200 |
| S8 | 限流 429 | 单 socket 流水线 400 请求：**240×200 + 160×429**（21 ms 内），429 带 `Retry-After: 1`，与 240 req/s 契约精确一致 |
| S9 | 限流恢复 | 新 socket 的 health / state 均 200（限流按 socket，不产生全局锁死） |
| S10 | 路径穿越 | 12 种变形（`../../token`、`%2e%2e%2f`、`..%5c`、`../canary-secret-store.json`、`win.ini`、`/../token`、`/v1/state/../../token`…）全部 401/404；HALOFLUX_HOME 内预置 canary 文件后响应**未泄漏** canary 内容或文件名 |
| S11 | 重复事件幂等 | 首次 `accepted=1, duplicates=0`；原样重放 `accepted=0, duplicates=1`；session `eventCount` 与全局 `eventCount`、metrics 均不变 |
| S12 | 重连 | SSE 3 轮「建连→拿 snapshot→立刻断开」全部 200 + snapshot；会话数 2→2 不丢；health 200 |
| S13 | XSS 入口（bridge 侧） | schema 接受 `<img src=x onerror="window.__xss=1">` 作为 `toolName`（36 字符 ≤80 上限，仅长度限制、无字符集过滤），202 接受并**原样**进入 `/v1/state` |
| S14 | 渲染器静态注入面 | `app.js` / `mock-session.js` / `monitor-projection.mjs` / `obsidian-metadata.mjs` / `index.html` 中 **0** 处 `.innerHTML=`、`outerHTML=`、`insertAdjacentHTML`、`document.write`、`eval(`、`new Function(`；CSP meta 存在且 `connect-src` 限 loopback、`object-src 'none'` |
| S15 | 安全响应头 | `X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`；被拒 Origin 无 ACAO；`null` Origin 得到 `ACAO: null` |
| S16 | token 不回显 | 全程 56 个响应体，0 泄漏（真实 token / 提交的 token 均未出现） |
| S17 | 日志脱敏（真实进程） | `bridge-debug.log` 503 B / 10 行；含 `rejected origin` debug 行；token 出现 0 次、64-hex 出现 0 次 |
| S18 | 日志脱敏（logger 单测） | 4 个级别各注入一次 token/64-hex，输出 4 行全部为 `[redacted]`，0 泄漏 |
| S19 | token 文件 | 显式 `HALOFLUX_TOKEN` **不落盘**；无 env token 时生成 65 B 文件、可认证、位于临时 HOME 而非仓库内；Windows mode 0666（见 §5 PARTIAL） |
| S20 | 生产端口 | 探针端口 18070，17817 监听数 0 |
| S21 | 滥用后存活 | 全部攻击序列后 `/v1/state` 仍 200，sessions=3、eventCount=6、duplicates=1、dropped=0，进程未退出 |

### 1.3 事件 metadata → Paper Lab DOM（XSS 端到端）

编排脚本：`tests/evidence/p2-security/xss-run.mjs` → 产物 `xss-e2e.json`、`xss-dom.json`；渲染侧由 `electron-probe.cjs` 在真实 Electron 窗口执行 DOM 检查。

```powershell
node tests\evidence\p2-security\xss-run.mjs   # exit 0, verdict=PASS
```

| 步骤 | 实测 |
|---|---|
| 事件注入 | `toolName = <img src=x onerror="window.__xss=1">`，POST `/v1/events` → **202**，`accepted=1` |
| bridge 回显 | `/v1/state` 中 `recentEvents[].toolName` 与 payload **逐字符一致**（证明入口真实、未被转义掉） |
| Paper Lab 渲染 | `#lab-feed-rows` 1 行；`innerText` 含字面量 `<img src=x onerror="window.__xss=1">` |
| 注入元素 | `#lab-feed-rows` 内 `img/svg/script/iframe/object/embed` 计数 **0** |
| 内联事件 | 0 个 `on*` 属性 |
| 脚本执行 | `window.__xss` = undefined，无 JS 执行 |
| 序列化 HTML | 无未转义的 `<img … onerror` |
| 渲染器隔离 | `window.process` / `window.require` / `window.module` 均 undefined；CSP meta 存在 |
| CSP 出网 | 页面内 `fetch('https://example.com/')` 被 CSP 阻断（`Failed to fetch`） |

结论：**PASS**。防御是「渲染侧只走 `textContent`」+「CSP 兜底」的双层结构；bridge 侧不做字符白名单（属设计选择，见 §5 风险 R4）。

---

## 2. 性能

### 2.1 30 分钟 soak（真实 bridge，无 renderer）

命令（原样，后台运行）：

```powershell
node scripts/soak.mjs --minutes 30 --events-per-second 8 --no-renderer --out tests\evidence\p2-perf\soak-30min.json
```

隔离方式：脚本内 `freePort()` 固定 **17910–17999**（生产 17817 不参与）+ `mkdtemp` 临时 `HALOFLUX_HOME`（脚本自身创建，非用户目录）。注：任务书写的是 180xx；`scripts/soak.mjs:132` 硬编码 179xx，本轮**未改源码**，故实际使用 179xx，但隔离性质相同（不用 17817）。

#### 结果（原始 JSON：`tests/evidence/p2-perf/soak-30min.json`；汇总：`soak-30min-analysis.json`）

| 指标 | 实测 |
|---|---|
| status（脚本自报） | **PASS** |
| 实际时长 | **1801.2 s = 30.02 min**；359 个样本，采样间隔 5.016 s |
| 事件发送 / 接受 | **11311 / 11311**；**postErrors = 0** |
| bridge eventCount / sessions | 11311 / 12（30 分钟全程 12 会话不变） |
| 请求速率 | 目标 8/s，**实测 6.30/s**（原因见风险 R5，非拒绝） |
| bridge RSS | 59.89 → **74.67 MB**（+14.78 MB）；中位 72.38，峰值 75.25，均值 71.57 |
| RSS 趋势 | 全程 0.494 MB/min；**近 15 分钟斜率 +0.186 MB/min**（增长集中在前 5 分钟） |
| bridge CPU | 平均 **0.016%**、峰值 **0.07%**（24 核；358 个有效样本，242 个非零） |
| dropped / duplicates | soak 脚本未持久化该字段（只存 eventCount/sessions）；HTTP 层 0 拒绝、0 错误，eventCount == accepted |

5 分钟刻度（原始样本取整）：

| 分钟 | 5 | 10 | 15 | 20 | 25 | 30 |
|---|---|---|---|---|---|---|
| events | 1812 | 3649 | 5530 | 7431 | 9391 | 11311 |
| RSS (MB) | 68.22 | 72.38 | 72.00 | 73.90 | 74.28 | 74.67 |
| CPU (%) | 0 | 0 | 0.03 | 0 | 0.01 | 0.04 |

解读（不美化）：

- **bridge 不是瓶颈**：30 分钟 1.13 万事件 / 12 会话，CPU 平均 0.016%，postErrors=0，进程未崩溃、无 5xx。
- **内存**：前 5 分钟 +8.33 MB（V8 堆预热），随后 25 分钟仅 +6.45 MB，并出现回落（72.38→72.00；GC 型 RSS 回落 >1 MB 发生 1 次，最大 1.35 MB）。曲线是「阶梯 + 缓慢上升」，**不能证明没有泄漏**，但 30 分钟内没有失控。
- 判定：本轮**未发现泄漏证据**；按 docs/06 §6 的口径，排除泄漏仍需 ≥2 h soak + 强制 GC 后基线（见 §6 TODO）。

### 2.2 可见窗口 fps 抽样（与 docs/06 §3 的 31/24/24 对照）

两次独立方法，均为**可见窗口**（`show:true`），demo 数据（与 docs/06 §4 的截图口径一致）：

**方法 A：自建主进程 + rAF 采样（12 s，逐秒 11 个样本；同一构建连跑 3 次）**

```powershell
electron.exe tests\evidence\p2-security\electron-probe.cjs   # TASK=fps, MS=12000
# → tests/evidence/p2-perf/fps-window-12s.json / fps-window-run1.json / fps-window-run2.json
```

| 指标 | 第 1 次 | 第 2 次 | 第 3 次（终态测量） |
|---|---|---|---|
| 平均 fps | **30.48** | **30.63** | **30.30** |
| 最低 / 最高 | 25.67 / 36.70 | 25.16 / 35.59 | 25.16 / 36.70 |
| 应用内 HUD（同刻） | 33 fps / 2.0 ms / 画质低 50% / 737 p | 30 fps / 1.9 ms / 50% / 684 p | 35 fps / 1.8 ms / 50% / 735 p |
| JS 堆（used / total） | 14.3 / 27.6 MB | 12.7 / 19.3 MB | 16.1 / 26.0 MB |

- 视口 1524×878 @ DPR 2.5（1600×900 被显示器钳制），三次一致。
- 渲染进程（`app.getAppMetrics`，Tab，第 3 次）：工作集 144,644 kB → **181,468 kB**；累计 CPU 0.534 s → 1.822 s（12.0 s 内 +1.288 s ≈ 单核 10.7%，占 24 核 0.45%）。
- **三次均值 30.30–30.63，极差 0.33**：同一构建的短窗口采样稳定；但 HUD 单次 30–35 与 rAF 均值 30.3 口径不同，不可混用。

**方法 B：生产启动器 + 状态栏截图（三种模式各一次，取第 9–10 s 的 HUD 快照）**

```powershell
node scripts\launch-companion.mjs --mode window  --demo --screenshot tests\evidence\p2-perf\window-status-10s.png  --screenshot-delay 10000 --exit-after 13000
node scripts\launch-companion.mjs --mode overlay --demo --screenshot tests\evidence\p2-perf\overlay-status-10s.png --screenshot-delay 9000  --exit-after 12000
node scripts\launch-companion.mjs --mode compact --demo --screenshot tests\evidence\p2-perf\compact-status-10s.png --screenshot-delay 9000  --exit-after 12000
```

| 模式 | 截图状态栏实测（第 9–10 s） |
|---|---|
| window 1200×800 @DPR 2.5 | **40 fps · 2.0 ms · 画质 低 50% · 840 particles** |
| overlay 1536×912 @DPR 2.5（透明置顶） | **37 fps · 2.1 ms · 画质 低 50% · 794 particles** |
| compact 320×320 @DPR 2.5 | **60 fps**（compact HUD 行） |

**与 docs/06 对照**

| 模式 | docs/06 §3（Lead，GPU 路径） | 本次实测（P2 @2d90b68） | 差异说明 |
|---|---|---|---|
| window | 31 fps @1600×900 | **30.3–30.6 fps**（12 s rAF 均值 ×3）/ 40 fps（HUD 单次，1200×800） | rAF 均值与 31 相差 **-1.3%～-2.3%**，在采样噪声内；HUD 单次值偏高但属不同指标 |
| overlay | 24 fps | **37 fps**（HUD 单次，1536×912） | 口径不同（单次 HUD、software 合成）；不能宣称提升 |
| compact | 24 fps | **60 fps**（HUD 单次，320×320） | 小窗口更接近垂直同步；同样口径不同 |

`app.getGPUFeatureStatus()`（窗口采样会话）：`gpu_compositing=disabled_software`、`2d_canvas=disabled_software`、`webgl=disabled_off`；同时 stderr 出现 `GPU state invalid after WaitForGetOffsetInRange`。**因此本次不是 GPU 路径测量**，与 docs §3 的 GPU 口径不可直接比较。

结论：**window 模式与 docs 基线（31 fps）基本一致，未检出回退**；overlay/compact 的 HUD 单次值高于 docs 基线，但采样口径不同，不作为改进结论。三种模式均 **<60 fps**，性能守卫确实在降质（画质 50%/75%，粒子数 684–840 波动）。

> 不能把单帧/单次数字当 30 分钟结论：fps 数字仅代表 9–12 s 的短窗口；30 分钟结论只由 §2.1 的 bridge soak 支撑（soak 不含 renderer）。

---

## 3. 无障碍

工具：`tests/evidence/p2-security/electron-probe.cjs`（真实 Electron 主进程 + 真实 Tab 键盘事件 + DOM 计算样式），demo 数据，窗口 1524×878 @ DPR 2.5。

证据：`a11y-probe.json`（默认）、`a11y-reduced-motion.json`、`a11y-drawer-open.json`、`a11y-window.png`。

### 3.1 键盘可达与可操作 —— PASS

| 对象 | 结果 |
|---|---|
| Tab 顺序 | 真实 `sendInputEvent` Tab 键 18 站（第 18 站回到第 1 站），非程序化伪造 |
| 预设按钮 | 6/6 在 Tab 序列内（`preset-btn`：原作/极简/科幻光场/专注/环境/Agent 监控） |
| host 按钮 | 6/6 在 Tab 序列内（DS/CX/CU/WB/CC/TR） |
| Obsidian file input | 在 Tab 序列内；`tabIndex=0`、有 `aria-label`「导入 Obsidian 本地元数据快照 JSON」 |
| 键盘激活 | 聚焦第 2 个 host 按钮后按 Enter → `aria-pressed` 由 index 4 变为 index 1（选中切换成功） |
| 焦点陷阱 | `aria-hidden="true"` 容器内**没有**可见可聚焦元素（0 处） |

细节：`#lab-obsidian-file` 本身是 1×1 px、`opacity:0`（视觉隐藏），但被包在 `<label class="lab-import">` 内，label 的点击区域为 **355×19 px**，且 `:focus-within` 会给 label 2px outline——所以鼠标/键盘都有可操作目标；但 19px 高度 < WCAG 2.2 AA 2.5.8 的 24×24（列为次要风险，非阻断）。

### 3.2 focus-visible —— PASS（偏弱）

| 指标 | 实测 |
|---|---|
| 命中 `:focus-visible` 的 tab 站 | **18/18** |
| 无 outline 的 tab 站 | **0** |
| 全局 outline（按钮/图标按钮） | `solid`，实测宽 **0.8 px**（CSS 写 1px），offset 2px |
| lab-host 按钮 | `solid` **2 px** `#e7e7ed`，offset 1px |
| file input（焦点落在 label） | `solid` **2 px**（`:focus-within`） |

风险：全局 1px（实测 0.8px）outline 在 `#020204` 上可见但偏细；对应 WCAG 2.4.11/2.4.13（AAA）的可见面积要求不满足，AA 2.4.7 满足。

### 3.3 8–9px 文本对比度 —— PARTIAL

**静态计算**（WCAG 2.x 相对亮度公式，前景 sRGB → 相对亮度 → `(L1+0.05)/(L2+0.05)`）：

| 前景 | 用途（字号） | on `#020204` | on `#040408`（lab cell 实际底色） | AA 4.5:1 |
|---|---|---|---|---|
| `#91919e` | `.lab-rows` 9px | **6.66** | 6.58 | PASS |
| `#8f8f9d` | `.lab-feed-row time` 9px | **6.50** | 6.42 | PASS |
| `#bde0de` | `.lab-feed-row b` 9px | **14.69** | 14.50 | PASS |
| `#afafc2` | `.lab-feed-row i` 8px | **9.61** | 9.49 | PASS |
| `#8c8c9a` | `.lab-detail span` 9px | **6.25** | 6.17 | PASS |
| `#e8e8ee` | `.lab-detail strong` 9px | **16.99** | 16.77 | PASS |
| `#d0d0d8` | `.lab-trace-column small` 8px | **13.52** | 13.35 | PASS |
| `#9f9fac` | `.lab-cell-foot` 8px | **7.93** | 7.83 | PASS |
| `#81818e` | `.lab-empty` 9px | **5.39** | 5.33 | PASS |
| `#9db6be` | `.lab-cell h2 span` 8px | **9.74** | 9.62 | PASS |
| `#9d9da9` | `.lab-ledger em` 8px | **7.73** | 7.63 | PASS |
| `#c7c7d1` | `.lab-import` 8px | **12.36** | 12.20 | PASS |
| `#7f8b9c`（`--muted`） | 状态/面板 8–9px | **6.00** | 5.92 | PASS |
| `#5a6575`（`--faint`） | `.eyebrow`/`.hint`/`dt` 8–9px | **3.51** | 3.46 | **FAIL** |
| `rgba(255,255,255,.12)`（`.status-sep`） | 状态栏「/」8.5px | ≈**1.30** | — | **FAIL** |

**运行时实测**（遍历可见文本节点，取计算色 + 逐层合成背景）：

- 默认界面：8–9px 文本节点 **43 个**，**4 个失败** —— 全部是状态栏分隔符 `/`（`.status-sep`，`rgba(255,255,255,0.12)` on `rgb(5,5,9)`，**1.30:1**）。它是纯装饰字符，但未标记 `aria-hidden`。
- 打开设置抽屉后：失败增至 **10 个** —— 上述 4 个 + 6 个 `--faint #5a6575` on `#020204`（`SETTINGS` 眉标 8.5px、`模拟` hint 8px、`地址`/`Token`/`传输`/`最近快照` dt 8.5px），实测 **3.51:1**。
- 其余 8–9px（预设按钮 7.57、`SIM` 9.49、`lab-host-state` 8.68、`IMPORT…` 12.20、`v0.1.0` 9.16 等）全部 ≥4.5。

结论：**PARTIAL**。装饰性分隔符不阻断；`--faint` 在设置抽屉中承载「Token/传输/最近快照」等有信息量的标签，属真实 AA 失败。

### 3.4 reduced-motion —— PASS

以 `--force-prefers-reduced-motion` 重启验证：

| 检查 | 实测 |
|---|---|
| `matchMedia('(prefers-reduced-motion: reduce)').matches` | **true** |
| 状态栏 | `v0.1.0 · reduce-motion` |
| `animation-duration` | `.sim-pulse` / `.state-dot` / `.lab-trace-bar` 均 **1e-06s** |
| `transition-duration` | 上述元素及按钮均 **1e-06s** |
| 路由 | 静态 CSS `@media (prefers-reduced-motion: reduce)` 命中全部 `*`（`animation-duration`/`transition-duration` 0.001ms） |

### 3.5 200% 缩放 / 小窗口 —— PARTIAL

| 场景 | 视口 | 横向溢出 | 裁切的交互元素 | Paper Lab | HUD/状态栏/Agent 面板 |
|---|---|---|---|---|---|
| 100% | 1524×878 | 无 | 0 | `display:grid`，6 host 按钮 + file input 可用 | 可见 |
| **200% 缩放** | **762×439** | 无（scrollWidth 762 = clientWidth） | 0 | **`display:none`**（lab console 整体隐藏，6 host 按钮/file input 不可见） | 可见 |
| 小窗口 1000×640 | 1000×640 | 无 | 0 | **`display:none`** | 可见 |

原因：Paper Lab 只在 `@media (min-width:1080px) and (min-height:690px)` 内渲染（`styles.css:935`），其外层默认 `.lab-console{display:none}`。后果：**200% 缩放下新功能的内容与操作全部丢失**，对应 WCAG 1.4.4（Resize Text）不满足；HUD 主界面本身无溢出、无裁切、无失焦风险。

### 3.6 具体失败项清单（不空泛）

| # | 失败项 | 位置 | 实测值 | 影响 |
|---|---|---|---|---|
| A1 | `.status-sep` 分隔符对比度 | 状态栏 4 处 | 1.30:1（`rgba(255,255,255,.12)` 8.5px） | 装饰性；建议 `aria-hidden` 或提亮 |
| A2 | `--faint` 文本对比度 | 设置抽屉 6 处（`SETTINGS`、`模拟`、`地址`、`Token`、`传输`、`最近快照`） | 3.51:1（`#5a6575` 8–8.5px） | 真实 AA 失败，需 ≥4.5 |
| A3 | 200% 缩放 Paper Lab 丢失 | `styles.css:933-935` 媒体查询 | `display:none`，宿主 6 按钮/file input 不可达 | WCAG 1.4.4 内容丢失 |
| A4 | 小窗口（<1080×690）同上 | 同上 | `display:none` | 同上（可能是产品取舍，需文档化） |
| A5 | 全局 focus outline 偏细 | `styles.css:1873` | 0.8px（CSS 1px） | AA 可见，AAA 不足；建议 ≥2px |
| A6 | file input 目标高度 | `#lab-obsidian-file` label | 355×19 px | <24px（WCAG 2.2 AA 2.5.8 边缘） |

---

## 4. 证据清单

### 安全

| 文件 | 说明 |
|---|---|
| `tests/evidence/p2-security/test-security.stdout.txt` / `.stderr.txt` | 官方套件完整输出（13/13） |
| `tests/evidence/p2-security/security-probe.json` | 21 项定向探针逐项证据（含期望/实测/耗时） |
| `tests/evidence/p2-security/bridge-debug.log` | 真实 bridge debug 日志（脱敏验证原始材料） |
| `tests/evidence/p2-security/xss-e2e.json` / `xss-dom.json` | XSS 端到端（入口回显 + DOM 结果 + 隔离/CSP） |
| `tests/evidence/p2-security/probe.mjs` | 定向探针脚本（可重跑，exit 0/1） |
| `tests/evidence/p2-security/xss-run.mjs` | XSS 编排脚本 |
| `tests/evidence/p2-security/electron-probe.cjs` | Electron 主进程探针（xss/a11y/fps 三用） |

### 性能

| 文件 | 说明 |
|---|---|
| `tests/evidence/p2-perf/soak-30min.json` | 30 分钟 soak 原始 JSON（每 5 s 一个样本） |
| `tests/evidence/p2-perf/fps-window-12s.json` / `fps-window-run1.json` / `fps-window-run2.json` | 12 s 逐秒 rAF 样本 ×3（同一构建，含渲染进程指标与 GPU 状态） |
| `tests/evidence/p2-perf/fps-window.png` | 采样窗口截图 |
| `tests/evidence/p2-perf/window-status-10s.png` | 生产启动器 window 1200×800 第 10 s 状态栏（40 fps） |
| `tests/evidence/p2-perf/overlay-status-10s.png` | overlay 1536×912 第 9 s 状态栏（37 fps） |
| `tests/evidence/p2-perf/compact-status-10s.png` | compact 320×320 第 9 s HUD（60 fps） |
| `tests/evidence/p2-perf/analyze-soak.mjs` / `soak-30min-analysis.json` | soak 分析脚本与汇总（趋势/GC/斜率） |
| `tests/evidence/p2-security/worktree-hashes.mjs` / `worktree-hashes.json` | 测量期间源码哈希快照（pre/post，changed=[]） |

### 无障碍

| 文件 | 说明 |
|---|---|
| `tests/evidence/p2-security/a11y-probe.json` | 默认状态：17 个可聚焦元素、18 站 Tab 序列、对比度、缩放、小窗口 |
| `tests/evidence/p2-security/a11y-reduced-motion.json` | reduced-motion 专项 |
| `tests/evidence/p2-security/a11y-drawer-open.json` | 设置抽屉打开后的对比度（10 个失败）与抽屉内 Tab 顺序 |
| `tests/evidence/p2-security/a11y-window.png` | 无障碍检查窗口截图 |

---

## 5. 风险与限制

| # | 风险 | 级别 | 说明 / 建议 |
|---|---|---|---|
| R1 | Windows 上 token 文件 mode=0666（POSIX 0600 不可等价） | 中 | docs/03 §6 已列为 PARTIAL；实测 65 B 文件落在 `%TEMP%` 或 `%LOCALAPPDATA%\HALOFLUX`，依赖用户目录 ACL。建议文档明确「共享账户机器上需自行收紧 ACL」 |
| R2 | `?token=` 走 URL 的 SSE 鉴权 | 中 | 仅 loopback 可达，但 token 会出现在本机 URL/潜在本机日志中；渲染器不回显（`settingsToken` 显示「已配置（不回显）」）。建议后续改为一次性 ticket |
| R3 | renderer `sandbox:false` + CSP `script-src 'unsafe-inline'` | 中 | docs/03 §6 已知取舍；本次实测无注入 sink、CSP 能阻断出网，但若未来新增 `innerHTML` 会立刻变成可利用 XSS |
| R4 | bridge 事件字符串无字符集白名单 | 低（有渲染侧兜底） | 仅长度上限；安全依赖「渲染侧只 textContent」。建议加一条 CI 守卫：禁止 renderer 出现 `innerHTML`/`insertAdjacentHTML` |
| R5 | 30 分钟 soak 的请求速率 | 低 | 目标 8/s、**实测 6.30/s（11311 条）**：`scripts/soak.mjs:583-594` 每轮只发 1 条，每 5 s 的 `getJson`+PowerShell 采样会阻塞 ~0.3–0.6 s，且之后不补发（不产生 postError，只是少发）。CPU/RSS 量级结论不受影响，但本轮不是严格的 8/s 负载 |
| R6 | 本机 GPU 合成路径不稳定 | 低 | 采样会话 `gpu_compositing=disabled_software` 且出现 `GPU state invalid…` 报错；故 fps 只作「可见窗口不劣于 docs 基线」的弱结论 |
| R7 | 200% 缩放/小窗口下 Paper Lab 隐藏 | 中 | 见 A3/A4；如果 Paper Lab 是核心功能，需要单独的低分辨率布局或至少给出可见提示 |
| R8 | 沙箱化 CIM/netstat 视图 | 低（证据方法学） | 本会话 `Get-NetTCPConnection` 查询失败、`netstat` 仅 9 行且 PID 归零，故 §1.2 S1 用「非回环不可达 + 端口占用/可绑定对照」作为权威绑定证据 |

## 6. TODO（未测 / 未完成，不得引用为结论）

- [ ] overlay / compact 的 rAF 逐秒均值（本次只拿到 HUD 单次快照 37 / 60）。
- [ ] ≥2 h soak + 强制 GC 后 RSS 基线；本次 30 min 只能说明「未失控」，不能判定泄漏。
- [ ] 20+ 会话、单会话长事件流（70 万 token 量级）下的状态机内存与 UI 渲染。
- [ ] 真实 GPU 合成路径下的 fps/CPU/GPU 细分：本机 Electron 报告 `gpu_compositing=disabled_software`，需换驱动/环境复测。
- [ ] 键盘全流程：抽屉打开后按 Escape 关闭、focus 返回触发按钮（本次只验证抽屉内 Tab 顺序）。
- [ ] 屏幕阅读器实测（NVDA）：aria-label / aria-pressed / `reduce-motion` 语义。
- [ ] 高对比度模式（Windows 强制颜色）与 200% 缩放下的 Paper Lab 替代布局。
- [ ] 429 限流对「多 socket」并发（本次只验证单 socket 240/s 与跨 socket 隔离）。
- [ ] 真实宿主 hook 安装后的端到端安全（沿用 docs/03 §6 NOT_TESTED，本轮未触碰用户配置）。
