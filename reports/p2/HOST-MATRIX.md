# P4 · 六宿主真实验收矩阵（HOST-MATRIX）

- 任务：`task-6`（P4 六宿主真实验收矩阵，read-only）
- 仓库：`<repo>`；分支 `feat/paper-lab-p2`；HEAD `0a9e389`（未切分支、未 commit、未 push）
- 机器：Windows 11 10.0.26300 x64；Node v24.16.0
- 观测窗口：**2026-11-09T12:23:43Z – 12:32:05Z**（America/Los_Angeles 04:23–04:32）
- 证据目录：`tests/evidence/p2-hosts/`
- 规则：`PASS` 必须有真实宿主触发证据；派生日志只能记 `source=derived/confidence=inferred`；合成 payload 不计入宿主 PASS；未测即写 `NOT_TESTED`。

---

## 1. 结论摘要

| 宿主 | 状态 | source / confidence | 版本 | 观测时间（UTC） | 主证据 | 缺口 | 复测步骤 |
|---|---|---|---|---|---|---|---|
| DeepSeek Harness | **PASS** | host-native / confirmed | 0.2.1-rc.5 | 12:24:14–12:32:05 | `tests/evidence/p2-hosts/deepseek-harness.json`、`dsh-bridge-state-final.json`、`dsh-probe-summary.json` | approval、session.switch、重启/卸载未测；会话级 source 会被 heartbeat 覆盖（见 §5-F1） | 触发一次权限询问；在隔离 profile 做重启/卸载；native 事件后再读 `/v1/state` |
| Claude Code | **PARTIAL**（生命周期 PASS / 工具链 **BLOCKED**） | host-native / confirmed（生命周期） | 2.1.299 | 12:26:26 | `tests/evidence/p2-hosts/claude-code.json`、`dsh-bridge-state-final.json` | 宿主未登录（`loggedIn=false`），无模型回合 → 无 tool/run.end；未绕过登录 | 用户 `claude login` 后重跑固定一句话；期望 tool.start/tool.end/run.end |
| Codex | **PARTIAL**（仅派生） | derived / inferred | codex-cli 0.154.0 | 12:26:46–12:29:10 | `tests/evidence/p2-hosts/codex.json` | 8 条 hooks 已 trust，但 exec 未观察到 hook 投递；两次 exec 均被账号拒模型；无 SessionEnd | 选账号支持的模型，再跑 `codex exec`（不带 bypass）；或继续只读 rollout watcher |
| Cursor | **PARTIAL**（真实事件 **NOT_TESTED**） | config-only / not tested | 3.29.9 | 12:31:44（安装核验） | `tests/evidence/p2-hosts/cursor.json`、`doctor.json` | GUI 宿主，无法 headless 触发；验收时 Cursor 未运行；未用合成 payload 冒充 | 打开 Cursor 跑一个带 shell 工具的会话，读 `/v1/state` 确认 host-native |
| WorkBuddy | **PARTIAL**（仅派生） | derived / inferred | 5.9.3.0 | 12:29:20–12:29:40 | `tests/evidence/p2-hosts/workbuddy.json` | 无被动 hook；MCP 未被宿主实际调用；>100 事件批量被 400 拒绝（见 §5-F2） | 正常使用 WorkBuddy 后跑 watcher；在 WorkBuddy 内调用 `haloflux_status`；批量分片修复后复测长 trace |
| TRAE | **UNSUPPORTED** | none / not tested | 3.4.13（注册表） | 12:31:44（安装核验） | `tests/evidence/p2-hosts/trae.json`、`doctor.json` | 无可靠公开 hook 规范与真实触发证据；安装器拒绝写配置 | 拿到官方 hook 文档后，在隔离 `-ConfigRoot` 安装并触发一次真实会话 |

---

## 2. 方法与约束（实际执行）

### 2.1 bridge 生命周期（本轮启动）

- 起始状态：`GET http://127.0.0.1:17817/v1/health` 不可达；`scripts/doctor.ps1 -Json` 首跑（`2026-11-09T12:24:02Z`）显示 `bridge.online=false`。
- 启动：`node scripts/haloflux.mjs bridge` → `bridge started pid=25008 url=http://127.0.0.1:17817`。
- 端口/进程：**PID 25008**，`node packages/event-bridge/src/server.mjs`，仅监听回环 `127.0.0.1:17817`；启动时间 `2026-11-09T04:24:14-08:00`。
- 停止方式：`node scripts/haloflux.mjs stop`，或 `taskkill /PID 25008 /T /F`。**本轮结束时按任务要求保留运行**，便于 Lead 复核；未启动 companion/Electron。
- token：`%LOCALAPPDATA%\HALOFLUX\token`（只用于 `Authorization: Bearer`，**未打印、未写入证据**）。
- 只读 watcher 均为 `--once` 单次运行，运行完即退出，没有常驻 watcher 进程。

