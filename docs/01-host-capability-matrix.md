# 宿主能力矩阵（Host Capability Matrix）

- 最后核对时间：**2026-11-08 16:26 UTC（America/Los_Angeles 08:26）**
- 证据目录：`tests/host/evidence/<host>.json`、`tests/evidence/live-bridge-state.json`、`screenshots/`、`config/backups/`
- 状态词汇（`docs/architecture.md` §11）：`PASS`（真实宿主验证）、`PARTIAL`（部分链路/派生数据）、`SIMULATED`（仅适配器合成 payload）、`UNSUPPORTED`（宿主无该事件或安装被拒绝）、`BLOCKED`（前置条件缺失）、`NOT_TESTED`（未执行）。
- 规则：**合成 payload 的 PASS 不算宿主 PASS**；派生事件必须 `source=derived/confidence=inferred`；任何 PASS 必须有真实证据。

## 1. 总览（6 宿主 × 10 场景）

| 场景 | DeepSeek Harness | Claude Code | Codex | Cursor | WorkBuddy | TRAE |
|---|---|---|---|---|---|---|
| 启动 | **PASS** | **PASS** | PARTIAL | SIMULATED | PARTIAL | SIMULATED |
| 新会话 | **PASS** | **PASS** | PARTIAL | SIMULATED | PARTIAL | SIMULATED |
| 提交任务 | **PASS** | **PASS** | PARTIAL | SIMULATED | UNSUPPORTED | SIMULATED |
| 执行工具 | **PASS** | BLOCKED | PARTIAL | SIMULATED | PARTIAL | SIMULATED |
| 结束工具 | **PASS** | BLOCKED | PARTIAL | SIMULATED | PARTIAL | SIMULATED |
| 完成任务 | **PASS** | BLOCKED | PARTIAL | SIMULATED | UNSUPPORTED | SIMULATED |
| 切会话 | NOT_TESTED | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED |
| 关闭 | **PASS** | **PASS** | UNSUPPORTED | SIMULATED | PARTIAL | SIMULATED |
| 重启 | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED |
| 卸载 | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | NOT_TESTED | UNSUPPORTED |

**宿主总体状态（证据加权）**

| 宿主 | 总体状态 | 一句话结论 |
|---|---|---|
| DeepSeek Harness | **PASS** | 原生 Cordis bundle 在真实 DSH 会话中产出 host-native 事件（session.start/run.start/task.received/tool.*/output.end；部分会话含 run.end/session.end） |
| Claude Code | **PARTIAL** | 真实安装 + 真实 `claude -p` 生命周期 PASS；宿主未登录，工具/完成 BLOCKED |
| Codex | **PARTIAL** | hooks 已安装但 hook trust 未生效；真实 rollout 日志的只读 watcher 派生事件可用 |
| Cursor | **PARTIAL** | hooks 已安装（11 条），但 GUI 无法 headless 驱动，真实事件未触发；合成映射通过 |
| WorkBuddy | **PARTIAL** | MCP 已安装；真实 trace 派生的 81 个事件可用；无被动 hook |
| TRAE | **UNSUPPORTED** | 安装器拒绝写入未验证格式；仅有适配器合成映射（全部标 derived/inferred），不构成宿主 PASS |

> 说明：`SIMULATED` 只证明"适配器收到宿主格式 payload → 合法 v1 事件 → bridge 接收"，**不证明真实宿主触发过 hook**。重启/卸载没有在真实配置上演练，保持 `NOT_TESTED`。

## 2. 逐宿主证据

### 2.1 DeepSeek Harness 0.2.1-rc.5 — PASS（真实原生）

| 项 | 证据 |
|---|---|
| 安装 | dsh-haloflux v0.7.1 原生 bundle + `adapters/deepseek-harness/haloflux-bridge/`；安装结果由 dsh-dev 记录（`docs/04-dsh-integration.md`） |
| 实时会话 | `tests/evidence/live-bridge-state.json`（2026-11-08T16:26Z 抓取）：5 个 DSH 会话，其中 `8e5d1bbb…` 真实事件链含 **session.start → run.start → tool.start/tool.end → output.end → run.end → session.end**，source=host-native、confidence=confirmed |
| 事件总数 | bridge `eventCount=567`（16:28:53Z 快照），11 个会话（含其他宿主/测试会话）；DSH 5 个会话中 4 个 host-native、1 个 derived heartbeat |
| 截图 | `screenshots/companion-live-dsh.png`：真实 DSH 事件流、`宿主原生 · host-native · confirmed` 徽章、工具名 pwsh/read/grep/edit |
| 限制 | 切会话（session.switch）未观察到；重启/卸载未测；插件安装截图由 dsh-dev 提供 |

### 2.2 Claude Code 2.1.299 — PARTIAL（真实生命周期 PASS；工具 BLOCKED）

| 项 | 证据 |
|---|---|
| 真实安装 | 2026-11-08 16:17 UTC 由 Lead 执行 `adapters/claude-code/install.ps1`；保留 AgentHaven 原有 28 组 hook，新增 9 条 HALOFLUX hook；备份 `config/backups/20261108T161709355Z/` |
| 真实会话 | `claude -p "Reply with exactly one word: ok"` 执行两次；bridge 收到真实会话 `f1327e03…`、`d6c9a9f5…`，事件链 `session.start → task.received → error → session.end`，source=host-native/confirmed。QA 于 16:30 UTC 复现：新会话 `0c054ee3…` 同样为 host-native 生命周期链 |
| 启动/新会话/提交/关闭 | **PASS（真实）** |
| 执行工具/结束工具/完成任务 | **BLOCKED**：宿主返回 "Not logged in · Please run /login"，没有模型回合，因此无 tool/run.end 事件 |
| 合成映射 | `node tests/host/claude-code.mjs`：8 个 hook 全部 exit 0、空 stdout、事件到达、QA secret 无泄漏 |
| 限制 | 无 session.switch hook；卸载未在真实配置上执行（manifest 已记录，可回滚） |

