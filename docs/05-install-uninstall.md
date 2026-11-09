# 安装 / 启动 / 诊断 / 卸载 / 回滚（面向非开发者）

> 适用：Windows 11 x64，Node.js ≥ 22，本机已安装 DeepSeek Harness（自带 Electron 43.3.0）。
> 本文件的所有命令都在 **PowerShell** 中执行；每步都给出预期输出。若某条命令报错，先看 §8 排查表。
> 说明：`scripts/install-adapters.ps1` / `uninstall-adapters.ps1`（统一适配器安装器）与 `scripts/doctor.ps1` 均已存在；各宿主自己的 `adapters/<host>/install.ps1` 也可单独使用。

## 0. 一分钟版（已经装好环境）

```powershell
cd D:\HALOFLUX
npm run build                      # 构建事件 schema（TypeScript → dist）
node scripts\haloflux.mjs doctor   # 体检；bridge 未启动时最后一项会红，属正常
node scripts\haloflux.mjs start    # 启动 bridge + 桌面伴随窗口
node scripts\haloflux.mjs status   # 应显示 bridge.ok = true
```

停止：

```powershell
node scripts\haloflux.mjs stop
```

---

## 1. 安装前检查

```powershell
cd D:\HALOFLUX
node --version                      # 期望 v22 或更高（本机 v24.16.0）
Test-Path 'C:\Users\Lenovo\.dsh\electron\electron.exe'   # 期望 True
node -e "console.log('ok')"
```

- 不需要下载 Electron；脚本自动使用 DeepSeek Harness 自带的 Electron。
- 不需要管理员权限；安装器不写系统目录，不改防火墙。
- 不会上传任何数据；只监听 `127.0.0.1:17817`。

## 2. 安装（推荐分两步）

### 2.1 先装本体，不碰任何宿主配置（最安全）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipAdapters
```

它会：检查 Node/Electron → `npm install` + 构建 → 备份宿主配置快照 → 生成启动器与开始菜单快捷方式 → 写 `config\install-manifest.json`。
**不会**修改 Claude Code / Codex / Cursor 等宿主配置。

### 2.2 再按需安装宿主适配器（会改宿主配置，可回滚）

统一安装器（`scripts\install-adapters.ps1`，支持 DryRun、单宿主隔离配置根）：

```powershell
# 预览全部（不写文件）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-adapters.ps1 -All -DryRun

# 只装 Claude Code + Codex（非交互默认）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-adapters.ps1 -Hosts claude-code,codex -NonInteractive

# 隔离演练：临时配置根 + 临时备份根（不碰真实 ~/.claude）
$tmp = Join-Path $env:TEMP 'haloflux-claude-test'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-adapters.ps1 `
  -Hosts claude-code -ConfigRoot $tmp -BackupRoot (Join-Path $tmp 'backups') -DryRun
```

只装某一个宿主（各宿主自己的安装器也支持 `-WhatIf` 预览、`-ConfigRoot` 隔离根、`-BackupRoot` 备份目录）：

```powershell
# 预览：只打印将要改的键，不写文件
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\claude-code\install.ps1 -WhatIf

# 实际安装（默认备份到 config\backups\<UTC时间>\）
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\claude-code\install.ps1
```

同样的形式适用于 `adapters\codex\install.ps1`、`adapters\cursor\install.ps1`、`adapters\trae\install.ps1`、`adapters\workbuddy\install.ps1`。
安装器会打印：备份路径、manifest、改动的键、合并后 SHA256；并保证不删除无关条目（尤其是 AgentHaven 已有的 hooks）。

### 2.3 一键安装并启动

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Start
```

## 3. 启动与停止

| 目的 | 命令 | 预期 |
|---|---|---|
| 启动 bridge + 伴随窗口 | `node scripts\haloflux.mjs start` | 打印 bridge URL；窗口出现 |
| 只启动 bridge（前台调试） | `node scripts\haloflux.mjs bridge` | 终端持续输出监听日志 |
| 只启动伴随窗口 | `node scripts\haloflux.mjs companion --mode window` | 透明/普通窗口 |
| 覆盖层模式 | `node scripts\haloflux.mjs companion --mode overlay` | 置顶、点击穿透（Ctrl+Alt+H 切换） |
| 演示数据 | `node scripts\haloflux.mjs start --demo` | 卡片标注"模拟" |
| 停止全部 | `node scripts\haloflux.mjs stop` | 两个 PID 文件清理 |
| 查看日志 | `node scripts\haloflux.mjs logs --lines 80` | 最近日志 |

窗口模式也可用安装器参数：`scripts\install.ps1 -Mode overlay`。

## 4. 诊断（出问题时先跑这三个）

```powershell
node scripts\haloflux.mjs status --json     # bridge 是否在跑、会话数、PID
node scripts\haloflux.mjs doctor --json     # Node/Electron/token/构建/端口/宿主配置逐项检查
node scripts\haloflux.mjs hosts             # 当前宿主安装状态（读各适配器 capabilities）
```

`doctor` 的退出码：0 = 全部通过；1 = 至少一项失败（例如 bridge 未启动）。看 `hint` 字段按提示修复。
适配器诊断（含安装状态、token、bridge、配置漂移、回滚命令）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1 -Json | ConvertFrom-Json
```