### 2.2 实际命令与结果

| 命令 | 结果 |
|---|---|
| `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1 -Json` | 首跑 12:24:02Z exit 0，bridge offline；复跑 12:31:44Z exit 0，bridge online v0.1.0；4 个宿主 `matchesManifest=true`，TRAE `UNSUPPORTED` |
| `node scripts/haloflux.mjs bridge` | `pid=25008`，`/v1/health` 返回 `ok=true version=0.1.0` |
| `GET /v1/state`（Bearer token） | 基线快照 eventCount=267；本报告快照 eventCount=676（12:29:50Z）；12:32:05Z 实时 857，`dropped=0`、`duplicates=0`；`deepseek-harness.connected=true` |
| `claude --version` / `claude auth status` | 2.1.299；`loggedIn=false`、`authMethod=none`、exit 1 |
| `claude -p "<固定一句话>"` | exit 1，`Not logged in · Please run /login`；真实新会话 `5e5ab874…` 事件链 `session.start→task.received→error→session.end`（host-native/confirmed） |
| `codex --version` / `codex login status` | codex-cli 0.154.0；`Logged in using ChatGPT` |
| `codex exec --skip-git-repo-check -s read-only --json "<固定一句话>"` | `turn.failed`，`gpt-6-luna` → `model_not_found`（ChatGPT 账号不支持）；bridge 无 codex 原生事件 |
| `codex exec ... -m gpt-5.1-codex "<固定一句话>"` | `turn.failed`，`gpt-5.1-codex` → `model_not_found`；bridge 无 codex 原生事件 |
| `node adapters\codex\adapter.mjs --watch --once --tail-bytes 0 --session-file <真实 rollout>` | `events=11 posted=true (202)`；会话 `01a178a9…`，**source=derived/inferred** |
| `node adapters\workbuddy\adapter.mjs --watch --once` | `events=111 posted=false (HTTP 400)`：单批超过 `MAX_BATCH=100` |
| `node adapters\workbuddy\adapter.mjs --watch --once --tail-bytes 0 --trace-file <小 trace>` | `events=2 posted=true (202)`；`trace_e2cb19…`（session.start/session.end） |
| `node adapters\workbuddy\adapter.mjs --watch --once --tail-bytes 65536 --trace-file <中 trace>` | `events=31 posted=true (202)`；`trace_81f998…`（15 tool.start + 15 tool.end + session.end） |

### 2.3 约束遵守

- 未修改任何宿主配置；doctor 前后哈希一致（见 §3）。
- 未安装/卸载适配器；未重启 DSH/Cursor/WorkBuddy/TRAE/Codex 应用。
- 未切换分支、未 commit、未 push；未改源码（仅新增本报告与证据 JSON）。
- 未绕过 Claude 登录；未读取对话正文、提示词、工具参数或凭据原文。Codex/Claude 触发使用固定的一句话测试提示，不读取其会话内容。
- 未把 Derived 事件升级为原生：Codex/WorkBuddy 会话在证据中标 `source=derived/confidence=inferred`。

---

## 3. 安装状态与哈希（`doctor.ps1 -Json`，2026-11-09T12:31:44Z）

| 宿主 | doctor 状态 | 配置条目 | 配置 | 安装后 SHA256（与 manifest 一致） | 版本 |
|---|---|---|---|---:|---|
| Claude Code | INSTALLED | 9 hooks | `%USERPROFILE%\.claude\settings.json` | `1b0930103d49751ca791a2619d7defd3d3c0066a037d620e291cc32c11de9b3b` | 2.1.299 |
| Codex | INSTALLED | 8 hooks | `%USERPROFILE%\.codex\hooks.json` | `13f8917b2750b806ef8c72f050ea7a52d5090a6f5e3bbb10208efd688cc28ee7` | 0.154.0 |
| Cursor | INSTALLED | 11 hooks | `%USERPROFILE%\.cursor\hooks.json` | `ce4622fc8ba6f4abf38ece201deb420641dab62c6a363a1d7b16f0194dfe4ed9` | 3.29.9 |
| WorkBuddy | INSTALLED | 1 MCP server | `%USERPROFILE%\.workbuddy\mcp.json` | `f9140dc720aefa01a97e44beeb99f097aef16d6b85acecac94c0bb677d174cd3` | 5.9.3.0 |
| TRAE CN | UNSUPPORTED | 0 | `%USERPROFILE%\.trae-cn\hooks.json`（不存在） | — | 3.4.13（注册表） |
| DeepSeek Harness | **doctor 不枚举** | 2 bundles | profile `desktop/package.json` | 见下 | 0.2.1-rc.5 |
| Generic | NO-INSTALL-NEEDED | — | stdin JSONL | — | — |

