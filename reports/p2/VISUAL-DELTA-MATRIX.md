# P2 · 原版视觉 A/B 差异矩阵（Visual Delta Matrix）

- 分支：`feat/paper-lab-p2`（基于 `5fc9338`）
- 采集时间：2026-11-09T12:20–12:45Z（America/Los_Angeles 04:20–04:45）
- 环境：Windows 11 / Intel Ultra 9 290HX / RTX 5090 Laptop / Node 24.16 / Electron 43.3.0（DSH 自带）
- 渲染条件：Electron 隐藏窗口 + 本地 HTTP 静态服务；截图统一 **DPR 1**、逻辑尺寸 1600×900 / 1280×720 / 1920×1080；软件渲染（capture 路径），因此 fps 不作为性能结论
- 对照对象：上游 **当日** `lab.html`（commit `02174503`；`lab.html` 最新改动 `65721940`，LF 归一化 SHA `e7dc413f…`，与本仓库 `upstream/haloflux/lab.html` 文本一致）
- 人工评分仅为当前自评，最终以用户审核为准；本文件不宣告视觉 PASS。

## 0. 证据文件

| 用途 | 路径 |
|---|---|
| 原版 1600×900 | `screenshots/p2/upstream-1600x900.png` |
| P1 前（main）1600×900 | `screenshots/p2/before-1600x900.png` |
| P2 后 1600×900 | `screenshots/p2/after-1600x900.png` |
| P2 后 1280×720 / 1920×1080 | `screenshots/p2/after-1280x720.png` / `after-1920x1080.png` |
| 原版 1280×720 / 1920×1080 | `screenshots/p2/upstream-1280x720.png` / `upstream-1920x1080.png` |
| 30 秒动态录屏 | 仓库外 `D:\HALOFLUX-media\p2\after-1600x900-30s.webm`（35,564,262 B，SHA256 `dc9681fd1e15db63ee61f0a8d25fdc43cad2e1d3463be18a27200b69f16956cb`，30.013 s，VP9，3840×2250 Canvas 物理像素） |
| 录屏抽帧 | `D:\HALOFLUX-media\p2\probe\frame-{01,10,20}s.png`（1/10/20 s，已合成黑底） |

## 1. 矩阵