### 2.3 Codex CLI 0.154.0 — PARTIAL（派生）

| 项 | 证据 |
|---|---|
| 安装 | `~/.codex/hooks.json` 已由 Lead/adapters-dev 安装 8 条 hook；备份 `config/backups/20261108T161552323Z/` |
| 真实 hook | 未触发：Codex 0.154 要求 hook trust；即使 `--dangerously-bypass-hook-trust` 运行 `codex exec` 也没有事件。**不伪造 PASS** |
| 真实日志派生 | `node tests/host/codex.mjs`：从真实 rollout 副本派生 22 个事件（source=derived/inferred）；bridge 当前有真实 codex 会话 `01a1bbf3…`（derived、idle） |
| 合成映射 | 6 个 hook payload 全部通过 |
| 限制 | 无 session.switch/session.end 映射；重启/卸载未测 |

### 2.4 Cursor 3.29.9 — PARTIAL（安装通过，真实事件未触发）

| 项 | 证据 |
|---|---|
| 安装 | 2026-11-08 16:19 UTC 写入 `~/.cursor/hooks.json` 共 11 条 hook；备份 `config/backups/20261108T161903843Z/` |
| 合成映射 | `node tests/host/cursor.mjs`：sessionStart / beforeSubmitPrompt / beforeShellExecution / postToolUse / stop / sessionEnd 全部到达（SIMULATED） |
| 真实触发 | NOT_TESTED：Cursor 是 GUI 宿主，无 headless 会话驱动器 |
| 限制 | 切会话 UNSUPPORTED；重启/卸载未测 |

### 2.5 WorkBuddy 5.9.3 — PARTIAL（真实派生）

| 项 | 证据 |
|---|---|
| 安装 | 2026-11-08 16:19 UTC 写入 `~/.workbuddy/mcp.json`（1 条 MCP server）；备份 `config/backups/20261108T161905851Z/` |
| 真实派生 | 只读 watcher `node adapters/workbuddy/adapter.mjs --watch --once` 从真实 trace 派生 **81 个事件**；bridge 会话 `abcabc123456…`（source=derived、inferred、disconnected，事件链 session.start→tool.start→tool.end→session.end） |
| 合成 fixture | `node tests/host/workbuddy.mjs`：session.start/tool.start/tool.end/session.end 全部 derived/inferred；隐私检查通过（此前 trace.name 泄漏已修复） |
| 限制 | 无 task.received/run.end 映射（UNSUPPORTED）；切会话 UNSUPPORTED；重启/卸载未测 |

### 2.6 TRAE CN 3.4.13 — SIMULATED / 安装 UNSUPPORTED

| 项 | 证据 |
|---|---|
| 安装 | **拒绝**：hook 格式未验证，安装器不写 `~/.trae-cn/hooks.json`（除非显式 `-Mode Hooks`）；这是有意的安全行为 |
| 合成映射 | `node tests/host/trae.mjs`：sessionStart / beforeSubmitPrompt / preToolUse / postToolUse / stop / sessionEnd 全部到达，且强制 source=derived/inferred |
| 真实事件 | NOT_TESTED：无 headless CLI，hook 词汇未验证 |
| 限制 | 切会话 UNSUPPORTED；卸载 UNSUPPORTED（未安装任何东西）；重启未测 |

### 2.7 generic（附加，非"宿主"）— PASS

| 项 | 证据 |
|---|---|
| 接口 | `node adapters/generic/adapter.mjs < events.jsonl`（文档化的 generic 宿主接口） |
| 结果 | `node tests/host/generic.mjs` → 6 个事件完整会话，最终 state=idle；带 `prompt` 键的非法事件被拒绝、secret 未进入 `/v1/state` |
| 限制 | 仅验证接口契约，不代表某个真实第三方宿主 |

## 3. 复现命令

```powershell
cd D:\HALOFLUX
# 各宿主证据脚本（自起 179xx 随机端口 bridge，绝不使用 17817）
node tests/host/deepseek-harness.mjs
node tests/host/claude-code.mjs
node tests/host/codex.mjs
node tests/host/cursor.mjs
node tests/host/workbuddy.mjs
node tests/host/trae.mjs
node tests/host/generic.mjs

# 只读采集器（真实宿主日志 → bridge）
node scripts/haloflux.mjs watch status
node scripts/haloflux.mjs watch start
node scripts/haloflux.mjs watch stop

# 实时 bridge 快照（需要真实 token）
$token = (Get-Content "$env:LOCALAPPDATA\HALOFLUX\token" -Raw).Trim()
Invoke-RestMethod http://127.0.0.1:17817/v1/state -Headers @{ Authorization = "Bearer $token" }
```

## 4. 状态升级路径

1. Claude Code：用户执行 `/login` 后重跑一次 `claude -p`，捕获 tool.start/tool.end/run.end → 即可把执行工具/结束工具/完成任务升级为 PASS；
2. Codex：在 Codex 内信任 hooks（或等 0.154 hooks trust 稳定）后跑一次 `codex exec`；或由用户手动确认 hook 触发；
3. Cursor/TRAE：GUI 内手动触发一次会话，bridge 收到 host-native 事件后升级；
4. WorkBuddy：若未来提供被动 hook，替换派生 watcher；
5. 所有宿主：在隔离 `-ConfigRoot` 下执行一次 uninstall 并校验 SHA256，再把卸载列升级为 PASS。
