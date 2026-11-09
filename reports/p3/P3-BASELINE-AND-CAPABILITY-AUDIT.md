# P3.0 · 基线与能力审计（Baseline & Capability Audit）

- 分支：`feat/paper-lab-p2`，审计起点 `4206753`（PR #1，Draft）
- 审计时间：2026-11-09T14:45–15:05Z
- 结论：P2.2 的事件级 provenance 与关联修复成立；**无人值守生命周期、持久事件存储、模型级可观测性**此前缺失，本轮开始补齐。
- 原则：能从代码/实测证明的写 PASS，只有接口能力不足的写 BLOCKED/NOT_IMPLEMENTED，不把报告文字当证据。

## 1. 审计范围

`scripts/haloflux.mjs`、`scripts/collectors.mjs`、`packages/event-schema`、`packages/event-bridge`、`packages/session-manager`、`packages/visual-core`、`apps/companion`、`adapters/deepseek-harness` 及其他 adapter、P2–P2.2 报告、PR #1/CI。

## 2. 发现与处置

| # | 发现 | 证据 | 严重度 | 处置 |
|---|---|---|---|---|
| A1 | `scripts/haloflux.mjs`、`launch-companion.mjs`、`capture.mjs`、`soak.mjs`、`p2-capture.mjs`、`install.ps1` 含 `C:\Users\Lenovo` 绝对路径 | `Select-String` 扫描 11 处 | 高（换用户/换机即失效） | **已修**：改用 `homedir()` / `$env:USERPROFILE` / `HALOFLUX_ELECTRON` |
| A2 | 无无人值守 supervisor；bridge/collectors 由手工 `start` 启动，崩溃后无人拉起 | 旧 `cmdStart` 只 spawn 一次 | 高 | **已实现** `Supervisor` + `supervise` + 单实例锁 + 退避 |
| A3 | 无 Windows 登录自启动；用户每次开机需手动执行命令 | 无 Task Scheduler 代码 | 高 | **已实现** 当前用户 `AtLogOn` 任务（已安装并实测） |
| A4 | PID 文件只存数字，PID 复用可能误杀 | `readPid`/`killTree` | 中 | **部分修复**：supervisor 使用独占锁 + PID/命令字段；bridge/companion 仍无命令行校验 → PARTIAL |
| A5 | 事件缓存口径混用风险：session 200 条、renderer 30 条、无持久历史 | `recentEventsLimit: 200`、`state.events.length > 30` | 中 | **已标注** `CACHED (NOT TOTAL)`；**Event Store/Replay 未实现** |
| A6 | 仅有 lifecycle/tool/output 等 19 类事件，没有 model.request/model.stream/retrieval/memory/validation | `EVENT_TYPES` | 高（深层可视化上限） | **数据模型部分补齐**（trace/span/agent/turn 可选字段）；model 事件仍 **NOT_IMPLEMENTED** |
| A7 | 事件级 `source/confidence` 在 P2.2 已贯通，但适配器 schema-lite 会丢弃新增顶层字段 | `schema-lite.createEvent` | 中 | **已修**：保留 trace/span/status 等可选字段；SessionManager 也保留 |
| A8 | DSH 插件在 DSH 启动时若 bridge 未运行，不会补发历史/自动恢复；本轮观测到只有 derived heartbeat | 真实 `/v1/state`、bridge 日志 | 高（运维） | **顺序约束写入文档**：先 bridge（supervisor 登录自启），再打开 DSH；不注入/不绕过宿主 |
| A9 | token 文件在 Windows 实测 mode 0666（P6） | `SECURITY-PERFORMANCE.md` | 中 | 未在本轮修复；记录为 PARTIAL |
| A10 | 无持久事件存储，无法确定性回放/对比 | 代码中无 EventStore | 高 | **NOT_IMPLEMENTED**，列入 P3.2 后续 |
| A11 | `start` 的 `cmdCollectors(['start'])` 会启动 Codex/WorkBuddy 只读 watcher；重复触发可能产生重复进程 | `collectors.mjs` | 中 | supervisor 只调用一次 + collectors PID 文件；仍需 PID 命令行校验（同 A4） |
| A12 | PR/CI 当前 green，但报告曾出现旧测试数字/旧 PR 状态 | `FINAL-GATE.md` 历史 | 低 | P2.2 已修正；本轮新增报告单独记录 |

## 3. 数据层次覆盖（审计时）

| 层 | 现状 | 证据 |
|---|---|---|
| Host / Process | 连接状态、hostVersion；无 OS 级 CPU/内存 | `/v1/state.hosts` |
| Session / Run / Turn | 有 sessionId/runId/turn 指标；turnId 可选字段新加，宿主未提供 | schema + session-manager |
| Agent | `agentName` 元数据；无 DAG 调度命令 | adapter |
| Tool Call | start/end/fail + toolCallId + runId + 真实耗时 | P0.1/P2.2 测试 |
| Model Request / Stream | **无**（DSH adapter 不暴露 request/TTFT/token usage 事件） | `EVENT_TYPES` |
| Retrieval / Memory | **无** | 同上 |
| Validation | 只有 `error`/`tool.fail`，没有“验证通过”事件 | 同上；UI 保持 `—/—` |
| Error / Retry / Recovery | error/tool.fail + 状态；无 retry/backoff 事件 | session-manager |
| Provenance | 每事件 source/confidence；四层贯通 | P2.2 报告 + 真实 DSH 截图 |
| Replay | 无 | 无 EventStore |

## 4. 生命周期现状（本轮后）

```
Task Scheduler (AtLogOn, current user, Limited)
  └─ node scripts/haloflux.mjs supervise
       ├─ singleton lock (run/supervisor.lock)
       ├─ bridge 127.0.0.1:17817
       ├─ collector supervisor (Codex/WorkBuddy read-only)
       ├─ health probe every 10 s
       ├─ bounded backoff (1s→30s, max 5)
       └─ stop flag (run/supervisor.stop) wins over any restart
Companion window = optional manual `haloflux companion`
DSH host = user-launched desktop app; HALOFLUX only detects/observes
```

## 5. 结论

- **PASS**：P2.2 provenance；事件关联；单实例 supervisor；当前用户自启动安装/启用/停止/卸载；硬编码路径清理；analytics 纯函数。
- **PARTIAL**：PID 复用防护（bridge/companion）；宿主登录状态检测（`UNKNOWN`，不猜测）；自启动的“重启电脑”验收（需用户批准）。
- **NOT_IMPLEMENTED / BLOCKED**：模型请求/流式/推理文本、Event Store/Replay、Execution DAG 画布、DSH 自动启动（无官方接口，不注入）、真实六宿主全量。
- 详细实现见 `P3.1-AUTOSTART.md`、`P3.2-DATA-AND-ANALYTICS.md`。
