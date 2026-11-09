# P3 · 阶段门禁（P3.0–P3.2）

- 分支：`feat/paper-lab-p2`，起点 `4206753`（PR #1 Draft）
- 时间：2026-11-09T14:50–15:20Z
- 结论：**P3.0 PASS；P3.1 PASS（重启测试 NOT_TESTED）；P3.2 PARTIAL；P3.3–P4 NOT_IMPLEMENTED。**
- 未合并、未部署、未发布、未重启电脑。

## 1. 门禁表

| 阶段 | 状态 | 关键证据 | 说明 |
|---|---|---|---|
| P3.0 基线与能力审计 | **PASS** | `reports/p3/P3-BASELINE-AND-CAPABILITY-AUDIT.md` | 硬编码路径、PID 风险、缓存口径、宿主覆盖、生命周期缺口均逐项列出 |
| P3.1 自动启动/进程管理 | **PASS** | `reports/p3/P3.1-AUTOSTART.md`、`tests/evidence/p3/` | 当前用户计划任务安装/启用/禁用/卸载/启动实测；supervisor 单实例、退避、优雅停止 |
| P3.1 重启电脑验证 | **NOT_TESTED** | 未重启 | 需用户明确批准 |
| P3.1 DSH 自动启动 | **NOT_IMPLEMENTED** | 仅检测 | 无官方 headless/静默接口，拒绝注入 |
| P3.2 事件模型/分析引擎 | **PARTIAL** | `reports/p3/P3.2-DATA-AND-ANALYTICS.md`、`packages/analytics` | trace/span/agent/turn 可选字段 + 9 类可解释指标 + Evidence Inspector；模型流/回放/DAG 画布未完成 |
| P3.3 模型请求/推理 | **NOT_IMPLEMENTED** | 无 provider 事件 | 不伪造 reasoning/TTFT/token usage |
| P3.4 Agent DAG/调度 | **PARTIAL** | `criticalPath` 纯函数 + 测试 | 无真实任务依赖数据源，未接画布 |
| P4 视觉深化 | **NOT_IMPLEMENTED（本轮）** | P2.2 视觉仍为 PARTIAL | 本轮未重构底部八单元 |
| P5 验收 | **PARTIAL** | `npm test` 107/107、P6 基线 | 本轮未重跑 30 min soak / 多宿主 |

## 2. 测试与构建

```powershell
npm run build       # tsc，exit 0
npm run typecheck   # tsc --noEmit，exit 0
npm test            # 107 / 107 pass，0 fail，0 skipped
```

新增测试：

- `tests/unit/service-manager.test.mjs`：退避、状态机、任务脚本、状态解析、单实例锁、tick、宿主发现（7）。
- `tests/unit/analytics.test.mjs`：速率/分位数/瀑布/关键路径/环/公平/Jain/Little/熵/JS/状态转移（6）。
- `tests/unit/event-schema.test.mjs`：trace/span/status/单调时钟新增（1）。
- 既有 93 项保持通过。

## 3. 自启动实测（本机）

- `HALOFLUX-Supervisor` 已注册：`Ready/Running`，`MultipleInstances=IgnoreNew`，`Interactive + Limited`，无 SYSTEM。
- `Start-ScheduledTask` → supervisor `HEALTHY`，bridge 被拉起；`supervisor.json`/`supervisor.jsonl` 可复核。
- `disable` → `Disabled`；`enable` → `Ready`；`uninstall` → 删除；重新 `install` → `Ready`。
- `stop` → supervisor 优雅退出，bridge/collectors 停止，用户停止后没有自动拉起。
- 证据：`tests/evidence/p3/autostart-status.json`、`task-scheduler.txt`、`supervisor-state.json`、`supervisor-events.jsonl`、`doctor-startup.txt`。

## 4. 已知风险 / 未完成

1. 重启电脑后自启动 **NOT_TESTED**（需用户批准）。
2. bridge/companion PID 复用校验仍不完整；supervisor 锁已带 PID+命令字段。
3. Event Store / Replay / REPLAY 标识 **NOT_IMPLEMENTED**。
4. 模型请求、TTFT、token usage、reasoning_content **NOT_IMPLEMENTED**；当前 DSH adapter 不产生这些字段。
5. Execution DAG / Critical Path / Tool Waterfall 画布未接入；仅纯函数。
6. 视觉仍为 P2.2 PARTIAL；本轮只新增 Evidence Inspector 与 rate 引擎接入。
7. 30 min soak、多分辨率 FPS、六宿主回归未在本轮重跑；P2.2 数据仍为上一次基线。

## 5. 下一步

按任务书顺序：P3.2 Event Store + model adapter → P3.3 可授权 reasoning inspector → P3.4 DAG/waterfall 画布 → P4 视觉八单元 → P5 全面验收。
