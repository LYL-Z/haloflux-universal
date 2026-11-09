# HALOFLUX ↔ DeepSeek Harness 原生集成

本目录是 HALOFLUX Universal Agent Visualizer 的 DSH 宿主适配层：一个 **Host 侧 Cordis bundle**
（`dsh-haloflux-bridge`），把 DeepSeek Harness 的真实会话事件规范化成 HALOFLUX event v1，
经 loopback HTTP 发给 Event Bridge（`http://127.0.0.1:17817/v1/events`，`host=deepseek-harness`）。
视觉层沿用上游 `dsh-haloflux` v0.7.1（单独安装，源码不改）。

```text
DSH Host process
  dsh-session firehose: session/created · session/event · session/disposed · agent/error
        │  (turn/* · step/* · assistant/* · tool/* · approval/* · request/context)
        ▼
  dsh-haloflux-bridge (Host 侧、零依赖；订阅，不轮询)
        │  规范化 + 元数据白名单 + 限速 + 有界队列 + try/catch
        ▼
  POST http://127.0.0.1:17817/v1/events   Authorization: Bearer <token>
        ▼
  packages/event-bridge → session-manager → companion / visual-core
```

同一份事件还会写入有界诊断日志（默认 `%TEMP%\haloflux-dsh-bridge-events.jsonl`，
512 KB 轮转），供 `probe/verify.mjs` 复验。两条路径都只含白名单 metadata，不含正文。

## 1. 交付物

| 路径 | 作用 |
|---|---|
| `adapters/deepseek-harness/haloflux-bridge/` | Cordis bundle：`package.json`、`cordis.patch.yml`、`index.js`（Host 插件）、locale、icon、NOTICE |
| `adapters/deepseek-harness/probe/receiver.mjs` | 最小 HALOFLUX bridge 桩：`/v1/health`、`/v1/events` + token 鉴权 + 冻结 schema 校验 |
| `adapters/deepseek-harness/probe/verify.mjs` | 离线归一化自测（六类事件/隐私/schema）+ 设置开关验证 + 真实 Host 日志覆盖报告 |
| `adapters/deepseek-harness/tools/profile-manifest.mjs` | 只改 `dependencies` + `dsh.profile.bundles` 的原子清单编辑器 |
| `adapters/deepseek-harness/install.ps1` / `uninstall.ps1` | 备份 + 安装/卸载/回滚（支持 `-DryRun`） |
| `adapters/deepseek-harness/capabilities.json` | 能力声明（bridge 重启后读取） |
| `adapters/deepseek-harness/probe/evidence/` | 本次真实验证证据（JSON/JSONL/截图元数据） |

## 2. 事件映射（Host 原生 → HALOFLUX v1）

`source` 除特别标注外均为 `host-native` / `confidence: confirmed`。

| DSH 会话事件 | HALOFLUX eventType | state | metadata（只取这些字段） |
|---|---|---|---|
| `session/created` | `session.start` | connected | `label=session-created` |
| 插件启动时已存在的会话 | `session.start` | connected | `label=adopted-live`（`derived/inferred`；需 Host 重启后生效） |
| `session/disposed` | `session.end` | disconnected | `label=session-disposed` |
| `turn/start` | `run.start` | running | `turn`, `label` |
| `user/message`（**仅** `source.kind==='user'`） | `task.received` | running | `turn`, `label=user-prompt` |
| `assistant/chunk` `chunk.type==='text-delta'` | `output.start` → `output.chunk`（1/s 节流） | output | `turn`, `step` |
| `assistant/message` | `output.end` | running | `turn`, `step`, `tokenCount=usage.outputTokens`, `contextUsed`, `contextLimit`, `model` |
| `tool/call` | `tool.start` | tool | `toolName`, `toolCategory`, `toolStatus=running`, `turn`, `step` |
| `tool/result`（成功） | `tool.end` | running | `toolName`, `toolCategory`, `toolStatus=ok`, `turn`, `step`, `durationMs` |
| `tool/result`（`isError`/`error`） | `tool.fail` | running | 同上，`toolStatus=failed`, `errorCode` |
| `approval/asked` | `approval.request` | waiting_approval | `toolName`, `toolCategory`, `approvalKind=tool` |
| `approval/decided` | `approval.resolve` | running | `toolName`, `toolStatus=ok/failed/cancelled`, `durationMs`, `label=outcome` |
| `turn/end`（非 error） | `run.end` | idle | `turn`, `durationMs`, `tokenCount`, `model`, `label=reason.kind` |
| `turn/end`（`reason.kind==='error'`） | `error` | error | `turn`, `errorCode`（只取 code） |
| `agent/error` | `error` | error | `turn`, `step`, `errorCode` |
| 每会话 30 s | `session.heartbeat` | unknown | `source: derived`, `confidence: inferred` |

