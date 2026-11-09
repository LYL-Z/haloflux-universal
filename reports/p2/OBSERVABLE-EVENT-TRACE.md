# P3 · 可观测 Agent 执行链路（Observable Event Trace）

- 分支：`feat/paper-lab-p2`
- 时间：2026-11-09T12:35–12:50Z
- 原则：只展示宿主公开或用户授权的**执行事件**，不读取、不推断、不伪造模型隐藏思维链。无证据时显示 `—` / `UNKNOWN` / `NOT CONNECTED`。

## 1. 已有链路（P1 之前已工作）

真实 DeepSeek Harness 事件（P0/P4 证据，`tests/evidence/p2-hosts/dsh-*.json`）：

```
session.start → run.start → task.received → tool.start → tool.end / tool.fail
              → output.start → output.chunk* → output.end → run.end → session.end
```

`/v1/state` 的每个会话包含 `state`、`reportedState`、`source`、`confidence`、`metrics`、`recentEvents`；`source` 区分 `host-native`（confirmed）/ `derived`（inferred）/ `simulated`（unverified）。SIMULATED 在页面水印、ledger 与事件行（`SIM`）三处标注。

## 2. 本轮新增：调用关联与真实耗时（schema 兼容扩展）

### 2.1 Schema

在 `packages/event-schema` 的 metadata 白名单中新增两个**可选**字符串字段（不改变 `schemaVersion: 1`，旧事件仍合法）：

| 字段 | 类型/上限 | 来源 |
|---|---|---|
| `toolCallId` | string ≤ 64 | 宿主提供的工具调用 ID（如 Claude `tool_use_id`、DSH `callId`） |
| `runId` | string ≤ 64 | 预留的 run/turn 关联 ID；当前无适配器稳定提供，宁缺毋滥 |

同步更新 `packages/event-schema/schema/event.schema.json` 与测试契约 `tests/helpers/types.mjs`。

### 2.2 适配器发送

| 适配器 | 变化 |
|---|---|
| `adapters/deepseek-harness/haloflux-bridge/index.js` | `tool.start/tool.end/tool.fail` 发送真实的 `toolCallId`（来自 host `callId`）；`tool.end/fail` 仍带宿主耗时 `durationMs` |
| `adapters/claude-code/adapter.mjs` | `PreToolUse/PostToolUse/PostToolUseFailure` 发送 `toolCallId`（`payload.tool_use_id`）；不读取 `tool_input/tool_response` |
| `adapters/_shared/event-client.mjs`、`schema-lite.mjs` | 白名单/字符串上限同步，防止未知字段外泄 |

### 2.3 会话状态机

`packages/session-manager/src/index.mjs`：

- 每个会话维护 `openTools: Map<toolCallId, {at,name}>`（仅内存）；
- `tool.start` 记录起点；`tool.end/fail` 若携带同一 `toolCallId`：
  - 宿主未给 `durationMs` 时，用 `event.timestamp - start.at` 计算真实耗时；
  - 暴露 `metrics.lastToolDurationMs`、`lastToolCallId`、`lastToolCorrelated`；
- 无匹配起点时**不计算耗时**，`lastToolCorrelated=false`（显示 `UNCORRELATED`）；
- `recentEvents` 条目增加 `toolCallId/durationMs/errorCode`，供时间线与投影使用。

### 2.4 UI

`apps/companion/renderer/monitor-projection.mjs` + `app.js`：

- RUN/PHASE 单元新增 `TOOL / DURATION` 行：
  - 有真实关联：`Bash · 511 ms · CORRELATED`
  - 无关联：`Bash · — · UNCORRELATED`
  - 无工具：`—`
- 事件流保留真实时间、eventType、toolName、来源标记（SIM/NAT/DRV）。缓存条数在 ledger/单元格标注 `CACHED`，不把最近 30/200 条当作全任务总量或成功率。

## 3. 验证证据

### 3.1 单元/集成测试

