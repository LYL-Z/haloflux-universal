# P0 环境调查报告 — HALOFLUX Universal Agent Visualizer

- 调查时间：2026-11-08（America/Los_Angeles，本机时区 UTC-8）
- 执行人：Lead（DSH Agent）
- 方法：PowerShell 只读探测（`Get-CimInstance`、注册表卸载项、进程表、目录枚举、`git ls-remote`/`git clone`、`npm config`、`Invoke-WebRequest` HEAD）、上游源码通读、DSH `plugin_manager list_plugins`。
- 结论先行：**六个目标宿主全部已安装且可定位**；开发工具链齐备（Node 24 / Python 3.11 / Git 2.56 / Rust / 内置 Electron 43.3.0）；网络可达 GitHub 与 npm。**HALOFLUX 与 dsh-haloflux 均为 PolyForm Noncommercial 1.0.0**，本项目按非商业、保留署名执行。

---

## 1. 操作系统与硬件

| 项 | 值 |
|---|---|
| OS | Microsoft Windows 11 家庭中文版，10.0.26300，64-bit |
| CPU | Intel Core Ultra 9 290HX Plus，24 核 / 24 逻辑处理器 |
| 内存 | 68,378,017,792 B ≈ 63.7 GiB |
| GPU | NVIDIA GeForce RTX 5090 Laptop GPU（驱动 32.0.16.1742）；另有 ToDesk 虚拟显示设备 |
| 主机名 | （略，本机单人使用） |
| 会话时区 | America/Los_Angeles；宿主应用存在 `TZ=UTC` 的 AgentHaven 运行时包装 |

对渲染的含义：DPR 需要按显示器探测（笔记本内屏可能 150%/200%）；独显可用但**不假设**硬件加速一定开启，性能守卫必须能在纯 CPU 合成下工作。

## 2. 开发工具链

| 工具 | 版本 / 路径 | 备注 |
|---|---|---|
| Git | 2.56.0.windows.4（`D:\Git\cmd\git.exe`） | 可 clone GitHub |
| Node.js | v24.16.0（`C:\Program Files\nodejs\node.exe`） | 原生支持 `node --test`、fetch、WebSocket 客户端 |
| npm | 11.13.0，registry `https://registry.npmmirror.com/` | 可安装 typescript；无 pnpm |
| Python | 3.11.9 | 仅辅助，本工程不依赖 |
| Rust | cargo/rustc 已安装 | 保留 Tauri 可能性，但**不采用**（见 §8） |
| Electron | **43.3.0**，`C:\Users\Lenovo\.dsh\electron\electron.exe`（DSH 自带） | 直接复用，零下载、零新增依赖 |
| .NET | `C:\Program Files\dotnet\dotnet.exe` | 未使用 |
| VS Code | 已安装 | 未使用 |

网络探测：`registry.npmjs.org` HEAD 200；`https://github.com/Ryder191/haloflux` HEAD 200；`https://github.com/Ke-wood/dsh-haloflux` HEAD 200。

## 3. 六个宿主盘点