**不发送**：prompt、assistant 文本、tool 参数、tool 结果、文件内容、错误 message、标题、cwd 全路径、
token 明文、模型密钥。`user/message` 只读 `source.kind`；`assistant/chunk` 只读 `chunk.type`
（不读 `text`）；`tool/call` 只读 `name`/`callId`/`turn`/`step`；`tool/result` 只读
`message.isError`/`message.source.callId`/`error.code`。

**不伪造**：DSH 没有 thinking 状态事件，本桥从不发 `thinking`；Host 事件没有 tokens/s 字段，
本桥只转发 `tokenCount`/`contextUsed`/`contextLimit`，不计算 tok/s。

## 3. 能力矩阵（本机 DSH 0.2.1-rc.5 实测）

| 能力 | 状态 | 证据 |
|---|---|---|
| 安装进当前 profile（bundle） | **PASS** | `plugin_manager install_bundle` → `application=applied`, `warnings=[]`；`include:haloflux-bridge` fiber active |
| 订阅真实会话事件 | **PASS** | `probe/evidence/host-events-live.jsonl`：1236 条真实事件、6 个会话（验证时点），逐条通过 v1 校验 |
| 正式 bridge 收端 | **PASS** | `/v1/state`：`eventCount=735, dropped=0`，13 个真实会话、4 个 host、`source=host-native/confirmed`；见 `bridge-state-summary.json` |
| session.start | **PASS（实时）** | 真实新会话 `f8d486fe…`，`label=session-created` |
| task.received | **PASS（实时）** | 真实用户提交「请你继续」→ `run.start`(turn=2) + `task.received`(label=user-prompt) |
| tool.start / tool.end / tool.fail | **PASS（实时）** | 真实 Host 日志 + 36 条 HTTP 收端（12 tool.start / 12 tool.end） |
| token usage | **PASS（实时）** | `output.end.metadata.tokenCount`（如 988） |
| error / session.end | **PASS（实时）** | turn 失败（只发 errorCode）与会话结束均捕获 |
| 多会话 / 多 Host | **PASS** | bridge 同屏 13 个会话、4 个 host（deepseek-harness / codex / workbuddy / claude-code） |
| approval.request/resolve | **NOT_TESTED** | 挂载期间没有触发权限询问；映射已实现 |
| run.end（正常完成 turn） | **PENDING（实时）** | 观察到的 turn 以 `ACCOUNT_QUOTA` 错误结束（按设计发 `error`）；正常完成路径 offline PASS |
| 设置开关禁用 | **PASS（代码路径）** | `verify-output.json`：`gate.configOffPass=true`, `gate.settingsOffPass=true` |
| Bridge 不在线时静默 | **PASS** | 首轮收集中 bridge 未启动，插件零报错、零 Host 影响，仅写本地 probe 日志 |
| HTTP 鉴权 + schema 校验 | **PASS** | probe 收端用冻结 schema 校验后 202；36/36 接受 |
| GUI 设置页 + 背景 | **PASS** | `screenshots/dsh-haloflux-settings.png`、`dsh-haloflux-overlay.png`（上游插件） |

> `PASS（实时）` 与 `PASS（代码路径/离线）` 分开标注；后者不能升级前者。

## 4. 安装

### 4.1 agent 工具安装（本次验证路径）