| 命令 | 结果 |
|---|---|
| `npm run build` | exit 0 |
| `npm run test:unit` | **61 / 61 pass**（新增 `tests/unit/correlation.test.mjs` 3 项） |
| `npm test` | **85 / 85 pass，0 fail，0 skipped** |

新增断言：

- schema 接受 `toolCallId/runId`，拒绝 >64 字符与非字符串；
- 同一 `toolCallId` 的 start(1000)/end(1600) → `lastToolDurationMs=600`、`lastToolCorrelated=true`；
- 只有 end、无 start → **不产生耗时**、`lastToolCorrelated=false`；
- projection 有 `durationMs` 时透出 450 ms，无关联时为 `null/false`。

### 3.2 真实 bridge 进程（隔离端口 17818，非合成 mock）

```
POST tool.start(toolCallId=dsh-call-0001, ts=now-2400)
POST tool.end  (toolCallId=dsh-call-0001, ts=now)
→ /v1/state: durationMs=2401, correlated=true, callId=dsh-call-0001
POST tool.end  (toolCallId=unknown-call, 无 start)
→ /v1/state: lastToolDurationMs=null, lastToolCorrelated=false
```

证据：本轮命令输出（可复跑 `tmp/p3-correlation.mjs`，不属于交付源码；报告固定数据如上）。

### 3.3 真实 Claude Code adapter → 真实 bridge

```
PreToolUse  (tool_use_id=toolu_abc123) → tool.start
PostToolUse (tool_use_id=toolu_abc123) → tool.end
→ /v1/state: lastToolDurationMs=511, lastToolCorrelated=true,
             recentEvents[].toolCallId=toolu_abc123
```

说明：该验证使用真实 adapter 进程与真实 bridge，但 hook payload 由本机合成的 Claude 格式输入；Claude 宿主本身仍未登录（P4 报告：工具链 BLOCKED）。

### 3.4 实时 DeepSeek Harness（限制）

- 当前 DSH 进程加载的是**安装时**的 `dsh-haloflux-bridge` 模块；本轮对源码的 `toolCallId` 扩展需重新 `plugin_manager install_bundle` 并**重启 DSH** 才会生效。
- 未重启用户 DSH（避免打断会话），因此实时 `/v1/state` 尚无 `toolCallId`；这属于 **BLOCKED（等待授权重启）**，不得写成实时 PASS。
- 已有的 DSH 事件链路本身仍是 host-native/confirmed（P4 已取证）。

## 4. 与任务书 §4.1/§4.2 的对照

| 要求 | 状态 | 说明 |
|---|---|---|
| 保持 V1 契约兼容 | PASS | 仅新增可选 metadata，schemaVersion 不变；旧事件测试仍全绿 |
| session/run/turn/tool correlation ID | PARTIAL | toolCallId 已实现并有真实 adapter 证据；runId 字段预留但无宿主稳定提供 |
| 工具真实耗时（同 ID 才显示） | PASS（离线 bridge） | 无 ID 不计算；宿主有 durationMs 时优先宿主值 |
| 时间线：选择会话/筛选/暂停/详情/跳转 | PARTIAL | 已有会话选择、真实事件流、来源标记；筛选/暂停/详情抽屉尚未实现 |
| 缓存 vs 累计区分 | PARTIAL | 明确标 `CACHED`；未提供全量历史 |
| 无事件时不得假装思考 | PASS | 状态来自事件；无事件为 `disconnected/unknown`，无"thinking"伪造 |
| SIMULATED 不混入真实历史 | PASS | source/confidence 分离 + UI 水印；导入/演示不写入真实历史 |
| 负向测试 | PASS | 无关联、缺耗时、超长 ID、错误类型均有断言 |

## 5. 结论

**P3 = PARTIAL（可复核）**：调用关联与真实耗时链路已实现并在真实 bridge 上验证，但实时 DSH 需要重启宿主才能带入新字段；时间线筛选/暂停/详情与 runId 仍未完成。下一阶段若要升为 PASS，需要用户授权重启 DSH 并复采一次真实会话，或由宿主提供稳定的 run/call 关联 ID。
