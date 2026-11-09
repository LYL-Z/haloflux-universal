# HALOFLUX 上游审计（Upstream Audit）

> 本文件由 qa-docs 维护，记录 HALOFLUX 与 dsh-haloflux 的许可证、代码审计、复用与原创边界。
> 审计对象是本仓库 `upstream/` 目录中的只读副本。核对时间：2026-11-08（America/Los_Angeles）。
> 方法：`git ls-remote`/P0 报告记录的 commit、逐文件读取、正则扫描网络与动态代码 API、SHA256 计算。

## 1. 上游身份与版本

| 项目 | 仓库 | Commit / Tag | 版本 | 许可证 |
|---|---|---|---|---|
| HALOFLUX（原作） | https://github.com/Ryder191/haloflux | `016bef651c4f911f08039ba159d36a6f246ff5d2` | main（2026-11-02 快照） | PolyForm Noncommercial License 1.0.0 |
| dsh-haloflux（DSH 移植） | https://github.com/Ke-wood/dsh-haloflux | `90a1caa7fbb6b7b7c24151ecf9fdde767362845f`（tag `v0.7.1`） | 0.7.1 | PolyForm Noncommercial License 1.0.0 |

- 原作在 2026-10-26 之前的版本曾以 MIT 发布；**当前快照不是 MIT**。本项目不得声称 MIT，也不得商业化。
- 两份副本都是只读参考资料，本仓库不改写 `upstream/**`；DSH 安装步骤写入的是 DSH profile，而不是 `upstream/`。

### 文件哈希（SHA256，前 16 位）

| 文件 | SHA256 前缀 | 大小（字节） |
|---|---|---|
| `upstream/haloflux/lab.html` | `A8C4F08D8AF2F6A7` | 95,655 |
| `upstream/haloflux/mobile.html` | `30C7CDB99FCCF3DB` | 98,784 |
| `upstream/dsh-haloflux/client.js` | `903F659B7D140A1D` | 258,839 |
| `upstream/dsh-haloflux/src/engine.js` | `12CE5EFE5FA76133` | 124,167 |

> 以上为 2026-11-08 在本机用 `Get-FileHash -Algorithm SHA256` 实测结果，与 P0 报告记录一致。
> 实测扫描结果：`upstream/**` 中没有 `fetch(`、`XMLHttpRequest`、`WebSocket`、`eval(`、`new Function`、`importScripts` 命中；
> 原作 `lab.html` 第 19/20 行与 `mobile.html` 第 23/24 行存在 Google Fonts 外链（本项目移植时已移除，渲染器使用系统字体栈）。

## 2. 依赖与网络审计

| 检查项 | 原作 `haloflux` | `dsh-haloflux` | 本仓库结论 |
|---|---|---|---|
| npm/runtime 依赖 | 无（单 HTML + Canvas） | 无第三方运行时依赖；宿主接口由 DSH 注入 | 不新增依赖（Node 内置 + Electron） |
| 外部网络请求 | `lab.html`/`mobile.html` 无 `fetch/XHR/WebSocket`；`<head>` 引用 `fonts.googleapis.com`/`fonts.gstatic.com` | 未发现 `fetch/XHR/WebSocket`；只读 DSH Client 会话服务与 `localStorage` | 移植版移除 Google Fonts 外链，使用系统字体栈；运行时仅回环 bridge |
| 动态代码 | 未发现 `eval` / `new Function` / `importScripts` | 未发现 | 本仓库禁止动态代码；渲染器为静态 ES modules |
| 遥测/自动更新 | 无 | 无 | 不启用遥测；无自动更新 |
| 媒体资源 | `audio/sw421k.mp3`（CC0，The Cynic Project）；本仓库不加载 | 无 | NOTICE 中已注明音乐不随本项目加载 |
| 写入宿主外部文件 | 无 | 仅 bundle 安装进 DSH profile | 本仓库所有宿主配置修改都必须备份 + manifest + 回滚 |

> 关键隐私差异：原作/移植版把会话文本用于环形数据面板；本项目的通用事件协议**不传输 prompt/正文/tool args/results**，仅元数据白名单（见 `docs/03-security-and-license.md`）。

## 3. 复用与原创边界

### 复用（衍生作品，必须署名）

- HALOFLUX 的 Canvas 光场视觉语言：光场核心、旋转环、微型数据面板、层叠光束、节拍/运镜设计。
- dsh-haloflux v0.7.1 的 Canvas 引擎移植与参数体系（109 项参数中的原作 56 项 + 移植新增项，本仓库按需裁剪）。
- 复用的代码/视觉资产保留 `LICENSE`、`NOTICE` 与 Required Notice 行。

### 原创（本仓库，不来自上游）

- 统一事件协议 `packages/event-schema`（schemaVersion 1、元数据白名单、批量/大小限制）。
- 回环事件桥 `packages/event-bridge`（token 鉴权、常量时间比较、SSE、限流、大小限制、Origin/Host 校验）。
- 多会话状态机 `packages/session-manager`（去重、乱序策略、超时阶梯、派生状态）。
- 设置与原子持久化 `packages/settings`、性能守卫与预设体系 `packages/visual-core`、Electron 伴随应用、六个宿主适配器、安装/回滚脚本、测试与文档。

### 许可结论

- 本项目整体为 **PolyForm Noncommercial 1.0.0 的非商业衍生作品**，仅限个人学习/研究/娱乐，不得商业使用。
- 再分发必须保留 `LICENSE`、`NOTICE`、`Required Notice` 与作者链接；修改版本必须标注 "modified from HALOFLUX"。
- 详见 `docs/03-security-and-license.md` §5。

## 4. 审计方法与可复现命令

```powershell
# 文件哈希
Get-FileHash upstream\haloflux\lab.html, upstream\haloflux\mobile.html, `
  upstream\dsh-haloflux\client.js, upstream\dsh-haloflux\src\engine.js -Algorithm SHA256 |
  Format-Table Path, Hash

# 网络/动态代码扫描（无输出 = 未发现）
Select-String -Path upstream\haloflux\*.html, upstream\dsh-haloflux\src\*.js, upstream\dsh-haloflux\*.js, upstream\dsh-haloflux\*.mjs `
  -Pattern 'fetch\s*\(|XMLHttpRequest|WebSocket|eval\s*\(|new\s+Function|importScripts' -CaseSensitive:$false

# 外部字体引用
Select-String -Path upstream\haloflux\*.html -Pattern 'fonts.googleapis.com|fonts.gstatic.com'
```

实测结果将在最终验证（`docs/08-final-verification.md`）中记录；任何未能复现的声明都保持"待核对"，不写成已完成。
