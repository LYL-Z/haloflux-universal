# 最终验证报告（Final Verification）

- 时间：**2026-11-08 16:29–16:36 UTC**（America/Los_Angeles 08:29–08:36）
- 机器：Windows 11 10.0.26300 x64 / Intel Core Ultra 9 290HX Plus（24 核）/ 63.7 GiB / RTX 5090 Laptop
- Node v24.16.0；Electron 43.3.0（DeepSeek Harness 自带，无新增下载）
- 仓库根：`D:\HALOFLUX`；测试 bridge 一律 179xx 随机端口，不使用生产 17817
- 结论口径：`PASS` = 真实宿主验证；`PARTIAL` = 部分链路或仅派生数据；`SIMULATED` = 仅合成 payload；`UNSUPPORTED` = 宿主无该能力；`BLOCKED` = 前置条件缺失；`NOT_TESTED` = 未执行。
- 原始证据：`tests/evidence/final-doctor.json`、`final-bridge-state.json`、`soak-5min.json`、`screenshots/capture-report.json`、`tests/host/evidence/*.json`。

---

## 1. 构建与测试（本次实测）

| 命令 | 结果 |
|---|---|
| `npm run build` | **通过（exit 0）**：`tsc -p tsconfig.json` 编译 `@haloflux/event-schema` |
| `npm test` | **77 tests / 77 pass / 0 fail / 0 skipped / 0 todo**（11.08 s；unit + e2e + security） |
| `node --test "packages/visual-core/test"` | **39 pass / 0 fail**（预设往返、参数 clamp、状态映射、perf 降级/恢复） |
| `node --test "packages/event-bridge/test" "packages/session-manager/test" "packages/settings/test"` | **58 pass / 0 fail** |
| `node --check` 脚本 | capture.mjs / soak.mjs / 全部 host 脚本语法通过 |

`npm test` 明细：

| 套件 | 数量 | 覆盖 |
|---|---|---|
| `tests/unit/` | 53 | event-schema 常量/合法/非法/隐私白名单/8KB·4KB·1KB 限制/批量；settings 默认/校验/原子写/损坏恢复/连续写；session-manager 去重/乱序/超时阶梯/200 事件上限；visual-core 导出/6 预设往返/参数 clamp |
| `tests/e2e/` | 11 | 真实 bridge 子进程：health/state/单事件/完整状态链/去重/批量/400/批量上限/SSE snapshot+update/settings GET+PUT |
| `tests/security/` | 13 | 无 token 401、错 token 401、X-Haloflux-Token、SSE query token、300KB→413、畸形 JSON→400、慢速 trickle、Origin/Host 拒绝、路径穿越不泄漏、非回环不可达、响应不回显 token |

测试不使用外部网络；bridge 相关测试使用随机回环端口（17910–17999）与隔离 `HALOFLUX_HOME`，不占用 17817。

## 2. 宿主安装状态（`scripts\doctor.ps1 -Json`，exit 0）

| 宿主 | 状态 | 安装条目 | 配置 | 哈希与 manifest 一致 |
|---|---|---|---|---|
| Claude Code 2.1.299 | **INSTALLED** | 9 hooks | `~/.claude/settings.json` | yes |
| Codex 0.154.0 | **INSTALLED** | 8 hooks | `~/.codex/hooks.json` | yes |
| Cursor 3.29.9 | **INSTALLED** | 11 hooks | `~/.cursor/hooks.json` | yes |
| WorkBuddy 5.9.3 | **INSTALLED** | 1 MCP server | `~/.workbuddy/mcp.json` | yes |
| TRAE CN 3.4.13 | **UNSUPPORTED** | 0 | `~/.trae-cn/hooks.json`（未创建） | — |
| DeepSeek Harness 0.2.1-rc.5 | **INSTALLED** | 2 Cordis bundle | profile `desktop` | 安装返回 `application=applied`、`warnings=[]` |
| Generic | NO-INSTALL-NEEDED | — | stdin JSONL | — |

