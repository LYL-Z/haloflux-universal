# 安全与许可证（Security & License）

> 适用范围：`packages/event-bridge`、`adapters/*`、`apps/companion`、安装/卸载脚本。
> 契约来源：`docs/architecture.md` §10（安全不变量）。核对时间：2026-11-08。
> 本文只陈述**已实现并由测试证明**的内容；未实现项在 §6 明确列出。

## 1. 资产与信任边界

| 资产 | 位置 | 敏感度 |
|---|---|---|
| Bridge token | `%LOCALAPPDATA%\HALOFLUX\token`（或 `HALOFLUX_HOME`），首次启动生成 32 字节 hex | 高：持有即可读写本地事件桥 |
| 事件流 | `POST /v1/events` → 内存 → SSE | 中：仅元数据白名单，无正文 |
| 宿主配置 | `~/.claude/settings.json`、`~/.codex/hooks.json` 等 | 高：改动会影响宿主行为 |
| 设置与窗口位置 | `%LOCALAPPDATA%\HALOFLUX\settings.json` | 低 |

信任边界：**宿主进程 → adapter（叶进程）→ 127.0.0.1 bridge → renderer**。adapter 是不可信输入的解析边界；bridge 是唯一网络入口；renderer 不接触宿主 payload。

## 2. 威胁模型与对策

| # | 威胁 | 攻击面 | 对策（实现位置） | 验证证据 |
|---|---|---|---|---|
| T1 | 本机恶意进程伪造事件，让 UI 显示虚假 agent 状态 | `POST /v1/events` | ① 仅绑定 `127.0.0.1`；② 每个 `/v1/*`（除 `/v1/health`）必需 token；③ token 常量时间比较（SHA-256 后 `timingSafeEqual`）；④ 错误响应不回显 token | `tests/security/bridge-security.test.mjs`：无 token 401、错误 token 401、token 不回显、非回环地址不可达 |
| T2 | token 泄漏（日志、错误体、URL） | 日志/响应/SSE URL | ① token 从不写日志，logger 对 64-hex 序列脱敏；② 错误体固定 `{error:'unauthorized'}`；③ SSE 支持 `?token=` 但仅本地回环可达；④ 文档提醒不要把 token 粘贴到公网 | 安全测试断言所有响应体不含真实 token；`token.mjs` 的 `redactSecrets` 单测由 bridge-dev 维护 |
| T3 | 事件/日志注入（换行、控制字符、伪造 JSON 行） | 事件字段、SSE、日志 | ① schema 严格枚举与字符集；② 字符串长度上限；③ 日志只记结构化摘要；④ SSE 的 data 为 JSON 序列化 | `tests/unit/event-schema.test.mjs`：非法字符/超长/原型污染键全部拒绝 |
| T4 | 资源耗尽（超大 body、超量批量、慢速连接、高频请求） | HTTP 层 | ① 事件 body ≤256 KB；② 事件 ≤8 KB；③ 批量 ≤100；④ settings ≤64 KB；⑤ 每 socket 240 req/s 限流；⑥ 慢速客户端有读超时 | 安全测试：300 KB body → 413、>100 批量拒绝、慢速 trickle → 202/400 且服务存活；限流由 bridge-dev 单测覆盖（QA 未做压力级 429 断言，见 §6） |
| T5 | 端口占用 / 误暴露到局域网 | `17817` | ① 只 bind `127.0.0.1`；② 端口冲突时明确报错；③ 测试一律使用 179xx 随机端口；④ 安装器不打开防火墙端口 | 安全测试：本机非回环 IPv4 连接不可达；QA 全套测试未使用 17817 |
| T6 | 宿主 hook 破坏宿主（阻塞、改权限决策、写 stdout 协议） | adapter 进程 | ① 一切 try/catch，始终 exit 0；② 默认不写 stdout；③ 权限类 hook 不返回 allow/deny；④ 超时 1.5 s | host 证据脚本：8 个 Claude hook 事件全部 exit 0 且不输出协议 JSON；隐私检查通过 |
| T7 | 隐私泄漏（prompt、正文、tool args/results、API key、完整路径） | adapter → event | ① 元数据白名单在 schema 边界拒绝未知键；② adapter 只映射 `toolName/sessionId/cwd basename/model/permission_mode` 等；③ `custom` 仅扁平标量且 ≤1 KB；④ `cwdHint` 只保留 basename | 单测 10 个敏感键（prompt/message/content/toolArgs/apiKey/authorization…）全部 `unknown_metadata_key`；host 证据脚本注入 QA secret 后 `/v1/state` 无泄漏；WorkBuddy trace.name 泄漏已修复并回归通过 |
| T8 | 安装/卸载破坏用户已有宿主配置 | `install.ps1`/`uninstall.ps1` | ① 修改前备份到 `config/backups/<utc>/`；② 结构化合并、不删除无关条目；③ manifest + SHA256；④ 卸载校验后回滚；⑤ 幂等 | 安装器由 adapters-dev 交付；本文件记录其约定，QA 未在真实用户配置上执行安装（见 §6） |
| T9 | 供应链/外部网络 | 构建与运行时 | ① 不新增依赖；② renderer 无第三方脚本/字体/图片；③ CSP 限制 `connect-src` 为 loopback；④ 上游审计未发现网络/动态代码 | `docs/02-upstream-audit.md`；renderer HTML CSP 实测存在 |
| T10 | 设置被截断/损坏导致启动失败 | settings.json | 原子写（tmp+fsync+rename+0600）；损坏时回落默认并附非枚举警告 | `tests/unit/settings.test.mjs`：往返、stale tmp、连续 20 次写后仍可解析 |

