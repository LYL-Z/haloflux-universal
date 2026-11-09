# @haloflux/event-bridge

HALOFLUX 回环事件桥：适配器 → 归一化事件 → SessionManager → SSE → Desktop Companion。
契约见 [`docs/architecture.md`](../../docs/architecture.md) §3–§6、§10；只用 Node 内置模块，无第三方依赖。

## 运行

```powershell
node packages/event-bridge/src/server.mjs
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HALOFLUX_BRIDGE_PORT` | `17817` | 监听端口；`0` 由 OS 分配（测试用），启动日志打印实际端口 |
| `HALOFLUX_HOME` | `%LOCALAPPDATA%\HALOFLUX` | token / settings 目录 |
| `HALOFLUX_TOKEN` | — | 显式 token（测试/CI）；未设置时读/生成 token 文件 |
| `HALOFLUX_TOKEN_FILE` | `$HALOFLUX_HOME/token` | token 文件路径，32 字节 hex，0600（Windows 上为 best-effort） |
| `HALOFLUX_LOG_LEVEL` | `info` | `debug\|info\|warn\|error\|silent`；日志永不输出 token |

启动输出示例（实际端口以 stdout 为准）：

```text
[bridge] listening on http://127.0.0.1:17817
token file: C:\Users\Lenovo\AppData\Local\HALOFLUX\token
settings file: C:\Users\Lenovo\AppData\Local\HALOFLUX\settings.json
[bridge] ready http://127.0.0.1:17817/v1/health
```

## 端点与安全

仅绑定 `127.0.0.1`；拒绝非回环 socket、非法 `Host`、非回环/非 `file://`/非 `null` 的 `Origin`。
除 `/v1/health` 外全部需要 token：`Authorization: Bearer <token>` 或 `X-Haloflux-Token`；
SSE 额外支持 `?token=`（常量时间比较）。每个连接限速 240 req/s；错误体不回显 token。

| 方法 | 路径 | 鉴权 | Body / 限制 | 响应 |
|---|---|---|---|---|
| GET | `/v1/health` | 否 | — | `200 {ok,name,version,schemaVersion,uptimeMs,port}` |
| POST | `/v1/events` | 是 | 单事件或 `{events:[…]}`，≤100 条，≤256 KB | `202 {accepted,duplicates,sessions,totalSessions,events}` / `400 {issues}` / `413` / `429` |
| GET | `/v1/state` | 是 | — | SessionView 全量快照（§5） |
| GET | `/v1/stack` | 是 | — | 与 `/v1/state` 相同的只读别名（手工 smoke 用） |
| GET | `/v1/stream` | 是（header 或 `?token=`） | — | SSE：先 `snapshot`，后 ≥250 ms 节流的 `update`，每 15 s `: ping` |
| GET | `/v1/settings` | 是 | — | 当前设置（缺失/损坏回退默认值） |
| PUT | `/v1/settings` | 是 | 部分设置 JSON，≤64 KB（合并式更新） | `200` 已保存设置 / `400 {issues}` / `413` |
| POST | `/v1/simulate` | 是 | `{scenario:"demo",intervalMs?,sessionId?}` | `202`，全部 `source:simulated`；`HALOFLUX_DISABLE_SIMULATE=1` 可禁用 |

设置写入为原子写（同目录 temp + fsync + rename）；事件元数据白名单由 `@haloflux/event-schema` 强制，
prompt/正文/工具参数无法进入事件。

## 测试与演示

```powershell
node --test packages/event-bridge/test packages/session-manager/test
node packages/event-bridge/src/simulator.mjs --interval 850 --loop   # 需要已运行的 bridge + token
```

测试全部使用随机端口（`port: 0`），不会碰 17817。

## Electron 三模式验收截图（真实 bridge 17817，live DSH 数据，DPR 2.5，GPU 路径）

| 模式 | 截图 | 实测 fps / frame time |
|---|---|---|
| window（1200×800） | [`screenshots/bridge-window.png`](../../screenshots/bridge-window.png) | 31 fps / 4.6 ms |
| overlay（透明置顶、click-through、opacity 0.85） | [`screenshots/bridge-overlay.png`](../../screenshots/bridge-overlay.png) | 24 fps / 5.0 ms |
| compact（内容区 320×320 无边框置顶 mini HUD） | [`screenshots/bridge-compact.png`](../../screenshots/bridge-compact.png) | 24 fps（mini HUD 只显示 fps） |

compact 视口固定为 320×320（`useContentSize` + `setContentSize`；Windows 无边框外层 bounds 为 320×321，仅 1 DIP 边框）。
renderer 的 compact mini HUD 已由 visual-dev 修复并复测无裁切。GPU 默认开启；`--software-render` /
`HALOFLUX_SOFTWARE_RENDER=1` 用于 CI/截图软件渲染，launcher 在窗口 ready 前崩溃时会自动软件回退一次。