- DSH 安装不是 doctor 的检查项；本轮从 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 核验：
  `dsh-haloflux=link:<repo>/upstream/dsh-haloflux`、`dsh-haloflux-bridge=link:<repo>/adapters/deepseek-harness/haloflux-bridge`，且两个 bundle 都在 `dsh.profile.bundles` 中；live 事件持续到达（hostVersion=0.2.1-rc.5）。
- doctor 原始报告（路径已脱敏）：`tests/evidence/p2-hosts/doctor.json`。
- 备份 manifest：`<repo>/config/backups/20261108T161709355Z`（Claude）、`20261108T161552323Z`（Codex）、`20261108T161903843Z`（Cursor）、`20261108T161905851Z`（WorkBuddy）。

---

## 4. 逐宿主详情

### 4.1 DeepSeek Harness 0.2.1-rc.5 — PASS（真实原生）

- **source / confidence**：`host-native / confirmed`（事件级）；桥 `connected=true`，`capabilitiesSource=adapter`，warnings 为空。
- **事件链**：`session.start → run.start → task.received → output.end → tool.start → tool.end → … → output.end`；工具名为真实 `pwsh/read/grep/edit`；`run.end` 在 `session-7fb30fa0…` 与 `71cdff68…` 中实际出现，`session.end` 在 `71cdff68…` 中出现。
- **会话（脱敏前缀）与原生/派生计数**（合并 512 KB 诊断日志轮转文件后，1538 事件、6 个会话 key）：

| 会话前缀 | 事件数 | host-native/confirmed | derived/inferred | 关键事件 |
|---|---:|---:|---:|---|
| `session-7fb30fa0…` | 636 | 491 | 145 | session.start×1、run.start×3、task.received×3、run.end×3、tool.start×182、tool.end×177、tool.fail×5、output.end×117 |
| `206d499b…` | 240 | 228 | 12 | session.start×1、run.start×1、task.received×1、tool.start×85、tool.end×84、output.end×55、tool.fail×1 |
| `dcfd3edd…` | 223 | 210 | 13 | session.start×1、run.start×1、task.received×1、tool.start×78、tool.end×77、output.end×52 |
| `ab363f82…` | 211 | 199 | 12 | session.start×1、run.start×1、task.received×1、tool.start×71、tool.end×71、output.end×54 |
| `session-330b3931…` | 139 | 1 | 138 | session.start×1，其余为 heartbeat |
| `71cdff68…` | 89 | 83 | 6 | tool.start×29、tool.end×27、tool.fail×2、output.end×23、run.end×1、session.end×1 |

- **证据**：`tests/evidence/p2-hosts/deepseek-harness.json`、`dsh-bridge-state-baseline.json`、`dsh-bridge-state-final.json`、`dsh-probe-summary.json`。
- **说明**：这些 DSH 会话来自本轮期间用户正在使用的 DSH（包括本验收 agent 自身会话），属于真实宿主流量；不是合成 payload。DSH 诊断日志在采集期间发生 512 KB 轮转，证据合并了 `.jsonl.1` 与 `.jsonl`，按 `eventId` 去重。
- **缺口**：approval.request/resolve、session.switch、重启/卸载未测。完整 native 链已有，但 `/v1/state` 的会话级 source 可能被 heartbeat 覆盖（§5-F1）。
- **复测**：新开 DSH 会话 → 发一句话 → 触发一次权限询问 → 在 native 事件后立即读取 `/v1/state`；重启/卸载只在隔离 profile 演练。

### 4.2 Claude Code 2.1.299 — PARTIAL（生命周期 PASS；工具链 BLOCKED）

