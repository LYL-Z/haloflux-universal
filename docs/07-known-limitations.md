# 已知限制（Known Limitations）

> 最后更新：2026-11-08 16:30 UTC。只列真实存在/未验证的项，不用"计划中"冒充"已完成"。
> 状态词汇：NOT_TESTED / PARTIAL / UNSUPPORTED / BLOCKED，与 `docs/01-host-capability-matrix.md` 一致。

## 1. 宿主接入

| # | 限制 | 影响 | 现状 / 证据 | 规避方式 |
|---|---|---|---|---|
| H1 | **Claude Code 未登录**（`Not logged in · Please run /login`） | 真实会话只有 session.start→task.received→error→session.end；工具/完成事件缺失 | 启动/新会话/提交/关闭 = PASS；执行工具/结束工具/完成任务 = BLOCKED（`docs/01` §2.2） | 用户执行 `/login` 后重跑 `claude -p`；hooks 已安装，无需改代码 |
| H2 | **Codex hooks 未触发**：0.154 要求 hook trust，`--dangerously-bypass-hook-trust` 仍无效 | Codex 只能读日志派生，状态置信度为 inferred | PARTIAL；真实 rollout watcher 可用（22 个派生事件），hook 安装 8 条但未生效 | 在 Codex 中信任 hooks / 等官方稳定；或继续用只读 watcher |
| H3 | **Cursor 是 GUI 宿主** | 无法 headless 触发真实 hook，只有合成映射证据 | PARTIAL：hooks 已安装 11 条，真实事件 NOT_TESTED | 在 Cursor 内手动开一个会话观察 bridge |
| H4 | **TRAE hook 词汇未验证** | 安装器主动拒绝写 hooks；只有合成映射，且全部 derived/inferred | SIMULATED / 安装 UNSUPPORTED | 等 TRAE 官方 hook 文档；或在隔离配置里 `-Mode Hooks` 试用 |
| H5 | **WorkBuddy 无被动 hook** | 只能从 trace 日志派生；无 task.received/run.end | PARTIAL（真实派生 81 事件）；提交/完成任务 UNSUPPORTED | 接受"推断"徽章；未来若提供 hook 再替换 |
| H6 | **DeepSeek Harness 的切会话/重启/卸载未测** | session.switch 无真实证据；插件卸载回滚未演练 | 启动/新会话/提交/工具/完成/关闭 = PASS；切会话/重启/卸载 = NOT_TESTED | 由 dsh-dev/Lead 在隔离 profile 演练卸载 |
| H7 | **所有宿主的"卸载"列未在真实配置上执行** | 回滚路径存在但 QA 未实跑（避免破坏 AgentHaven 管理的 hooks） | NOT_TESTED；备份目录与 manifest 已生成（`config/backups/20261108T161709355Z` 等） | 先 `uninstall.ps1 -WhatIf`/隔离 `-ConfigRoot` 演练，再真跑 |

## 2. 安装 / 卸载 / 运维

| # | 限制 | 现状 |
|---|---|---|
| I1 | 统一适配器安装器已落盘 | `scripts/install-adapters.ps1` / `uninstall-adapters.ps1` 支持 `-All/-Hosts/-DryRun/-ConfigRoot/-BackupRoot`；`scripts/install.ps1` 会调用它 |
| I2 | 安装/卸载未做字节级回归 | 安装器设计为备份 + manifest + SHA256 + 回滚；QA 未在真实配置上验证字节一致（避免影响用户现有 hooks） |
| I3 | 适配器 doctor 已接线 | `scripts/doctor.ps1 -Json` 输出安装状态/token/bridge/漂移/回滚命令；根因诊断仍推荐 `node scripts/haloflux.mjs doctor --json` |
| I4 | 无代码签名/安装包 | 通过 `scripts/install.ps1` 从源码目录安装；Windows SmartScreen 可能提示 |
| I5 | 仅 Windows 11 验证 | macOS/Linux 未测试；路径/ACL/Electron 行为不同 |
| I6 | 无自动更新 | 故意不做；升级需重新拉取仓库并 `install.ps1` |

## 3. 性能 / 渲染