## 5. 卸载

### 5.1 只卸载 HALOFLUX 的 hook，保留本地数据

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Yes
```

流程：停止进程 → 调用 `scripts\uninstall-adapters.ps1`（校验 manifest SHA256，恢复备份或只删除本项目新增的条目）→ 删除开始菜单快捷方式与 `bin\HALOFLUX*.cmd` → 保留 `%LOCALAPPDATA%\HALOFLUX`（token/日志）。

### 5.2 连本地数据一起删除

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Yes -PurgeData
```

只删除 `%LOCALAPPDATA%\HALOFLUX`；**项目目录与备份不会删除**。

### 5.3 卸载单个宿主

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File adapters\claude-code\uninstall.ps1
```

卸载器会校验 manifest 中的 SHA256，从备份恢复字节一致的配置；若配置已被用户改过，会报告差异而不是强删。

## 6. 回滚

```powershell
node scripts\haloflux.mjs backup --label before-change   # 手动快照（可选）
node scripts\haloflux.mjs restore <时间戳> --dry-run      # 先预览
node scripts\haloflux.mjs restore <时间戳>                # 实际恢复
```

备份位置：`D:\HALOFLUX\config\backups\<UTC时间戳>-<label>\`，包含每个被修改文件的原始副本与 `manifest.json`。
时间戳列表：`Get-ChildItem config\backups | Select-Object Name`。

## 7. 干净卸载后重新安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Yes -PurgeData
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipAdapters
```

安装/卸载都是幂等的：重复执行不会重复追加 hook。

## 8. 排查表

| 现象 | 原因 | 处理 |
|---|---|---|
| `doctor` 报 bridge ECONNREFUSED | bridge 没启动 | `node scripts\haloflux.mjs start` 或 `bridge` |
| 端口 17817 被占用 | 另一个程序/残留进程 | `Get-NetTCPConnection -LocalPort 17817` 查 PID；`node scripts\haloflux.mjs stop`；或临时 `$env:HALOFLUX_BRIDGE_PORT='17917'`（适配器需同步 `HALOFLUX_BRIDGE_URL`） |
| 适配器装完没事件 | hook 未触发/路径错/宿主未重启 | `doctor`；重启宿主；用 `adapters/<host>/README.md` 的手动 payload 命令自测 |
| token 丢失 | 删了 `%LOCALAPPDATA%\HALOFLUX` | 重启 bridge 会重新生成；适配器通过 `HALOFLUX_TOKEN` 或 token 文件读取 |
| 窗口不显示 | Electron 路径不对/被 `ELECTRON_RUN_AS_NODE` 影响 | 设置 `HALOFLUX_ELECTRON` 指向 `electron.exe`；安装器启动器会清理该环境变量 |
| 宿主权限被影响 | 不应发生（适配器空 stdout、exit 0） | 立即 `uninstall.ps1`，恢复备份；把宿主 hook 输出贴到 issue |
| 安装器报配置解析失败 | 原配置是无效 JSON | 先手工备份并修复；安装器拒绝覆盖无效配置 |

## 9. 安全与隐私提示

- token 是本地最高权限凭据：不要发到聊天/截图/公网；泄露后删除 `%LOCALAPPDATA%\HALOFLUX\token` 并重启 bridge（会生成新 token）。
- 只监听 `127.0.0.1`；如需远程访问，请自行加 SSH 隧道，**不要**改绑 `0.0.0.0`。
- 本项目不读取对话正文/文件内容/tool 参数；详见 `docs/03-security-and-license.md`。
- 许可证为 PolyForm Noncommercial 1.0.0：仅限个人非商业使用；保留 `LICENSE`、`NOTICE` 与署名。