- **安装**：9 条 HALOFLUX hooks，`settings.json` SHA256 与 manifest 一致（doctor 前后均 `matchesManifest=true`）。
- **登录**：`claude auth status` → `loggedIn=false`、`authMethod=none`、exit 1；按任务要求**未绕过登录**。
- **真实事件**：`claude -p "<固定一句话>"` exit 1，stderr `Not logged in · Please run /login`；bridge 收到真实会话 `5e5ab874…`，事件链 `session.start → task.received → error → session.end`，`source=host-native/confidence=confirmed`（最后事件时间 12:26:26Z）。
- **判定**：启动/新会话/提交/关闭 = PASS（真实）；执行工具/结束工具/完成任务 = **BLOCKED**（无模型回合）。
- **证据**：`tests/evidence/p2-hosts/claude-code.json`。
- **缺口**：未登录导致没有 tool.start/tool.end/run.end；未验证 `session.switch`（宿主无该 hook）。
- **复测**：用户执行 `/login` 或 `claude login` → 重跑固定一句话 → 期望新的 host-native tool/run.end 事件。

### 4.3 Codex CLI 0.154.0 — PARTIAL（派生；hook 投递仍未经证实）

- **安装**：8 条 hooks，`~/.codex/hooks.json` SHA256 与 manifest 一致。
- **新发现（相对 `docs/08`）**：`~/.codex/config.toml` 已有 **8 条 `[hooks.state...] trusted_hash`**（session_start / user_prompt_submit / pre_tool_use / permission_request / post_tool_use / stop / subagent_start / subagent_stop），配置文件 mtime `2026-11-09T00:51:54-08:00`。即 hooks 已由用户/宿主侧 trust，**本轮未修改该配置**。
- **原生投递仍 NOT_TESTED**：`codex login status` 为 `Logged in using ChatGPT`；两次 `codex exec`（默认 `gpt-6-luna` 与 `-m gpt-5.1-codex`）都在 `turn.started` 后以 `model_not_found` 失败（账号不支持该模型），bridge **没有收到任何 `host=codex source=host-native` 事件**；未使用 `--dangerously-bypass-hook-trust`。
- **真实派生**：只读 rollout watcher 读取真实宿主日志 `rollout-2026-10-26T07-42-27-01a178a9…jsonl`（文件名，未复制正文），得到 **11 条**派生事件：`session.start×1、run.start×1、tool.start×3、tool.end×3、session.heartbeat×3`；bridge 会话 `01a178a9…` 明确为 `source=derived/confidence=inferred`。
- **证据**：`tests/evidence/p2-hosts/codex.json`。
- **缺口**：hook 是否实际执行未证实（trust 存在 ≠ 投递成功）；无 SessionEnd 能力；watcher 仅派生且只跟随最新文件。
- **复测**：改用账号支持的模型跑一次 `codex exec`（不带 bypass），观察 SessionStart/UserPromptSubmit/PreToolUse/Stop；或继续用 `--watch` 并把派生徽章保持为“推断”。

### 4.4 Cursor 3.29.9 — PARTIAL（安装通过；真实事件 NOT_TESTED）

- **安装**：11 条 hooks，`~/.cursor/hooks.json` SHA256 与 manifest 一致。
- **真实触发**：Cursor 是 GUI 宿主，无 headless 会话驱动器；验收时未检测到 Cursor 进程，**没有触发真实 hook**。未用合成 payload 计入宿主 PASS（合成映射仅存在于 `tests/host/cursor.mjs` 历史证据）。
- **判定**：安装/能力映射 = 配置层 PASS；真实事件 = **NOT_TESTED**。
- **证据**：`tests/evidence/p2-hosts/cursor.json`。
- **缺口**：无真实 host-native 事件；undo/重启/卸载未测。
- **复测**：打开 Cursor → 新会话 → 提交一句提示 → 允许一次 shell 工具 → 结束；读 `/v1/state` 确认 `host=cursor` 且 `source=host-native`。

### 4.5 WorkBuddy 5.9.3.0 — PARTIAL（仅派生；MCP 未实际调用）

- **安装**：`~/.workbuddy/mcp.json` 含 1 条 `mcpServers.haloflux-status`，SHA256 与 manifest 一致；WorkBuddy 进程在运行。
- **派生事件**：只读 trace watcher 从真实 trace 派生：
  - `trace_e2…`（源文件 `trace_e2cb199…jsonl`，basename）：2 事件 `session.start/session.end`；
  - `trace_81…`（源文件 `trace_81f9986…jsonl`，basename）：31 事件 `tool.start×15/tool.end×15/session.end×1`；
  - 两个 bridge 会话均为 `source=derived/confidence=inferred`，**未升级为原生**。