桥接服务：`ONLINE http://127.0.0.1:17817 (v0.1.0)`；token 文件存在可读；4 个宿主配置有备份 manifest（`config/backups/20261108T161709355Z` 等，可回滚）。

## 3. 真实事件链路（live bridge，非模拟）

`GET /v1/state`（2026-11-08T16:28:53Z 快照，`tests/evidence/final-bridge-state.json`）：
**`eventCount=567`、`dropped=0`、11 个会话**；`capabilitiesSource` 均为 `adapter`（来自各 `adapters/<host>/capabilities.json`），warnings 为空。

| 宿主 | 真实证据 | 状态 |
|---|---|---|
| DeepSeek Harness | 5 个会话（4 个 host-native + 1 个派生 heartbeat）；`8e5d1bbb…` 完整链 `session.start → run.start → tool.start → tool.end → tool.fail → output.end → run.end → session.end`；`49c15aba…` 运行中；工具名 pwsh/read/grep/edit；tokenCount/contextUsed 来自真实 usage | **PASS**（启动/新会话/提交/工具/完成/关闭） |
| Claude Code | 真实 `claude -p` 触发新会话 `0c054ee3…`（本次 QA 复现）+ Lead 先前 2 个会话；链 `session.start → task.received → error → session.end`，host-native/confirmed；`claude auth status` = not logged in | **PARTIAL**（生命周期 PASS，工具/完成 BLOCKED） |
| Codex | `codex exec` 未产生新会话（hook trust/参数问题）；只读 rollout watcher 派生真实事件（`session.heartbeat`/`run.end`/tool 事件，derived/inferred）；隔离 `CODEX_HOME` 实验证明 Codex 会执行 hooks.json（marker 命中），但 adapter 投递未稳定复现 | **PARTIAL**（派生 PASS，hook 投递 NOT_TESTED） |
| WorkBuddy | 只读 trace watcher 派生真实事件（**81 条**，derived/inferred）；mcp.json 已挂 `haloflux-status` MCP server | **PARTIAL**（派生 PASS，MCP 未被宿主实际调用） |
| Cursor | hooks 已按官方 bundle 证据安装 11 条；GUI 宿主无法 headless 触发 | **PARTIAL**（安装 PASS，真实事件 NOT_TESTED） |
| TRAE | hook 资产路径存在但事件规范未证实；安装器默认拒绝写入 | **UNSUPPORTED** |
| Generic | stdin JSONL → 真实 bridge 往返，完整会话 idle | **PASS** |

隐私验证：真实 bridge state 中检索测试用 `SECRET_PROMPT` / `SECRET` 均为 0 命中；schema 层拒绝 `metadata.prompt`（400 + issue path），事件无法携带提示词/正文/工具参数。WorkBuddy `trace.name → label` 泄漏已修复并回归通过。

## 4. 宿主证据脚本（`node tests/host/<host>.mjs`）

每个脚本自起 179xx bridge、写 `tests/host/evidence/<host>.json`、退出 0：

| 宿主 | 本次脚本结果 | 备注 |
|---|---|---|
| DeepSeek Harness | PARTIAL（脚本对 dsh-dev probe 日志的独立校验） | 36 事件 schema 合法、4 真实 session、tool.start×12/tool.end×12；矩阵按实时 bridge 证据判 PASS |
| Claude Code | PARTIAL | hooks 已装；真实进程新增 1 个会话（session.start/task.received/error/session.end）；未登录导致无 tool/run.end |
| Codex | PARTIAL | 真实 rollout watcher 派生；真实 `codex exec` 未产生新会话 |
| Cursor | PARTIAL | 11 hook 已装；无 headless 触发；合成映射 6 事件通过 |
| WorkBuddy | PARTIAL | 真实 trace watcher 派生 81 事件；fixture 4 事件 derived/inferred |
| TRAE | SIMULATED | 安装被拒绝；合成映射 6 事件全部 derived/inferred |
| Generic | **PASS** | stdin JSONL 完整会话；secret 未泄漏 |

