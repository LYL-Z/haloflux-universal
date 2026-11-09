# 自动启动与后台监控（P3.1）

HALOFLUX 使用 **Windows Task Scheduler 当前用户登录触发器**，不需要管理员、不写 SYSTEM、不在 Session 0 启动 GUI。

## 安装 / 查看 / 关闭

```powershell
cd D:\HALOFLUX

# 注册当前用户登录任务（默认 15 秒延迟）
node scripts\haloflux.mjs autostart install

# 查看计划任务与本地配置
node scripts\haloflux.mjs autostart status
node scripts\haloflux.mjs autostart status --json

# 暂时停用 / 恢复
node scripts\haloflux.mjs autostart disable
node scripts\haloflux.mjs autostart enable

# 完全移除（不修改 DSH 配置）
node scripts\haloflux.mjs autostart uninstall
```

任务名：`HALOFLUX-Supervisor`。动作是当前 `node.exe` + `D:\HALOFLUX\scripts\haloflux.mjs supervise`，工作目录固定为仓库根。

## 手动前台运行 / 诊断

```powershell
node scripts\haloflux.mjs supervise          # 前台常驻，Ctrl+C 结束
node scripts\haloflux.mjs supervise --once   # 只做一次健康检查/拉起
node scripts\haloflux.mjs doctor --startup   # 自启动、supervisor、宿主发现
node scripts\haloflux.mjs status
```

## 启动顺序

1. 登录 Windows → Task Scheduler 启动 supervisor → bridge 就绪；
2. 打开 DeepSeek Harness；
3. 需要看监控时再打开窗口：

```powershell
node scripts\haloflux.mjs companion --mode window
```

> bridge 必须在 DSH 启动前就绪，DSH 的插件才会连接。若先开 DSH 后开 bridge，重启一次 DSH 即可。

## 停止语义

```powershell
node scripts\haloflux.mjs stop
```

该命令写 `supervisor.stop`，让 supervisor **优雅退出**，然后停止 collectors/bridge；用户主动停止不会被 supervisor 自动拉起。下次登录（或手动 `supervise`）才会恢复。

## 文件与日志

| 路径 | 用途 |
|---|---|
| `%LOCALAPPDATA%\HALOFLUX\autostart.json` | 本项目的自启动配置（任务名、node/脚本路径） |
| `%LOCALAPPDATA%\HALOFLUX\run\supervisor.json` | 当前 supervisor 状态 |
| `%LOCALAPPDATA%\HALOFLUX\run\supervisor.lock` | 单实例锁（PID + 启动时间 + 命令） |
| `%LOCALAPPDATA%\HALOFLUX\logs\supervisor.jsonl` | 状态转换审计日志 |
| `%LOCALAPPDATA%\HALOFLUX\logs\bridge.log` | bridge 日志 |
| `%LOCALAPPDATA%\HALOFLUX\logs\collector-*.log` | Codex/WorkBuddy 只读 watcher 日志 |

## 限制（如实）

- 重启电脑后的自启动尚未实机验证（需要用户批准重启）。
- DSH 不会由 HALOFLUX 自动启动：没有官方 headless/静默接口，拒绝注入或绕过宿主生命周期。
- 宿主登录状态无法安全探测，显示 `UNKNOWN`，不猜。
- bridge/companion 的 PID 文件仍可能受 PID 复用影响；supervisor 自身有独占锁与命令行校验。