- **批量限制（真实失败）**：对最新活跃 trace 的一次 watcher 运行产生 **111 条**事件，bridge 返回 **HTTP 400**（未接收）；代码依据：`packages/event-schema/src/index.ts` `MAX_BATCH=100`，`adapters/_shared/event-client.mjs` 把整批一次性 POST，未分片。较小的 2/31 条批次均 202 接收。这意味着长 trace 可能整批丢失，需要 Lead 决定是否修复。
- **MCP**：`haloflux-status` 已被配置，但本轮 WorkBuddy 未实际调用该 MCP server（`mcpExercisedByHost=NOT_TESTED`）；不能据此判定宿主原生。
- **证据**：`tests/evidence/p2-hosts/workbuddy.json`。
- **缺口**：无被动生命周期 hook；无 task.received/run.end；批量 >100 未分片；MCP 未被宿主调用。
- **复测**：正常使用 WorkBuddy → 跑最新 trace watcher → 确认派生徽章；在 WorkBuddy 内让模型调用 `haloflux_status`；批量分片修复后重跑长 trace。

### 4.6 TRAE CN 3.4.13 — UNSUPPORTED

- **安装**：`~/.trae-cn/hooks.json` 不存在，doctor `UNSUPPORTED`、0 条条目；安装器有意拒绝写入未验证的 hook 格式。
- **真实事件**：没有可靠的公开 hook 接口，也没有 headless/GUI 真实触发证据；适配器合成映射（全部 `derived/inferred`）不构成本轮宿主 PASS。
- **证据**：`tests/evidence/p2-hosts/trae.json`、`doctor.json`。
- **缺口**：无 hook 规范/无真实触发；未安装任何东西。
- **复测**：获取 TRAE 官方 hook 文档 → 在隔离 `-ConfigRoot` 安装 → 真实 GUI 会话触发 → 验证 host-native 事件。

---

## 5. 验收中发现的问题（未修复，交 Lead 决定）

**F1（DSH，中）· `/v1/state` 会话级 source/confidence 是“最后事件覆盖”**
- `packages/session-manager/src/index.mjs:260-261` 对每个事件执行 `session.source = event.source; session.confidence = event.confidence`。
- 结果：native 会话在收到一个 `source=derived/inferred` 的 `session.heartbeat` 后，`/v1/state` 的会话徽章会变成“推断”。本轮实测 `206d499b…`（228 native / 12 derived）与 `ab363f82…`（199 native / 12 derived）在快照中显示 `derived/inferred`，而事件流本身 94%+ 为 host-native。
- 影响：UI 可能把真实原生会话显示为推断；不影响底层事件正确性，但影响验收口径。
- 证据：`dsh-bridge-state-baseline.json`、`dsh-bridge-state-final.json`、`dsh-probe-summary.json`。

**F2（WorkBuddy，中）· 派生 watcher 单批超过 100 事件被整批拒绝**
- `MAX_BATCH=100`（`packages/event-schema/src/index.ts:181`）；`postEvents` 单次 POST 整批（`adapters/_shared/event-client.mjs:311`），未分片。
- 实测：最新 trace 一次派生 **111** 事件 → HTTP **400**；31 事件批次 202 成功。
- 影响：长 trace 的派生事件可能整批丢失，且当前 watcher 不重试/不分片。

**F3（Codex，信息）· hooks trust 状态与文档不一致**
- `docs/08`（2026-11-08）记录 hooks 未 trust；本轮发现 `config.toml` 已有 8 条 `trusted_hash`（mtime 2026-11-09T08:51:54Z）。本轮未改配置；但仍未能观察到 hook 投递，说明 trust 存在不等于投递成功。

**F4（DSH，信息）· doctor 不枚举 DeepSeek Harness**
- `scripts/doctor.ps1` 的 host 列表没有 deepseek-harness；DSH 安装状态需要从 profile `package.json` 与 live 事件另行核验。建议后续把 DSH bundle 纳入 doctor（本轮未改脚本）。

**F5（证据完整性，信息）· DSH 诊断日志 512 KB 轮转**
- 采集期间 `%TEMP%\haloflux-dsh-bridge-events.jsonl` 轮转为 `.jsonl.1`；证据合并两份并去重，避免丢失完整链。复测时需同时读取轮转文件。

---

## 6. 与既有文档的差异（本轮实测）