## 3. 已实现的关键不变量

1. **回环绑定**：`server.listen(port, '127.0.0.1')`；非回环 socket 在路由前 403。
2. **鉴权**：`Authorization: Bearer` 或 `X-Haloflux-Token`；SSE 额外允许 `?token=`（仅本地）。
3. **不泄漏 token**：401/403/413/429/500 的响应体不含 token；日志脱敏。
4. **大小边界**：8 KB/事件、256 KB/请求、100 条/批、64 KB settings、4 KB metadata、1 KB custom。
5. **隐私白名单**：未知 metadata key 直接拒绝；prompt/正文不可表示。
6. **Origin/Host 校验**：非回环 Origin 403；`Host` 必须是 `127.0.0.1|localhost`。
7. **adapter 永不失败宿主**：try/catch + exit 0 + 空 stdout。
8. **可回滚**：所有配置修改附备份、manifest、SHA256 与回滚命令。

## 4. 隐私声明（对用户可见）

- 本项目**不读取**对话正文、文件内容、tool 入参/结果、API Key、凭据。
- 不联网（除本机回环 bridge），无遥测，无自动更新。
- 事件只含：事件类型、时间、host、session id、状态、来源/置信度、工具名、模型名、token 计数、上下文占用、项目名/会话标题、cwd 的 basename 等白名单字段。
- UI 对 `source: derived` 显示"推断"，对 `source: simulated` 显示"模拟"，不把推测当事实。

## 5. PolyForm Noncommercial 1.0.0 合规

- 本项目是 HALOFLUX 的**非商业衍生作品**，整体适用 PolyForm Noncommercial 1.0.0。
- 允许：个人学习、研究、教学、私人娱乐；修改与分享需保留许可证与署名。
- 禁止：任何商业用途（公司内部使用、商业产品/服务集成、外包/有偿项目、售卖或其产出物、商业广告等）。
- 必须保留：
  - 根目录 `LICENSE`（PolyForm NC 1.0.0 全文与 Required Notice）；
  - 根目录 `NOTICE`（原作与新作边界、commit、音乐 CC0 说明）；
  - 界面"关于"页与 README 中的作者署名与仓库链接。
- 再分发时必须保留上述文件与 Required Notice 行；修改版本需标注 "modified from HALOFLUX"。
- 音乐 `audio/sw421k.mp3`（CC0，The Cynic Project）**不随本项目加载**，也不受 PolyForm 约束。

## 6. 未完成 / 未验证项（如实列出）

| 项 | 状态 | 说明 |
|---|---|---|
| 真实宿主 hook 安装后的端到端安全验证 | NOT_TESTED | QA 未在用户真实 `~/.claude`、`~/.codex` 配置上执行安装，避免破坏 AgentHaven 现有 30+ hooks；adapter 已用合成 payload 验证且不落正文 |
| 安装器回滚字节级验证 | NOT_TESTED (by QA) | 由 adapters-dev 的安装器测试覆盖；QA 未重复执行 |
| 高频 429 限流压力测试 | NOT_TESTED | bridge 实现有 240 req/s 限流，QA 安全套件未做 240+ req/s 压力断言，避免在共享机器上产生噪声 |
| WorkBuddy `trace.name` → `metadata.label` 隐私缺陷 | **FIXED / 回归通过** | `tests/host/workbuddy.mjs` 曾证明 trace 名称会进入 state；adapters-dev 改为常量 label 后，QA 重跑隐私检查 `leakedInState=[]`，真实 trace watcher 仍产出 81 个派生事件 |
| Windows ACL / token 文件 0600 | PARTIAL | Windows 上 chmod 映射为只读位，无法完全等价 POSIX 0600；依赖用户目录 ACL |
| Electron 沙箱 | PARTIAL | renderer 使用 `contextIsolation`、`nodeIntegration:false`；本地页面使用 `sandbox:false` 以兼容 file/HTTP 加载，属已知取舍 |