```text
plugin_manager install_bundle target=D:\HALOFLUX\adapters\deepseek-harness\haloflux-bridge
```

返回 `stage=enable, enabled=true, application=applied, warnings=[]`。bundle 以 `link:` 方式进入
profile，源码目录就是运行目录。证据：`probe/evidence/install-bridge.json`。

### 4.2 手动安装（无 agent 工具）

```powershell
powershell -ExecutionPolicy Bypass -File D:\HALOFLUX\adapters\deepseek-harness\install.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File D:\HALOFLUX\adapters\deepseek-harness\install.ps1
```

脚本会：

1. 备份 `package.json`、`cordis.patch.yml`、`cordis.yml` 到
   `adapters/deepseek-harness/backups/<yyyyMMdd-HHmmss>/` + SHA256 清单；
2. 复制 bundle 到 `<profile>\node_modules\dsh-haloflux-bridge`；
3. 只改 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles`；
4. 失败自动从备份恢复。

`-WithVisualPlugin` 可同时手动安装上游视觉插件。安装 Host bundle 后需**重启 DSH** 才会重新
import 已挂载的 Host 模块（见 §7.1）。

### 4.3 禁用（不卸载）

优先级从低到高：

1. bundle `cordis.patch.yml` 的 `config.enabled`；
2. bundle 目录 `local.config.json`（开发覆盖，正式安装不要提交）；
3. 环境 `HALOFLUX_DSH_ENABLED=0`；
4. `%LOCALAPPDATA%\HALOFLUX\settings.json`：

```json
{ "hosts": { "deepseek-harness": { "enabled": false } } }
```

产品设置每 2 s 读取一次；写 `false` 后事件立即停发（`verify.mjs` 的 gate 用例覆盖）。
也可用 profile 覆盖层（注意：profile patch 是整块替换 `config`，需重述其它字段）：

```yaml
- id: haloflux-bridge
  config:
    enabled: false
```

没有 GUI 配置表单：bundle 刻意不带 client 半边，Host 观察者不会影响 Web GUI。

### 4.4 卸载 / 回滚

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File uninstall.ps1
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Rollback <backup dir>
```

已在一个 profile **副本**上实测：安装 → 卸载（依赖/条目/目录均移除）→ 回滚（三个清单文件
SHA256 与安装前逐字节一致）。证据：`probe/evidence/profile-copy-test.json`。

`plugin_manager` 安装的卸载方式：`plugin_manager remove_bundle target=dsh-haloflux-bridge`；
上游视觉插件：`plugin_manager remove_bundle target=dsh-haloflux`。

## 5. 验证

```powershell
node D:\HALOFLUX\adapters\deepseek-harness\probe\verify.mjs
```

- `OFFLINE PASS`：生产 `BridgeRuntime` + 真实形状会话事件 → HTTP 收端 schema 校验；
  断言六类事件与“零正文泄露”。
- `GATES PASS`：`enabled=false` 与产品 settings `enabled=false` 都不产生 POST。
- `LIVE …`：读取真实 Host 写入的 probe 日志；缺的类型明确列出，不自动判 PASS。

本次输出见 `probe/evidence/verify-output.json`：离线 `pass=true`、`secretLeaks=[]`、
`schemaFailures=0`；实时部分唯一缺 `run.end`（原因见 §7.2）。

E2E HTTP 证据（probe 收端，2026-11-08 08:06，20 s）：

```text
node probe/receiver.mjs --token-file %LOCALAPPDATA%\HALOFLUX\token --port 17817 --out probe\evidence\received-live.jsonl

events=36  sessions=4  tokenEvents=9  schema failures=0
tool.start=12  tool.end=12  output.end=9  session.heartbeat=3
```

正式 bridge 的直接证据（不是 probe 桩）：`/v1/state` 的 `eventCount=735, dropped=0`，
`deepseek-harness.connected=true`，13 个会话、4 个 host、`source=host-native/confirmed`。
原始快照 `probe/evidence/bridge-state-snapshot.json`，摘要 `bridge-state-summary.json`。

## 6. 复验清单