| 文档 | 旧结论 | 本轮实测 |
|---|---|---|
| `docs/01-host-capability-matrix.md` §2.3 | Codex hooks 未 trust | 8 条 hooks 已有 trusted_hash；但投递仍未证实 → 仍为 PARTIAL |
| `docs/08-final-verification.md` §3 | DSH `eventCount=567`/11 会话 | 本轮新 bridge：本报告快照 676 / 9 会话（12:29:50Z），实时 857（12:32:05Z）；4 个 DSH 会话有完整 native 链 |
| `docs/01` §2.5 | WorkBuddy 派生 81 事件 | 本轮 2 + 31 事件成功；111 事件批量被 400 拒绝（新发现） |
| `docs/01` §2.2 | Claude 未登录、工具 BLOCKED | 一致；本轮新增会话 `5e5ab874…` 确认生命周期链 |
| `docs/01` §2.4 | Cursor 真实事件 NOT_TESTED | 一致；本轮 Cursor 未运行，仍未触发 |

---

## 7. 证据索引

| 文件 | 内容 |
|---|---|
| `tests/evidence/p2-hosts/doctor.json` | 完整 doctor 输出（路径脱敏，含 4 个配置的 SHA256 与 manifest 比对） |
| `tests/evidence/p2-hosts/deepseek-harness.json` | DSH 安装、bridge PID/端口、6 个会话的原生/派生计数、完整链、finding |
| `tests/evidence/p2-hosts/dsh-bridge-state-baseline.json` | 真实 `/v1/state` 基线快照（eventCount=267，会话 ID 前缀） |
| `tests/evidence/p2-hosts/dsh-bridge-state-final.json` | 真实 `/v1/state` 终态快照（eventCount=676，含 claude-code/codex/workbuddy） |
| `tests/evidence/p2-hosts/dsh-probe-summary.json` | DSH 诊断日志合并摘要（1538 事件、6 会话、4 条完整 native 链） |
| `tests/evidence/p2-hosts/claude-code.json` | hooks、auth、真实生命周期链、BLOCKED 说明 |
| `tests/evidence/p2-hosts/codex.json` | hooks/trust、login、两次 exec 失败、派生 watcher 证据 |
| `tests/evidence/p2-hosts/cursor.json` | hooks 安装、GUI 无法 headless 触发、NOT_TESTED |
| `tests/evidence/p2-hosts/workbuddy.json` | MCP 配置、派生 watcher 成功批次、111 事件 400 失败 |
| `tests/evidence/p2-hosts/trae.json` | 安装拒绝、无真实触发证据 |
| `tests/evidence/p2-hosts/run-log.json` | 命令清单、bridge 生命周期、约束遵守 |

隐私说明：所有证据中的 session ID 仅保留 8 字符前缀；不包含提示词、工具参数、工具输出、凭据或绝对用户路径。

---

## 8. 未完成 / 未测（如实）

1. 所有宿主的**重启**与真实配置上的**卸载**（NOT_TESTED；本轮禁止改宿主配置）。
2. DSH：approval.request/resolve、session.switch（NOT_TESTED）；F1 未修复。
3. Claude Code：工具/完成事件（BLOCKED，未登录）；未绕过登录。
4. Codex：hook 原生投递（NOT_TESTED）；测试模型的账号可用性不足。
5. Cursor：真实 host-native 事件（NOT_TESTED，GUI 未运行）。
6. WorkBuddy：MCP 实际调用（NOT_TESTED）；>100 事件批量（已失败，待修复）。
7. TRAE：无可靠 hook 规范，UNSUPPORTED。
8. Generic 不属于“六宿主”范围，未在本轮重复验收。

---

## 9. 复测命令速查

```powershell
# 1) 安装态与哈希（只读）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1 -Json

# 2) bridge（若 17817 未运行）
node scripts/haloflux.mjs bridge
$tok = (Get-Content "$env:LOCALAPPDATA\HALOFLUX\token" -Raw).Trim()
Invoke-RestMethod http://127.0.0.1:17817/v1/state -Headers @{ Authorization = "Bearer $tok" }

# 3) Claude Code（未登录时只验证生命周期；不得绕过登录）
claude auth status
claude -p "Reply with exactly one word: ok"

# 4) Codex（仅派生；原生需账号支持的模型）
codex login status
node adapters\codex\adapter.mjs --watch --once --tail-bytes 0 --session-file <真实 rollout.jsonl>

# 5) WorkBuddy（仅派生）
node adapters\workbuddy\adapter.mjs --watch --once --trace-file <真实 trace.jsonl> --tail-bytes 65536

# 6) 停止本轮启动的 bridge
node scripts/haloflux.mjs stop
```