| # | 维度 | 原版证据 | 当前截图 | 问题（修复前） | 本轮修复 | 新截图 | 自评 | 未完成点 |
|---|---|---|---|---|---|---|---|---|
| 1 | 光环构图：偏左巨大环、半径与弧线位置 | `upstream-1600x900.png`：环在 y=300 处亮度带约 x≈800–880，顶部约 x≈540–600 | `before-1600x900.png`：光环偏暗、居中、被左右圆角卡片遮挡 | P1 补丁把 `scale` 设为 1、`centerX=0`，环比原版大约 14%，整体偏右 | `presets.js` 将 `scale` 1 → **0.86**；实测顶部/中部弧线与原版基本对齐（1600/1920） | `after-1600x900.png` / `after-1920x1080.png` | **4/5** | 1280×720 下环仍比原版偏大/偏右约 5–7%（引擎按高度缩放，未做宽高比分档） |
| 2 | 黑白层次与对比：高亮弧带 / 微弱细丝 / 暗区 / 扫描线 | 原版黑底纯净、弧带高对比、细丝成网、右侧束流有暗间隙 | `before`：整体灰、蓝紫氛围、白色噪声少但层次平 | P1 补丁亮度/束流过高，右侧出现大片白色浑浊；缺少原版的暗间隙 | `opacity 0.83→0.80`、`glow 1.2→0.98`、`beamBright 1.65→1.3`、`beamGlow 2.5→1.6`、`comet/burst/haze` 下调 | `after-*` | **3.5/5** | 右侧束流仍比原版更亮、更连续；原版的扫描线/CRT 纹理未复刻（仅 grain） |
| 3 | 底部监控台：两行多列、方角、高密度 | 原版 4 列 × 2 行，高度约 290–300 px，单元格标题约 13–14 px | `before`：左右圆角卡片 + 右侧事件流 | 旧 HUD 是通用 SaaS 卡片，非底部仪表 | P1 补丁新增 8 个方角 cell；本轮修 `.lab-h` 固定 **288 px**（≥1600 时 300 px），标题 9→11/12 px，正文 9→10/11 px，列间距/边框对齐原版 | `after-*` | **4/5** | 文本仍比原版小 1 档（10–12 vs 13–14）；原版有粒子求解动画、代码 workbench、差异场等专用小画布，本实现以真实事件计数/详情替代 |
| 4 | 顶部 masthead | 原版：单行品牌 + PAPERS/AGENTS/METHODS/REF. SCENES/FURTHER REVIEW 五个 KPI + BGM/console | `after`：41 px 顶栏，品牌 + 六预设切换 + 连接状态 + 图标 | 原版 KPI 是虚构业务数字，**不可照抄**；但当前顶栏偏空、偏"工具条" | 保持真实数据不伪造；顶部只保留可操作入口，真实计数放在底部 ledger（HOSTS/SESSIONS/EVENTS） | `after-*` | **2/5** | 与原版差异最大的一处：缺少原版 masthead 的横向 KPI 节奏；若要接近，只能用真实指标（hosts/sessions/events/tool/errors）重排，需用户确认是否接受 |
| 5 | 运动逻辑与状态 | 原版：节拍驱动、卡顿急停、5 层光束、自动运镜 | 30 s WebM：环旋转、束流、粒子持续运动；10 状态截图 | 旧版状态与动画映射已有，但缺与原版同相位的并列录屏 | 未改引擎运动逻辑（沿用 visual-core），本轮补齐 30 s 动态证据与 6 预设/10 状态截图 | `after-1600x900-30s.webm` + `state-*.png` | **3/5** | 尚未逐状态与原版同相位 A/B（原版没有 Agent 状态语义，只能比"运动质感"）；运镜/节拍差异仍在 |
| 6 | 数据真实性 | —— | `after-*`：`SIMULATED` 水印、`—` 缺失指标、事件来源 SIM/NAT/DRV | 无 | 保持 P1 投影只读白名单；本轮新增 toolCallId/runId 关联（见 `OBSERVABLE-EVENT-TRACE.md`），无数据显示 `—`/`UNCORRELATED` | `after-*` | **5/5** | 无（禁止伪造是本项目硬约束） |
| 7 | 响应式 | 原版 1280/1600/1920 均可读 | `after-1280x720.png` | 1280×720 时 P1 面板高度 259 px，底部 `OBSERVATION` 被裁切 | 固定 288 px + 大屏 300 px；1280 下 8 cell 全部可见，无横向溢出 | `after-1280x720.png` | **4/5** | <1080×690 回落旧 HUD（设计如此）；200% 缩放时 Paper Lab 控制台被隐藏（P6 无障碍报告 PARTIAL） |
| 8 | 可访问性/可读性 | 原版同样偏小字（8–10 px），但对比度高 | `after-*` | 旧版 8–9 px 偏多 | 本轮主体 10–12 px；host 按钮原生 focus-visible；对比度问题见 P6 报告 | `after-*` | **3/5** | 状态栏分隔符对比度 1.30:1、设置抽屉部分 `--faint` 3.51:1 未达 AA；高密度与可读性仍需一档"大字模式" |
| 9 | 许可/署名 | 上游 2026-11-09 新增分享署名条款 | `LICENSE` 已同步 | 旧 LICENSE 缺少社交平台分享条款 | 已替换为上游当日 LICENSE，README/NOTICE 增加"发布截图/录屏须注明来源" | `LICENSE`、`README.md` §9、`NOTICE` | **PASS** | 发布到任何平台时必须执行该署名 |

## 2. 本轮实际修改（代码）

| 文件 | 修改 |
|---|---|
| `packages/visual-core/src/presets.js` | `agent-monitor`：`scale 1→0.86`；`opacity 0.83→0.80`；`glow 1.2→0.98`；`beamBright 1.65→1.3`；`beamGlow 2.5→1.6`；comet/burst/haze/flare 下调 |
| `apps/companion/renderer/styles.css` | 监控台高度改为 `--lab-h`（288 px，≥1600×900 时 300 px）；标题 11/12 px、正文 10/11 px；cell padding 8×12；host/图表/导入控件字号同步；新增大屏媒体查询 |
| `apps/companion/renderer/app.js` | RUN/PHASE 单元新增 `TOOL / DURATION`（真实 `toolCallId` 匹配的耗时；否则 `—` + `UNCORRELATED`） |
| `README.md` / `NOTICE` / `LICENSE` | 同步上游 2026-11-09 许可与分享署名条款 |

## 3. 结论与准入

- 与 `before-1600x900.png` 相比，当前版本已从"通用 SaaS HUD"转为"Paper Lab 式巨大偏左光环 + 方角高密度底部监控台"，构图/层级/密度三项显著接近原版。
- 与原版仍存在三处关键差异：**顶部 masthead 的 KPI 节奏缺失（不可伪造数据）**、**右侧束流仍偏亮**、**底部单元格缺少原版的专用小画布/代码面板**。
- 本轮自评 **PARTIAL（视觉候选）**，不宣告 PASS；是否达到"看起来真正像 HALOFLUX"需用户看 `after-1600x900.png` 与 30 s 录屏后判定。
- 若用户要求继续：建议下一步（1）用真实指标重排顶部 masthead；（2）为 `TOOL / EXECUTION FIELD` 增加按时间的真实事件到达率折线；（3）复刻扫描线与更细的弧带刻度纹理；（4）针对 1280×720 增加环缩放分档。