```text
[PASS] plugin_manager install upstream dsh-haloflux (application=applied, warnings=[])
[PASS] Settings → HALOFLUX visible; overlay visible (2 screenshots)
[PASS] bridge bundle installed; plugin entry active
[PASS] live session events captured (1236 rows, 6 sessions, 0 schema failures)
[PASS] official bridge received events (735 events, 13 sessions, dropped=0)
[PASS] live HTTP POST accepted by schema-validating probe receiver (36/36)
[PASS] token usage captured (output.end tokenCount)
[PASS] session.start / task.received live
[PASS] config/settings disable paths emit nothing
[PASS] install/uninstall/rollback on profile copy (rollback byte-identical)
[PENDING] live run.end — observed turns ended in error; normal path offline PASS
[NOT_TESTED] live approval prompt — none occurred
[BLOCKED] browser_* GUI verification — extension_offline; used Windows Computer Use instead
```

## 7. 限制与升级风险

1. **Host 模块热更新不生效**：`plugin_manager` 的 remove/install 只改 profile 清单；已挂载的
   Host 模块不会重新 import。更新 bridge 代码后需重启 DSH。本次未重启（会打断用户会话），
   因此 adopt 快照/诊断行仍由旧模块执行。
2. **挂载时机**：插件加载前已开始的 turn 不会重放；`run.end`/`task.received` 只在挂载后
   新发生的 turn 出现。本次观察到两个 turn 均以 `ACCOUNT_QUOTA` 错误结束，所以
   `run.end`（正常完成）仍 PENDING；桥正确地发 `error`，没有伪造 `run.end`。
3. **无 GUI 配置表单**（见 §4.3）。
4. **依赖 DSH 内部契约**：`session/*`、`agent/error` 与 `SessionEventMap` 是内部 API。升级大版本
   后先跑 `verify.mjs`；事件改名会表现为对应类型消失（桥静默，不崩 Host）。
5. **`hostVersion`**：默认 `0.2.1-rc.5`（本机实测），可用 `DSH_VERSION` 或 bundle config 覆盖。
6. **token 文件**：默认 `%LOCALAPPDATA%\HALOFLUX\token`；插件从不打印/发送 token 本身，
   只放 `Authorization` 头。
7. **许可证**：本 bundle 为原创代码，随项目按 PolyForm Noncommercial 1.0.0 使用；上游
   `dsh-haloflux`/`haloflux` 归其作者，保留 LICENSE/NOTICE，源码未改。

## 8. 与上游视觉插件的关系

- 视觉：上游 `dsh-haloflux@0.7.1` **原样安装**（`D:\HALOFLUX\upstream\dsh-haloflux` 未修改），
  提供 `shell.overlay` 背景与 `Settings → HALOFLUX` 页面。
- 事件：本 bundle 独立提供 Host 侧事件；不依赖、不覆盖上游 `src/live.js` 的 Client 读取路径。
- 两者可同时启用；卸载其一不影响另一。

## 9. 证据索引

| 文件 | 内容 |
|---|---|
| `probe/evidence/install-upstream.json` | 上游安装返回 JSON + profile hash + 插件条目 |
| `probe/evidence/install-bridge.json` | 事件桥安装返回 JSON + 条目 |
| `probe/evidence/host-events-live.jsonl` | 真实 Host 写入的白名单事件 |
| `probe/evidence/bridge-state-snapshot.json` | 正式 bridge `/v1/state` 完整快照 |
| `probe/evidence/bridge-state-summary.json` | 正式 bridge `/v1/state` 摘要 + health + 时间戳 |
| `probe/evidence/live-event-summary.json` | 实时事件类型计数 + 样本 JSON |
| `probe/evidence/received-live.jsonl` | 经 HTTP 收到的 36 条（schema 校验通过） |
| `probe/evidence/verify-output.json` | 离线/设置门/实时覆盖结果 |
| `probe/evidence/profile-copy-test.json` | 安装/卸载/回滚副本实测 hash |
| `probe/evidence/gui-screenshots.json` | 截图元数据与 browser 阻断说明 |