## 5. 视觉与桌面伴随窗口

| 项 | 证据 |
|---|---|
| 6 预设 | `screenshots/preset-{original,minimal,sci-fi,focus,ambient,agent-monitor}.png` |
| 10 状态 | `screenshots/state-{disconnected,connected,idle,running,tool,output,waiting_approval,done,error,unknown}.png` |
| 总览 / 多 agent | `screenshots/ui-overview.png`、`screenshots/multi-agent.png` |
| 真实 bridge 界面 | `screenshots/visual-live-bridge.png`（11 sessions、host-native、无水印） |
| 模拟演示水印 | `screenshots/visual-renderer.png`（`?demo=1`，可见「示例数据 · SIMULATED」） |
| 三模式 | `screenshots/bridge-window.png`（window 31 fps）、`bridge-overlay.png`（overlay 24 fps，点击穿透/置顶/不透明度）、`bridge-compact.png`（compact 320×320；fps 见 06） |
| 真实 DSH 语义 | `screenshots/companion-live-dsh.png`：宿主原生 · host-native、确认 · confirmed、事件流真实工具名 |
| 上游基线 | `screenshots/upstream-original.png`（上游 lab.html 的 Paper Lab Console 场景） |
| compact 断点 | `screenshots/visual-compact.png`（320×320，无溢出） |

`node scripts/capture.mjs`（本次 QA 实测）：**PASS，shots=18，required=17，17/17 必需截图非空**；
报告 `screenshots/capture-report.json`（逐张 URL/字节数/耗时/重试）。截图由离屏 Electron + 软件渲染生成（截图/soak 管线固定 `HALOFLUX_SOFTWARE_RENDER=1`，避免本机 Electron 43 的 GPU 崩溃；真实 companion 窗口默认 GPU）。

## 6. 性能（摘要，详见 `docs/06-performance.md`）

- 桌面窗口（1600×900 逻辑、DPR 2.5、GPU，Lead 实测）：window **31 fps / 4.6 ms**；overlay **24 fps / 5.0 ms**；compact **24 fps / 2.6 ms**。
- QA 5 分钟 soak（`tests/evidence/soak-5min.json`）：1684/1684 事件接受、12 会话、bridge CPU 平均 **0.03%**、RSS 65.09→71.26 MB（+6.18 MB）、离屏 renderer fps 平均 **0.91**（隐藏窗口节流，不代表可见窗口）、renderer JS heap 10.21→16.28 MB、renderer CPU 平均 **4.08%**。
- 软件渲染 capture 仅 1–7 fps，是截图/隐藏窗口管线限制，不代表产品路径。
- 性能守卫：60 fps 上限、空闲 24 fps、42 fps 持续 1.2 s 自动降质（×0.75→×0.5）、>55 fps 恢复、窗口隐藏暂停、`prefers-reduced-motion` 支持。
- 未判定内存泄漏：5 分钟 RSS +6.18 MB，需要 ≥30 min soak（TODO）。

## 7. 安全验收

| 项 | 结果 |
|---|---|
| 回环绑定 | 仅 `127.0.0.1`；Host/Origin 校验；非回环地址连接不可达（安全测试实测） |
| Token | 32 字节 hex、常量时间比较、文件 0600（Windows best-effort） |
| 无 token 访问 `/v1/state`、`POST /v1/events`、settings、simulate | **401**（安全测试） |
| 错 token / malformed Bearer | **401**，响应不回显 token |
| 超大 body（>256 KB） | **413**（安全测试） |
| 畸形 JSON | **400**，bridge 存活 |
| 慢速 trickle | 202/400 正常结束，bridge 存活 |
| Origin/Host 伪造 | 非回环 **4xx**；loopback/null 允许 |
| 路径穿越（`/v1/stream?token=../../token` 等 5 种） | **401**，不泄漏 token 文件内容 |
| 限流 | 每连接 240 req/s → 429（bridge 单测；QA 未做 240+ req/s 压力断言） |
| 无遥测/无外部请求 | 适配器与渲染器仅访问 `127.0.0.1`；无 CDN/字体/远程脚本 |
| Hook 失败不影响宿主 | 全部 adapter `exit 0`、stdout 空；不返回权限决策 |
| 配置可逆 | 4 个真实配置备份 manifest + 哈希；隔离根 install→uninstall 与 DryRun 由 adapters-dev 验证 |

