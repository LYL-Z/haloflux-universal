# P3 · 阶段门禁（P3.0–P3.2）

- 分支：`feat/paper-lab-p2`，起点 `4206753`（PR #1 Draft）
- 时间：2026-11-09T14:50–15:20Z
- 结论：**P3.0 PASS；P3.1 PASS（重启测试 NOT_TESTED）；P3.2-A PASS；P3.2-B PARTIAL；P3.2-C NOT_IMPLEMENTED。**
- 未合并、未部署、未发布、未重启电脑。

## 1. 门禁表

| 阶段 | 状态 | 关键证据 | 说明 |
|---|---|---|---|
| P3.0 基线与能力审计 | **PASS** | `reports/p3/P3-BASELINE-AND-CAPABILITY-AUDIT.md` | 硬编码路径、PID 风险、缓存口径、宿主覆盖、生命周期缺口均逐项列出 |
| P3.1 自动启动/进程管理 | **PASS** | `reports/p3/P3.1-AUTOSTART.md`、`tests/evidence/p3/` | 当前用户计划任务安装/启用/禁用/卸载/启动实测；supervisor 单实例、退避、优雅停止 |
| P3.1 重启电脑验证 | **NOT_TESTED** | 未重启 | 需用户明确批准 |
| P3.1 DSH 自动启动 | **NOT_IMPLEMENTED** | 仅检测 | 无官方 headless/静默接口，拒绝注入 |
| P3.2 事件模型/分析引擎 | **PARTIAL** | `reports/p3/P3.2-DATA-AND-ANALYTICS.md`、`P3.2-A-EVENT-STORE.md`、`P3.2-B-EXECUTION-UI.md`、`P3.2-C-MODEL-CAPABILITY.md` | trace/span/agent/turn 可选字段 + 9 类指标 + Evidence Inspector；SQLite Event Store + 真实回放 + Waterfall/DAG/Critical Path UI；模型请求级数据仍缺 |
| P3.2-A Event Store / Replay | **PASS** | `packages/event-store`、`/v1/history`、`haloflux history/replay`、真实回放 mp4 | SQLite/WAL、去重、Session/Run/Trace/时间查询、保留/安全删除、确定性回放 |
| P3.2-B 执行链 UI | **PARTIAL** | `screenshots/p3/trace-1600x900.png` | Waterfall 可追溯到 Event ID；DSH 无 toolCallId，显示 HOST_REPORTED/UNCORRELATED；无 span 时 DAG 降级 Timeline；Critical Path UNKNOWN |
| P3.2-C 模型观测 | **NOT_IMPLEMENTED** | `P3.2-C-MODEL-CAPABILITY.md` | DSH 当前不暴露 model request/TTFT/usage/reasoning；不伪造、不劫持 |
| P3.3 模型请求/推理 | **NOT_IMPLEMENTED** | 无 provider 事件 | 不伪造 reasoning/TTFT/token usage |
| P3.4 Agent DAG/调度 | **PARTIAL** | `criticalPath` 纯函数 + 测试 | 无真实任务依赖数据源，未接画布 |
| P4 视觉深化 | **NOT_IMPLEMENTED（本轮）** | P2.2 视觉仍为 PARTIAL | 本轮未重构底部八单元 |
| P5 验收 | **PARTIAL** | `npm test` 107/107、P6 基线 | 本轮未重跑 30 min soak / 多宿主 |

## 2. 测试与构建

```powershell
npm run build       # tsc，exit 0
npm run typecheck   # tsc --noEmit，exit 0
npm test            # 125 / 125 pass，0 fail，0 skipped
```

新增测试：

- `tests/unit/service-manager.test.mjs`：退避、状态机、任务脚本、状态解析、单实例锁、tick、宿主发现（7）。
- `tests/unit/analytics.test.mjs`：速率/分位数/瀑布/关键路径/环/公平/Jain/Little/熵/JS/状态转移（7）。
- `tests/unit/event-store.test.mjs`：持久化/重启内容哈希/去重/时间窗/删除/并发/脏关闭/schema 拒收/1205 分页（5）。
- `tests/unit/replay-engine.test.mjs`：确定性帧/provenance/单步（2）。
- `tests/unit/replay-history.test.mjs`：`at` 缺失/0/非法、2500 分页、5000 上限 PARTIAL、快照边界（4→游标/迟到/删除）。
- `tests/unit/event-schema.test.mjs`：trace/span/status/单调时钟新增（1）。
- `tests/e2e/bridge.test.mjs`：真实 bridge POST→`/v1/history` 持久化、重复 eventId 去重（12 项 suite）。
- 既有测试保持通过。

## 3. 自启动实测（本机）

- `HALOFLUX-Supervisor` 已注册：`Ready/Running`，`MultipleInstances=IgnoreNew`，`Interactive + Limited`，无 SYSTEM。
- `Start-ScheduledTask` → supervisor `HEALTHY`，bridge 被拉起；`supervisor.json`/`supervisor.jsonl` 可复核。
- `disable` → `Disabled`；`enable` → `Ready`；`uninstall` → 删除；重新 `install` → `Ready`。
- `stop` → supervisor 优雅退出，bridge/collectors 停止，用户停止后没有自动拉起。
- 证据：`tests/evidence/p3/autostart-status.json`、`task-scheduler.txt`、`supervisor-state.json`、`supervisor-events.jsonl`、`doctor-startup.txt`。

## 4. 已知风险 / 未完成

1. 重启电脑后自启动 **NOT_TESTED**（需用户批准）。
2. bridge/companion PID 复用校验仍不完整；supervisor 锁已带 PID+命令字段。
3. Event Store / Replay：**P3.2-A PASS**；真实回放录屏 `D:\HALOFLUX-media\p3\replay-full.mp4`（5 s，SHA256 `9b940b3f…45d5e`）。
4. 模型请求、TTFT、token usage、reasoning_content **NOT_IMPLEMENTED**；DSH 当前不暴露，能力矩阵见 `P3.2-C-MODEL-CAPABILITY.md`。
5. Tool Waterfall/DAG/Critical Path：UI 已接入（`TRACE`），但 DSH 无 `toolCallId`/`spanId`，真实数据为 `HOST_REPORTED`/`UNCORRELATED`，DAG 降级 Timeline，Critical Path `UNKNOWN` → **P3.2-B PARTIAL**。
6. 视觉仍为 P2.2 PARTIAL；本轮只新增 Evidence Inspector、TRACE 面板与 REPLAY 条。
7. 30 min soak、多分辨率 FPS、六宿主回归未在本轮重跑；P2.2 数据仍为上一次基线。

## 5. 下一步

P3.2-A/B 的代码与证据已就绪；P3.2-B 要升 PASS 需要宿主提供稳定 `toolCallId`/`spanId` 与任务依赖数据。P3.2-C 需 DSH 官方 model/LLM 事件接口；在此之前保持 UNKNOWN。之后进入 P4 视觉八单元与 P5 全面验收。
