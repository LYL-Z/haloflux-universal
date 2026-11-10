# 历史事件与回放（P3.2-A）

HALOFLUX 现在把**已通过 schema 校验**的事件持久化到本地 SQLite，并提供只读历史查询与确定性回放。

## 存储

- 路径：`%LOCALAPPDATA%\HALOFLUX\events\haloflux-events.sqlite`
- 引擎：Node 24 内置 `node:sqlite`（无额外依赖），WAL + `busy_timeout` + `secure_delete`
- 去重：`event_id PRIMARY KEY` + `INSERT OR IGNORE`
- 索引：`session_id`、`run_id`、`trace_id`、`timestamp`
- 只保存 schema allowlist 内的元数据；不含 prompt、正文、工具参数/结果、API Key、推理文本

## 查询

```powershell
node scripts\haloflux.mjs history --limit 50
node scripts\haloflux.mjs history --session <sessionId> --json
node scripts\haloflux.mjs history --session <id> --run <runId> --trace <traceId>
node scripts\haloflux.mjs history --from <epochMs> --to <epochMs>
node scripts\haloflux.mjs history --stats
node scripts\haloflux.mjs history --export D:\HALOFLUX-media\p3\history.jsonl
```

## 保留 / 删除

```powershell
node scripts\haloflux.mjs history --prune-days 30
node scripts\haloflux.mjs history --delete-session <sessionId>
```

默认保留 30 天（`HALOFLUX_EVENT_RETENTION_DAYS`），bridge 启动时裁剪；删除后执行 `VACUUM`（`secure_delete=ON`）。

## 回放

```powershell
node scripts\haloflux.mjs replay --session <sessionId>
```

窗口顶部会出现 **REPLAY** 条：暂停/继续、单步、0.5/1/2/4×、LIVE 返回。回放只读取历史事件，不重新请求模型、不重跑工具；`REPLAY` 不会显示为实时。

也可以手动打开：

```text
apps/companion/renderer/index.html?replay=<sessionId>&bridge=http://127.0.0.1:17817
```

## 历史边界

Event Store 只覆盖启用之后写入的事件；启用前仅存在于 30 条内存缓存中的事件不会被补录。历史查询默认最多 1000 条，超出请导出 JSONL。数据库未加密，依赖 Windows 用户目录 ACL；token/凭据不入库。