| 宿主 | 安装 | 版本 | 安装路径 | 配置根 | 运行时证据 |
|---|---|---|---|---|---|
| **DeepSeek Harness** | ✅ | 0.2.1-rc.5（注册表） | `C:\Users\Lenovo\AppData\Local\Programs\DeepSeek Harness` | `C:\Users\Lenovo\.dsh`（profile `desktop`） | 7 个 `DeepSeek Harness.exe` 进程；Web GUI `http://127.0.0.1:57397` |
| **Codex** | ✅ CLI + 桌面 | CLI `0.154.0`；桌面 `OpenAI.Codex 26.1103.4239.0` | CLI `%APPDATA%\npm\codex.cmd`；桌面 `C:\Program Files\WindowsApps\OpenAI.Codex_…` | `C:\Users\Lenovo\.codex`（`config.toml` 已有 `notify`） | 无常驻进程（按需启动） |
| **Cursor** | ✅ | 3.29.9（注册表 Cursor (User)） | `D:\cursor\` | `C:\Users\Lenovo\.cursor`（`cli-config.json`、`mcp.json`） | 1 个 `Cursor.exe` 进程；`cursor.cmd` 经 AgentHaven 包装 |
| **WorkBuddy** | ✅ | 5.9.3 | `C:\Users\Lenovo\AppData\Local\Programs\WorkBuddy` | `C:\Users\Lenovo\.workbuddy`（`mcp.json` 已配 6+ 个 MCP server） | 8 个 `WorkBuddy.exe` 进程 |
| **Claude Code** | ✅ CLI + 桌面 | CLI `2.1.299`；桌面 `Claude 4.23118.0.0` | CLI `%APPDATA%\npm\claude.cmd`；桌面 `C:\Program Files\WindowsApps\Claude_…` | `C:\Users\Lenovo\.claude`（`settings.json` 已有 30+ Hook，由 AgentHaven 托管） | 6 个 `Claude.exe` 进程 |
| **TRAE** | ✅ | TRAE CN 3.4.13 | `C:\Users\Lenovo\AppData\Local\Programs\Trae CN` | `C:\Users\Lenovo\.trae-cn`（plugins / mcps / skills / toolhost） | 无常驻进程 |

补充：`AgentHaven` 位于 `C:\Users\Lenovo\AppData\Local\AgentHaven`，为 cursor/claude/codex 提供运行时包装（设置 `TZ=UTC`、`HTTP(S)_PROXY=127.0.0.1:11119`、禁用非必要遥测）。**任何 Hook 合并都必须保留 AgentHaven 现有条目，不得覆盖。**

## 4. DSH 插件与槽位（已由现有插件实证）

- `plugin_manager` 可用（`list_plugins` 返回 214 行，profile = `desktop`）。
- 现有 profile 依赖 14 个第三方 bundle（`dsh-armorbreak`、`dsh-better-sidebar`、`dsh-context`、`dsh-genui`、`dshmarket`、`dsh-claude-desktop-theme`、`dsh-computer-use-win`、`dsh-connect-workbuddy`、`dsh-chat-import`、`dsh-plugin-subscriptions`、`dsh-skill-mcp-panel` 等），全部启用/禁用状态已记录，改动必须最小化。
- 上游 `dsh-haloflux@0.7.1` 的 `cordis.patch.yml` 为：

  ```yaml
  - insert:
      - id: haloflux
        name: 'dsh-haloflux'
  ```

  `package.json` 通过 `dsh.bundle.patch` + `dsh.client`（`platform: web`、`inject: ["@deepseek-ai/dsh-client-ui-session"]`）注册；客户端单文件 `client.js` 由 `src/*.js` 拼接，注册 `shell.overlay` 与 `settings.section` 两个槽位。
- **结论**：DSH 侧可复用现有插件作为原生集成（先独立安装验证），再叠加我们的事件桥适配器，避免重写视觉层。

## 5. 各宿主可用的官方扩展点（待逐项实测确认）

| 宿主 | 首选接入 | 已观察到的证据 | 待验证 |
|---|---|---|---|
| DeepSeek Harness | Cordis bundle + 客户端槽位 | `cordis.patch.yml`、`dsh.client`、profile 机制、`plugin_manager` | 安装后实跑；会话事件字段 |
| Codex | `~/.codex/config.toml` 的 `notify`；CLI hooks（若有） | `notify = [...codex-computer-use.exe, "turn-ended"]` 已存在 | 0.154.0 是否支持 hooks 事件；桌面端能否嵌入 |
| Cursor | Hooks（`.cursor/hooks.json` 或 settings） | `cli-config.json` 无 hook 段；`mcp.json` 存在 | 3.29.9 官方 hook 事件名与落盘位置 |
| Claude Code | 官方 Hooks（已存在 30+ 事件配置） | `settings.json` 中 `SessionStart`/`PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`Notification`/`Stop`/`SessionEnd`/`UserPromptSubmit` 等 | 合并脚本、真实触发验证 |
| WorkBuddy | MCP（stdio / streamableHttp） | `mcp.json` 已有多个 server；`plugins/`、`sessions` 目录 | 是否存在被动事件回调；否则只能主动上报（如实标注） |
| TRAE | Hooks / MCP / 插件 | `.trae-cn/plugins`、`mcps`、`toolhost`、`installed-plugins.json` | 3.4.13 的 hook 规范与 MCP 注册方式 |

> 表中“待验证”项由 adapters 组按官方文档 + 本机实测逐条给出 PASS/PARTIAL/UNSUPPORTED 证据，**不得凭文档宣称通过**。

## 6. 许可证与上游审计（已下载并记录）

| 项目 | Git URL | Commit SHA | 版本 | 许可证 |
|---|---|---|---|---|
| HALOFLUX | `https://github.com/Ryder191/haloflux` | `016bef651c4f911f08039ba159d36a6f246ff5d2`（2026-11-02） | main | **PolyForm Noncommercial 1.0.0**；2026-10-26 之前的版本曾用 MIT |
| dsh-haloflux | `https://github.com/Ke-wood/dsh-haloflux` | `90a1caa7fbb6b7b7c24151ecf9fdde767362845f`（tag `v0.7.1`，2026-11-02） | 0.7.1 | 同上（含 `NOTICE` 的 Required Notice 行） |

文件哈希（SHA256 前 16 位）：`lab.html A8C4F08D8AF2F6A7`、`mobile.html 30C7CDB99FCCF3DB`、`dsh-haloflux/client.js 903F659B7D140A1D`、`src/engine.js 12CE5EFE5FA76133`。

初步安全审查：

- `dsh-haloflux` 源码（`src/*.js`、`index.js`）**无** `fetch` / `XHR` / `WebSocket` / `eval` / `new Function`；仅读取 DSH Client 会话服务与 `localStorage` 参数。Host 半边 `export function apply() {}` 无行为。
- `haloflux/lab.html` 与 `mobile.html` **无**网络请求代码，但 `<head>` 引用了 `fonts.googleapis.com` / `fonts.gstatic.com`（Google Fonts）。**我们的移植将移除该外链**，改用系统等宽字体栈，保证离线与零第三方请求。
- 背景音乐 `audio/sw421k.mp3` 为 CC0（The Cynic Project），不随插件加载（壁纸版才用）。
- 动态代码执行：未发现 `eval` / `new Function` / `importScripts`。
- 自动更新：上游无自动更新逻辑；`dsh-haloflux` 只是 bundle，不写宿主外文件。

**许可证约束（下达给全体）**：保留 `LICENSE`、`NOTICE`、作者署名与仓库链接；不得声称 MIT；仅个人非商业使用；不得将衍生作品商业化或上传到公共仓库（未经用户同意）。

## 7. 隐私 / 安全边界

- 只监听 `127.0.0.1`；token 鉴权；事件元数据白名单（禁止 prompt/正文/源码/API Key）。
- 不新增任何公网请求；不启用遥测；不修改模型服务地址与登录信息。
- Hook 一律非阻塞、失败退出 0、不影响宿主权限决策。
- 修改任何宿主配置前备份到 `config/backups/<timestamp>/`，并提供回滚命令。

## 8. 技术选型结论

| 选项 | 结论 | 理由 |
|---|---|---|
| Electron（复用 DSH 自带 43.3.0） | **采用** | 透明窗口 / 点击穿透 / 置顶 / 多显示器 DPI / `capturePage` 截图全部原生支持；零下载 |
| Tauri | 不采用 | 需 MSVC/WebView2 打包链，首次构建成本高，且本机已有 Electron |
| 纯浏览器预览页 | 作为兜底 | 无透明/置顶能力，只能做独立窗口 |
| 宿主原生嵌入 | 仅 DSH 启用 | 上游插件已实证 `shell.overlay`；其余宿主无官方嵌入 API，使用桌面伴随窗口 |

## 9. 风险登记

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | Claude Code 的 `settings.json` 已被 AgentHaven 全量占用 hooks | 合并错误会破坏用户现有 hook | 结构化深合并 + 备份 + 原子写 + 回滚演练 |
| R2 | Cursor 3.29.9 可能不含官方 hooks（版本线异常） | Cursor 适配器可能降级为 PARTIAL | 实测优先；不可用则标注 UNSUPPORTED 并提供独立窗口 |
| R3 | Codex 桌面端无法嵌入 | 只能伴随窗口 | 采用 Desktop Companion（模式 A/B） |
| R4 | WorkBuddy 可能只有 MCP 主动调用，无被动事件 | 无法监听全部会话 | 如实标注“仅主动上报”，UI 显示能力限制 |
| R5 | 动画占用 GPU 影响编码 | 用户明确要求可关、可降质 | 帧率上限、空闲降帧、自动降质、可见性暂停、性能实测数据 |
| R6 | DSH 插件安装需 `plugin_manager` 批准 | 可能被策略拒绝 | 已确认 `list_plugins` 可用；`install_bundle` 失败则记录 BLOCKED 并给出人工步骤 |
| R7 | 70 万 token 级长会话可能拖慢渲染 | 掉帧 | 只渲染事件摘要，不渲染正文；环形缓冲区上限 |

## 10. 阶段计划（P0 完成后立即执行）

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 ✅ | 环境调查（本文件） | 本报告 + 兼容性矩阵骨架 |
| P1 | 上游审计 + 原作本地运行 | `docs/02-upstream-audit.md` + 原作截图 |
| P2 | Event Schema（已完成）+ Bridge + Session Manager + Visual Core | `packages/*` + 单测 |
| P3 | DSH 原生集成 | 现有插件安装验证 + 适配器 |
| P4 | Claude Code / Codex / Cursor / TRAE 适配 | `adapters/*` + 真实事件证据 |
| P5 | WorkBuddy | MCP server + 能力声明 |
| P6 | Desktop Companion 三模式 | Electron 应用 + 截图 |
| P7 | 多 Agent 联合测试 | 联合测试报告 |
| P8 | 文档、安装/卸载、性能、最终交付 | README×2、矩阵、安全/许可证报告、截图 |

## 11. 初始兼容性矩阵（P0 时点）

| 宿主 | 安装检测 | 事件接入 | 视觉响应 | 备注 |
|---|---|---|---|---|
| DeepSeek Harness | PASS | NOT_TESTED | NOT_TESTED | 原生插件路径已确认存在 |
| Codex | PASS | NOT_TESTED | NOT_TESTED | 需先确认 hooks/notify 能力 |
| Cursor | PASS | NOT_TESTED | NOT_TESTED | 版本线需实测 |
| WorkBuddy | PASS | NOT_TESTED | NOT_TESTED | 预计 MCP 主动上报 |
| Claude Code | PASS | NOT_TESTED | NOT_TESTED | Hooks 已存在，待合并验证 |
| TRAE | PASS | NOT_TESTED | NOT_TESTED | 能力待确认 |

（后续每个宿主的状态升级必须附真实事件证据，见 `docs/03-host-compatibility-matrix.md`。）