## 8. 未能验证 / 已知限制（如实）

1. **Claude Code 工具执行 BLOCKED**：本机 Claude CLI 未登录（`claude auth status` → not logged in），真实 turn 无法完成；凭据可用后需复跑一次工具链路。
2. **Codex hook 投递 NOT_TESTED**：需在 Codex `/hooks` 中信任后复测；当前以只读 rollout watcher 的派生事件为准。
3. **Cursor 真实触发 NOT_TESTED**：GUI 宿主无法 headless 驱动；hooks.json 已装并可由用户在下次使用时验证。
4. **TRAE UNSUPPORTED**：未证实 hooks 事件规范，安装器默认不写配置。
5. **WorkBuddy** 无被动生命周期 hook，`source=derived/confidence=inferred`；UI 显示「推断」。
6. **DSH 切会话 NOT_TESTED**：未观察到 `session.switch`；重启/卸载未演练。`run.end` 已在真实会话中观察到（见 §3），不再列为 PENDING。
7. **重启（所有宿主）NOT_TESTED**；**卸载（真实用户配置）NOT_TESTED**（仅在隔离根/DryRun 验证，备份+manifest+回滚命令已就绪）。
8. **30 分钟以上 soak / 内存泄漏判定 TODO**；可见窗口连续 fps 仅 Lead 单点（31/24/24，GPU 路径），QA 的自动化 soak 固定软件渲染，无法在同一管线复测 GPU fps。
9. **240 req/s 限流压力 NOT_TESTED**；macOS / Linux 未测试。
10. DSH 插件热更新需重启 DSH 才会加载新模块；本次未重启宿主以免打断会话。

## 9. 验证中发现并修复的问题

1. **event-schema `toolStatus` 枚举未生效**（STRING_FIELDS 先命中导致枚举分支不可达）→ 报告 Lead，修复并重建 dist，QA 单测转为正式断言。
2. **SSE 查询参数 token 被全局 header 鉴权拦截** → `GET /v1/stream?token=…` 401；bridge-dev 修复为 stream 单独鉴权。
3. **SSE 从不发送 update 帧**（`scheduleClientUpdate` 未接线）→ bridge-dev 增加 `manager.subscribe`；e2e 从 timeout 变为 2.4 s 通过。
4. **WorkBuddy `trace.name` 进入 metadata.label**（可能含 prompt 文本）→ adapters-dev 改为常量 label，隐私回归通过。
5. **QA host harness 误把旧会话算作真实 PASS** → 修正为"真实进程启动后新增会话才 PASS"；Codex 由误报 PASS 降回 PARTIAL。
6. **capture 静态服务根目录错误**（renderer 的 `../../../packages` 导入 404，画布空白）→ 改为服务仓库根；17 张截图真实有内容。
7. **Electron 43.3.0 间歇崩溃（exit -1）** → capture 首次运行 sci-fi 失败，重跑 17/17 通过；已记录机器约束。

## 10. 最终判定

- 统一系统可运行：**通过**（bridge + companion + 6 宿主 adapter + DSH 原生插件）。
- 真实事件驱动动画：DeepSeek Harness **PASS**；Claude Code 生命周期 **PASS**、工具 **BLOCKED**；Codex/WorkBuddy **PARTIAL（派生）**；Cursor **PARTIAL（安装）**；TRAE **UNSUPPORTED**；Generic **PASS**。
- 测试、构建、截图、5 分钟浸泡均通过；所有未验证项均在 UI 能力芯片、矩阵与本文档中明确标注，未以模拟数据冒充真实状态。