| # | 限制 | 现状 / 实测 |
|---|---|---|
| P1 | 自动截图/soak 管线固定软件渲染（`HALOFLUX_SOFTWARE_RENDER=1`），因为 render-app 在本机 Electron 43 的 GPU 路径曾静默崩溃（exit -1） | capture/soak 全部 `disableHardwareAcceleration()`，代价是软件合成；真实 companion 窗口默认 GPU，Lead 实测 31/24/24 fps |
| P2 | 离屏/隐藏窗口的 rAF 被 Chromium 节流 | soak 的 offscreen fps（0.91）只能作为**下限**；真实屏幕 fps 由 Lead 单点实测（`docs/06-performance.md` §3），连续曲线仍 TODO |
| P3 | 软件渲染下 fps 低 | `companion-live-dsh.png` 实测 UI 显示 6 fps / 156.5 ms / 画质 75%；`visual-companion.png` 5 fps / 228.5 ms / 画质 50%。性能守卫会自动降质，但不是"流畅" |
| P4 | 高 DPI 3840×2250 全屏 Canvas 开销大 | 截图在 3840×2250（DPR 2.4）下生成；仓库内为 1600px 压缩副本；未在 1080p 屏幕单独测量 |
| P5 | renderer 依赖 `window.__halofluxQA` 仅用于 QA | 生产路径不要求该 hook；缺失时 capture/soak 会报 NOT_READY/无 fps，不会伪造 |
| P6 | 上游视觉细节未 1:1 复刻 | 本移植是"视觉语言"衍生，参数/镜头细节与 `upstream/haloflux/lab.html` 不完全一致（对比图 `screenshots/upstream-original.png`） |

## 4. 事件 / 数据保真

| # | 限制 | 现状 |
|---|---|---|
| E1 | 部分 adapter 无 `session.switch` | 切会话列 UNSUPPORTED；UI 只能按 session 列表推断 |
| E2 | 流式 `output.chunk` 未由所有宿主提供 | DSH 提供 output 事件；Claude/Codex hooks 只到 run.end；UI 的 token/输出可能显示"—" |
| E3 | `capabilities.json` 不完整时 UI 能力芯片为空 | 依赖 adapters 声明的 caps；缺失时 UI 显示通用提示而非假数据 |
| E4 | WorkBuddy/Codex 派生事件有 200 条/会话窗口限制 | 极长会话早期事件会被环形缓冲淘汰（契约设计） |
| E5 | `metadata.custom` 是 1 KB 扁平标量对象 | schema 允许它承载（短）自定义字符串；adapter 必须自律不写敏感文本；这不是加密/脱敏通道 |

## 5. 安全 / 许可

| # | 限制 | 现状 |
|---|---|---|
| S1 | token 在 SSE URL 查询参数中可见 | 契约允许（仅回环）；不要在日志/截图中暴露完整 URL |
| S2 | Windows 无 POSIX 0600 语义 | `chmod` 仅映射只读位；依赖 `%LOCALAPPDATA%` 用户 ACL |
| S3 | Electron renderer `sandbox:false` | 本地静态页面 + contextIsolation + nodeIntegration:false；未启用 OS 级沙箱 |
| S4 | 未做 240 req/s 限流压力断言 | 代码有限流；QA 未在共享机器上做 240+ req/s 压测（见 `docs/03` §6） |
| S5 | 非商业许可 | PolyForm NC 1.0.0：不得商业使用、不得公开再分发（未经用户同意）；必须保留 LICENSE/NOTICE/署名 |
| S6 | 上游字体外链 | 原作 HTML 引用 Google Fonts；本移植已移除，renderer 无第三方字体请求 |

## 6. 文档 / 证据

| # | 限制 |
|---|---|
| D1 | 性能数字只覆盖本机（Intel Core Ultra 9 290HX / RTX 5090 Laptop / Windows 11 / Node 24.16 / Electron 43.3.0），不外推 |
| D2 | 宿主证据的时间窗口有限；截图/日志会随真实会话变化 |
| D3 | 截图中的 fps/画质 HUD 是运行时快照，与 soak 的连续采样口径不同（已分别注明） |
