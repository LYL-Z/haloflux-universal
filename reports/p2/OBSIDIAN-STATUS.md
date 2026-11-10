# P5 · Obsidian 只读集成：状态、验证与安全审查

| 项 | 实测值 |
|---|---|
| 任务 | `task-8`（P5 Obsidian static snapshot verification + plugin feasibility） |
| 分支 / HEAD | `feat/paper-lab-p2` / `0a9e389`（`feat: add observed-event Paper Lab monitor and opt-in Obsidian snapshot`） |
| 工作目录 | `D:\HALOFLUX`（Windows 11，Node `v24.16.0`，Electron `43.3.0`） |
| 审查者 | `obsidian-review` |
| 审查时间 | 2026-11-09 12:23–12:34 UTC（America/Los_Angeles 04:23–04:34） |
| 约束遵守 | 未切换分支、未 commit、未 push、未修改任何源文件、未访问任何真实 Obsidian Vault、未安装/实现插件 |
| 写入范围 | 本报告 + `tests/evidence/p2-obsidian/`（审查证据，不进入 CI） |

> 工作区状态说明：审查期间工作区还有其它 P2 任务的未提交改动（`styles.css`、`presets.js`、`screenshots/` 等）。本次审查的 `app.js`、`obsidian-metadata.mjs`、`tests/unit/obsidian-metadata.test.mjs`、`docs/obsidian-readonly.md` **均未被修改**，内容与 HEAD `0a9e389` 一致（`git status` 未列出这些文件）。

---

## 0. 结论（TL;DR）

- **静态快照导入能力：PASS（已端到端验证）**。只接受 `schema=haloflux.obsidian.metadata.v1` 与 `notes/links/folders` 三个非负安全整数（≤ 50,000,000）+ 可选 `generatedAt`；标题、路径、正文、附件等全部丢弃；64 KiB 上限在 `app.js` 侧生效（含 65,536 B，拒绝 65,537 B）；数据只存在页面内存；不写 `localStorage`；不产生任何外部或事件桥请求；DOM 全部经 `textContent` 渲染。
- **实时 Obsidian 插件：NOT IMPLEMENTED**。仓库内不存在插件代码、`manifest.json` 或相关依赖；本轮只做可行性评估，未安装、未实现、未接触真实 Vault。
- **模块总门禁：PARTIAL**。已实现的静态快照子项通过；实时插件按设计缺席；另有 3 项 LOW 卫生问题和 4 项 INFO 观察（见 §4），无 HIGH/CRITICAL 漏洞。
- **安全结论**：未发现可实际利用的 XSS、原型污染、越权读取、数据外发或事件桥注入路径；CSP 的 `connect-src` 只允许 loopback，进一步限制了任何外发可能。

| 门禁子项 | 判定 | 依据 |
|---|---|---|
| 静态快照导入（本轮唯一已实现能力） | **PASS** | 代码审查 + 2/2 单测 + 17 项独立负向断言 + 16 项 Electron E2E 断言全部通过 |
| 实时 Obsidian Vault 插件 | **NOT IMPLEMENTED** | 无代码、无安装、无真实 Vault 访问；不参与本轮通过 |
| P5 Obsidian 模块总门禁 | **PARTIAL** | 静态子项 PASS；实时子项缺席；LOW 项需在后续迭代修复（不构成阻断） |

---

## 1. 审查范围与方法

### 1.1 读取的代码与文档

| 文件 | 用途 |
|---|---|
| [P0-BASELINE.md](P0-BASELINE.md) | 分支/环境/许可基线 |
| [obsidian-metadata.mjs](../../apps/companion/renderer/obsidian-metadata.mjs) | 白名单解析器（18 行） |
| [app.js](../../apps/companion/renderer/app.js) | 文件选择、64 KiB 上限、状态保存、渲染（`lab-obsidian-file` / `parseObsidianMetadata`） |
| [index.html](../../apps/companion/renderer/index.html) | CSP、`OBSIDIAN / KNOWLEDGE FIELD` 面板与文件输入 |
| [styles.css](../../apps/companion/renderer/styles.css) | `.lab-import` 输入的可聚焦样式 |
| [obsidian-readonly.md](../../docs/obsidian-readonly.md) | 导出脚本、输入限制、隐私声明、插件未实现声明 |
| [obsidian-metadata.test.mjs](../../tests/unit/obsidian-metadata.test.mjs) | 已有 2 项单测 |
| [preload.js](../../apps/companion/preload/preload.js)、[modes.js](../../apps/companion/main/modes.js) | 确认渲染进程隔离与桥接 API 暴露面 |
| [PAPER-LAB-AUDIT-2026-11-09.md](../../docs/PAPER-LAB-AUDIT-2026-11-09.md)、README | 对外声明的一致性核对 |

### 1.2 方法与证据层级

1. **静态代码审查**：数据流从文件输入到 DOM 的每一跳，逐行核对。
2. **既有单测**：`node --test tests/unit/obsidian-metadata.test.mjs`（2/2）。全量单测 `npm run test:unit`（58/58）确认无回归。
3. **独立负向测试**（临时脚本，不提交 CI）：[negative-probe.mjs](../../tests/evidence/p2-obsidian/negative-probe.mjs)，17 项 PASS + 4 项 INFO；输出见 [negative-probe-output.txt](../../tests/evidence/p2-obsidian/negative-probe-output.txt)。
4. **Electron 端到端探针**（真实渲染进程 + 真实 `DataTransfer`/`File` 导入）：[browser-probe-main.cjs](../../tests/evidence/p2-obsidian/browser-probe-main.cjs)，16/16 PASS；机器可读结果见 [browser-probe-result.json](../../tests/evidence/p2-obsidian/browser-probe-result.json)。
5. **网络/存储/日志观测**：Electron `webRequest` 全量记录 + 页面 `localStorage` 枚举 + 控制台消息捕获。

> 说明：端到端测试使用 `?demo=1&qa=1` 与本地 loopback 静态服务器（Chromium 的 `file://` 下 ES module 不便于自动化）。被测代码与线上使用同一份 `app.js` / `obsidian-metadata.mjs`；差异仅在数据源（demo 模拟而非真实事件桥），而 Obsidian 导入路径与事件桥无耦合。

---

## 2. 当前能力：静态元数据快照

### 2.1 数据流

```
用户点击 IMPORT LOCAL METADATA JSON
  → 系统文件选择器（accept=".json,application/json"）         index.html:163
  → change 事件：file.size > 65536 ? toast 拒绝 : 继续          app.js:1259-1266
  → file.text()（UTF-8 解码，自动剥离 BOM）                     app.js:1268
  → JSON.parse（异常 → 通用 toast，不回显内容）                  app.js:1267-1278
  → parseObsidianMetadata：白名单校验 → 新对象 + Object.freeze  obsidian-metadata.mjs:8-17
  → state.obsidianMetadata = parsed（模块级内存，刷新即失）       app.js:250,1273
  → renderLabMonitor() → 5 行文本明细（textContent）             app.js:843-854,810-817
```

不读取 Vault、不访问文件系统（除用户选择的单个文件）、不写磁盘、不发网络。

### 2.2 白名单与限制（对照任务要求）

| 要求 | 实现 | 位置 | 结论 |
|---|---|---|---|
| 只接受 `haloflux.obsidian.metadata.v1` | 严格字符串相等，大小写/前后缀均拒绝 | `obsidian-metadata.mjs:9` | ✅ |
| `notes/links/folders` 为非负安全整数 | `Number.isSafeInteger(v) && v >= 0` | `obsidian-metadata.mjs:4-6` | ✅ |
| 每项上限 5,000 万 | `v <= 50_000_000` | `obsidian-metadata.mjs:5` | ✅（0 与 50,000,000 均接受，50,000,001 拒绝） |
| 可选 `generatedAt` | 字符串且可被 `Date.parse` 才保留，否则置 `null`；统一 `toISOString()` | `obsidian-metadata.mjs:14-16` | ✅（见 LOW-3/INFO） |
| 禁止标题/路径/正文/附件 | 不读取输入对象的其他键；返回值是新对象字面量，无 spread | `obsidian-metadata.mjs:17` | ✅（负向测试 09/11） |
| 文件大小上限 64 KiB | `file.size > 65536` 拒绝（65536 字节可导入） | `app.js:1263-1266` | ✅（E2E 06/07） |
| 只在内存 | `state.obsidianMetadata`；无持久化调用 | `app.js:250,1273` | ✅（E2E 04） |
| 不写 `localStorage` | `writePreferences` 只写 `preset/overrides/reducedMotion`；该状态不参与 | `app.js:82-88,338-359` | ✅（E2E 04：导入后 `localStorage` 键集合为空） |
| 不发网络 | 渲染层无 `fetch/XHR/WebSocket`；仅 loopback SSE（需 token）；导入路径不触达 | `app.js:1155`；CSP `connect-src` | ✅（E2E：11 个请求全部为同源静态资源，0 个事件桥请求，0 个跨源请求） |
| 不把文件名/内容放进 DOM/日志 | 文件名未使用；错误 toast 为固定文案；`app.js` 无 `console.*` | `app.js:1259-1279` | ✅（E2E：控制台消息 0 条；`SECRET-VAULT-NAME` 未出现在 DOM 文本） |

### 2.3 渲染与面板

`OBSIDIAN / KNOWLEDGE FIELD` 面板展示 5 行：`NOTES`、`RESOLVED LINKS`、`FOLDERS`、`SOURCE = LOCAL JSON SNAPSHOT`、`SYNC = STATIC / NO LIVE ACCESS`；未导入时显示 `VAULT NOT CONNECTED / LINK GRAPH — / ACCESS 未授权 · 不读取笔记`（`app.js:843-854`）。所有值经 `make()` 的 `textContent` 写入（`app.js:284-289`），`detail()` 也只 `append` 元素并 `String(value)`（`app.js:810-817`）；`app.js` 全文无 `innerHTML/outerHTML/insertAdjacentHTML/document.write`。文件输入视觉隐藏但保留焦点（`styles.css:1197-1198`），有 `:focus-within` 轮廓，键盘可达。

---

## 3. 验证结果

### 3.1 既有单元测试

```
node --test tests/unit/obsidian-metadata.test.mjs
✔ allowlisted aggregate import strips path/title/body fields
✔ Obsidian refuses wrong schema, noninteger and negative fields
tests 2 / pass 2 / fail 0
```

全量：`npm run test:unit` → **58 tests / 58 pass / 0 fail**（11 suites，含上述 2 项）。

### 3.2 独立负向测试（17 PASS + 4 INFO）

脚本：[negative-probe.mjs](../../tests/evidence/p2-obsidian/negative-probe.mjs)；完整输出：[negative-probe-output.txt](../../tests/evidence/p2-obsidian/negative-probe-output.txt)。

| # | 用例 | 结果 |
|---|---|---|
| 01 | 合法聚合解析为精确的冻结白名单对象 | PASS |
| 02 | 缺失/错误/大写/尾随空格/后缀 schema 全部拒绝 | PASS |
| 03 | 负数计数（`-1`、`-1e-9`，三个字段）拒绝 | PASS |
| 04 | 小数计数（`1.5/0.1/1e-7/9.999`）拒绝 | PASS |
| 05 | 字符串/布尔/null/undefined/NaN/±Infinity 计数拒绝 | PASS |
| 06 | 50,000,001、`MAX_SAFE_INTEGER`、`2^60`、`1e300` 拒绝 | PASS |
| 07 | 边界 0 与 50,000,000 接受 | PASS |
| 08 | 非对象输入（null/undefined/数组/字符串/数字/布尔/函数）不抛异常 | PASS |
| 09 | `path/titles/body/attachments/vaultName/owner` 被剥离，输出无敏感标记 | PASS |
| 10 | 不修改输入对象、输出不与输入别名 | PASS |
| 11 | JSON `__proto__` / `constructor.prototype` 不污染 `Object.prototype`，输出无自有 `__proto__` | PASS |
| 12 | 输出序列化不含污染标记 | PASS |
| 13 | 70 KiB 未知字段 JSON 只产出小型白名单对象（解析 < 1 s） | PASS |
| 14 | 20,000 个额外键被忽略，输出仍为 6 个键 | PASS |
| 15 | 合法 ISO `generatedAt` 规范化为 `toISOString` | PASS |
| 16 | 非法/非字符串 `generatedAt` 不会变成垃圾非空值（保持 `null`） | PASS |
| 17 | 解析器源码无对不可信对象的 spread/copy，保留安全整数与冻结守卫 | PASS |
| INFO | 继承属性可被接受（`Object.create` 载体；`JSON.parse` 不可达） | 观察 |
| INFO | `-0` 被接受（`Number.isSafeInteger(-0)` 为 true） | 观察 |
| INFO | `Date.parse('1')` 宽松解析为 2001-01-01（当前未展示） | 观察 |
| INFO | 单独 `JSON.parse` 拒绝 BOM，但 `File.text()` 会剥离 BOM，因此应用内可正常导入（E2E 证实） | 观察 |

### 3.3 Electron 端到端（16/16 PASS）

环境：Electron 43.3.0 / Chromium（DSH 自带），`show:false` 隐藏窗口，`?demo=1&qa=1`，本地 loopback 静态服务器。脚本：[browser-probe-main.cjs](../../tests/evidence/p2-obsidian/browser-probe-main.cjs)；结果：[browser-probe-result.json](../../tests/evidence/p2-obsidian/browser-probe-result.json)。

| # | 断言 | 结果 |
|---|---|---|
| 01 | 初始为 `VAULT NOT CONNECTED` | PASS |
| 02 | 合法导入渲染出 3,392 / 24,636 / 9 与静态来源标签 | PASS |
| 03 | 敏感额外字段与所选文件名（`SECRET-VAULT-NAME`）均不进入 DOM 文本 | PASS |
| 04 | 导入后 `localStorage` 无任何快照相关键/值（键集合为空） | PASS |
| 05 | 导入后文件输入被清空（不保留文件句柄） | PASS |
| 06 | 恰好 65,536 字节 JSON 被接受（上限含边界） | PASS |
| 07 | 65,537 字节 JSON 被拒绝，toast 显示「超过 64 KiB」 | PASS |
| 08 | 错误 schema 拒绝，toast「格式不正确」 | PASS |
| 09 | 负数 / 小数 / 字符串计数分别拒绝 | PASS |
| 10 | `__proto__`/`constructor` 载荷不污染原型、不注入元素/不执行内联事件 | PASS |
| 11 | 64 KiB 深嵌套非法 JSON 只触发通用 toast，页面保持存活 | PASS |
| 12 | UTF-8 BOM 前缀 JSON 被接受（`File.text()` 剥离 BOM，Windows 友好） | PASS |
| 13 | 明细区仍为 5 行 × 2 子元素的纯文本结构 | PASS |
| 14 | CSP `connect-src` 仅 `http://127.0.0.1:* http://localhost:*` | PASS |

运行时观测（来自结果 JSON）：

- `network.requestCount = 11`：全部是同一 loopback 源下的页面/模块/样式资源；`offOrigin = []`，`bridgeHits = []`。
- `consoleMessages = []`（页面控制台 0 条消息），`consoleLeaks = []`；导入数据未进入日志。
- `observations.oversizeRetainsPreviousSnapshot = true`：**超限文件被拒后，上一次成功导入的快照仍留在面板上**（见 LOW-2）。
- `observations.clearControlPresent = false`：面板内没有清除/断开按钮。
- `observations.generatedAtDisplayed = false`：解析并保存了 `generatedAt`，但 UI 未展示时间或新鲜度。

### 3.4 未验证 / 无法验证的内容（明确边界）

| 项 | 原因 |
|---|---|
| 真实 Obsidian Vault 上的导出脚本 | 任务禁止访问真实 Vault；`docs/obsidian-readonly.md` 的控制台脚本仅做静态审阅 |
| GitHub Pages 线上部署 | HEAD 未推送；线上仍是旧版，无法验证部署后的快照导入 |
| 真实事件桥联调下的导入 | 导入路径与事件桥无耦合；E2E 证明导入期间 0 次桥请求即可 |
| 操作系统文件选择器本身 | 探针用合成 `File` 驱动 `change` 事件；`file.size`/`file.text()` 路径与真实选择器一致 |
| 屏幕阅读器完整体验 | 仅确认输入可聚焦、有 focus 轮廓；未做 WCAG 全量评测 |

---

## 4. 安全发现

未发现 HIGH/CRITICAL。逐项结论：

| ID | 级别 | 发现 | 证据 | 影响与建议 |
|---|---|---|---|---|
| LOW-1 | LOW | 解析器通过属性访问读取 `value.schema/notes/...`，因此**继承属性**也能通过校验（`Object.create` 载体） | 负向探针 INFO；`obsidian-metadata.mjs:9-14` | 当前调用方只有 `JSON.parse`，而 JSON 对象不会产生自定义原型，**不可实际利用**。防御性建议：改用 `Object.hasOwn(value, ...)` 逐字段读取，或以 `Object.create(null)` 构造返回值 |
| LOW-2 | LOW | 导入失败/超限时**不清除**上一次快照，也没有 CLEAR/断开入口；面板缺少「快照时间 / 已过期」提示 | E2E 07/08/11 观察；`app.js:1263-1278,843-854` | 用户可能误以为新文件已生效，或看到陈旧数字。建议增加显式 CLEAR、展示 `generatedAt` 与「STALE > N 分钟」标签；失败时保留旧值时标注「LAST IMPORT FAILED」 |
| LOW-3 | LOW | `Date.parse` 宽松（`"1"` → 2001-01-01）；非法时间被静默降级为 `null` 而非拒绝 | 负向探针 INFO；`obsidian-metadata.mjs:14-16` | 当前不影响安全与展示（时间未显示）。若后续展示新鲜度，应改用严格 ISO-8601 校验（正则 + `Number.isNaN(Date.parse)` 之外的范围检查），并在无效时给出提示 |
| INFO-1 | INFO | `-0` 被接受（`-0 >= 0` 为 true） | 负向探针 INFO | 显示为 0，无实际影响；如追求语义严格可显式排除 `Object.is(v, -0)` |
| INFO-2 | INFO | 解析器本身没有字节上限，64 KiB 上限只在 `app.js` 的文件选择边界 | `app.js:1263`、`obsidian-metadata.mjs` | 当前边界正确；若未来在插件/桥接端复用该解析器，必须在新的入口重复大小与速率限制 |
| INFO-3 | INFO | 文档写「不解析、呈现或保存未列入白名单的 JSON 属性」；实际是 `JSON.parse` 解析整个文件后**丢弃**未列入白名单的键 | `docs/obsidian-readonly.md:36`、`app.js:1268` | 表述建议改为「不保留、不呈现、不保存」，避免读者误解为流式白名单解析 |
| INFO-4 | INFO | 导出脚本用 `file.constructor?.name === 'TFolder'` 判断文件夹；`getAllLoadedFiles()` 可能包含根目录 | `docs/obsidian-readonly.md:20-21,31` | 未在真实 Vault 验证。建议改为 `file.children !== undefined` 或（若控制台可访问）`instanceof TFolder`，并在文档中保留根目录说明 |

### 4.1 逐项安全审查结论（对应任务第 3 项）

| 通道 | 是否可能进入 | 证据 |
|---|---|---|
| 事件桥 | **否**。渲染层无向桥发送数据的代码；桥仅在需要时以 SSE 读取；E2E 导入期间 0 次桥请求 | `app.js:37,843,1259-1279,1155`；E2E `bridgeHits=[]` |
| 日志 | **否**。`app.js` 无 `console.*`；E2E 页面控制台 0 条消息，`consoleLeaks=[]` | grep + E2E |
| `localStorage` | **否**。状态仅存模块变量；偏好写入仅 3 个字段；E2E 键集合为空 | `app.js:82-88,338-359,250,1273`；E2E 04 |
| DOM `innerHTML` | **否**。全部 `createElement` + `textContent`；无 `innerHTML` 系列 API | `app.js:284-289,810-817,362-371`；E2E 10/13 |
| 外部请求 | **否**。无 `fetch/XHR/WebSocket`；CSP 仅 loopback；E2E 全部同源 | `index.html:6-7`、`app.js:1155`；E2E 网络记录 |
| Electron IPC / 主进程 | **否**。preload 只暴露只读/控制类方法，渲染层未把快照写入任何 IPC 载荷；无通用 send | `preload.js:45-71`；`app.js` 仅订阅 `onStateChange/onPause/onResume` |
| 文件句柄/文件名 | **否**。文件名未使用；导入后输入被清空 | `app.js:1259-1261`；E2E 03/05 |

渲染正确性补充：`graph.notes.toLocaleString()` 等只产生字符串；`detail()` 的 `String(value)` 再交给 `textContent`，不存在把数字变成 HTML 的路径。恶意额外字段（含 `<img onerror>`、`<svg onload>`）在 E2E 中既未生成元素、也未执行。

---

## 5. 限制与不可宣称

- 这是**一次性、手动、只含三个聚合数字**的静态快照；不是实时同步，不连接 Vault，不读取笔记内容、标题、路径、标签、附件或节点 ID。
- 数据不会自动更新；刷新页面即清空，重新导入需再次选择文件。
- 不能据此宣称「观察到用户思维」「读取 AI 思维链」「构建完整知识图谱」。
- `links` 是 `MetadataCache.resolvedLinks` 的**有向**链接计数（未去重），不含未解析链接、嵌入与附件关系；索引未完成时数值可能偏小。
- 文件夹计数可能包含 Vault 根目录（文档已注明）。
- 仅在 Electron 43.3.0（DSH 自带 Chromium）上做了端到端验证；GitHub Pages 部署版与真实 Obsidian 导出的组合未验证。
- 实时插件不存在（详见 §6），不得作为 P5 已交付能力对外声明。

---

## 6. 实时 Obsidian 插件可行性（NOT IMPLEMENTED）

### 6.1 状态声明（硬事实）

- 仓库中**没有** Obsidian 插件代码、`manifest.json`、依赖或构建产物（全仓 `*obsidian*` 文件仅：解析器、文档、单测、本报告证据）。
- 未安装任何插件，未修改 Obsidian 配置，未访问任何 Vault。
- `docs/obsidian-readonly.md:42` 已明确「此实时插件尚不存在，不计入当前通过项目」——该声明与事实一致。

### 6.2 官方 API 映射（只读聚合）

| 聚合值 | 官方 API | 语义与注意点 |
|---|---|---|
| `notes` | `Vault.getMarkdownFiles().length` | 仅 Markdown；不含附件/画布等 |
| `links` | `MetadataCache.resolvedLinks` 双层计数求和 | 有向、已解析；索引完成前不完整；不含未解析链接/嵌入 |
| `folders` | `Vault.getAllLoadedFiles()` 中 `TFolder` 计数 | 可能含根目录；建议用 `children`/`instanceof` 判定（见 INFO-4） |
| `generatedAt` | 生成时刻 `new Date().toISOString()` | 用于新鲜度展示与过期判定 |

参考：[Vault](https://docs.obsidian.md/Reference/TypeScript+API/Vault)、[MetadataCache](https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache)（仓库文档已引用）。

### 6.3 建议架构（若未来立项）

```
┌────────────────────────── Obsidian（桌面端，用户显式安装） ──────────────────────────┐
│ 社区插件 haloflux-bridge（默认关闭网络）                                              │
│  - 设置页：目标端口、一次性 token、字段预览、连接测试、断开开关                        │
│  - 触发：onLayoutReady + metadataCache.on('resolved') + vault 事件（debounce ≥ 60 s） │
│  - 聚合：getMarkdownFiles / resolvedLinks / 文件夹计数（只读，不落盘）                 │
│  - 出口：仅 POST 127.0.0.1:<port>，Authorization: Bearer <token>                     │
│  - 载荷：{schema, notes, links, folders, generatedAt, pluginVersion}（无路径/标题/ID） │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │ loopback HTTP（仅本机）
┌──────────────────────────────────────▼───────────────────────────────────────────────┐
│ HALOFLUX 事件桥（新增端点，尚未实现）                                                 │
│  - POST /v1/obsidian/snapshot：token + 速率限制 + 与静态解析器相同的白名单复核        │
│  - 内存保存最新快照；SSE 推送给 renderer；断连即视为过期                              │
└──────────────────────────────────────┬───────────────────────────────────────────────┘
                                       │ 现有 SSE
                              renderer 的 OBSIDIAN 面板（沿用静态快照的 5 行展示）
```

### 6.4 同意与默认关闭

- Obsidian 插件本身就是「按 Vault 安装、按 Vault 启用」的显式选择；**仍须**在插件设置中提供默认关闭的网络开关，未开启时只做本地计算甚至不启动定时器。
- 首次连接展示：将发送的确切字段、目标地址、token 来源、发送频率；提供「仅预览不发送」。
- 拒绝静默启用、拒绝随 HALOFLUX 安装自动写入 Obsidian 配置。

### 6.5 loopback 鉴权

- 目标固定 `127.0.0.1`/`[::1]` 与已配置端口，禁止任意主机名（防 DNS rebinding）。
- token 由桥生成、插件粘贴保存；`Authorization` 头传递，禁止出现在 URL/日志/错误信息。
- 桥侧校验 token、限制请求体大小（≤ 4 KiB）、按来源与频率限流（如 1 次/分钟），并对未知 `Origin` 直接拒绝。
- 复刻静态解析器的白名单复核，绝不信任插件端数据。

### 6.6 撤销与卸载

- 设置页「断开」立即停发并清空本地缓存的快照设置（保留可选 UI 偏好）；桥侧轮换 token 即可使旧 token 失效。
- 卸载插件删除 `.obsidian/plugins/<id>/` 与 `data.json`；插件 `onunload` 清理定时器与监听器。
- 文档必须给出「如何确认已停止发送」的步骤（设置页状态、桥日志、无请求）。

### 6.7 数据新鲜度

- 插件：`onLayoutReady` 后首次发送；`metadataCache.on('resolved')` 与 vault 增删改/重命名事件触发 debounce 聚合；最小发送间隔 ≥ 60 s；桥不可达时指数退避并停止重试风暴。
- 桥/UI：保存 `generatedAt`，显示「快照于 N 分钟前」，超过阈值（如 15 分钟）标 `STALE`；Obsidian 退出即视为断开，不得沿用旧值冒充实时。

### 6.8 立项前的安全门禁（全部满足才可进入实现）

1. 独立 RFC：威胁模型（恶意网页→loopback、token 窃取、DNS rebinding、日志泄漏、大 Vault 性能）。
2. 只读聚合代码与桥端点分别评审；桥端点必须复用同一白名单校验。
3. 单元测试（mock Vault）+ loopback 集成测试；不使用真实 Vault 作为 CI 依赖。
4. 手动在一次性测试 Vault 上验收：授权、断开、卸载、token 轮换、过期标记、无请求。
5. 发布形态先手动安装/BRAT，不静默分发；社区插件上架前按 Obsidian 审核要求披露网络行为。
6. 文档与 UI 同步声明「聚合数字，不读取正文/路径/标题」。

### 6.9 风险与工作量（估算）

| 项 | 评估 |
|---|---|
| 技术可行性 | 高：所需数据均由官方只读 API 提供；插件侧无写入 |
| 主要风险 | Obsidian API/插件审核政策变化；token 落盘；用户误解为「实时读脑」；大 Vault 上 `resolvedLinks` 聚合开销 |
| 粗略工作量 | 原型 1–2 人日；加固/评审/文档 2–3 人日；不含社区上架周期 |
| 本轮结论 | **NOT IMPLEMENTED**；仅登记为后续 P3 候选，不进入 P2 通过项 |

---

## 7. 建议修复清单

| 优先级 | 建议 | 验收标准 |
|---|---|---|
| P1（合入前可选） | 解析器改用 `Object.hasOwn` 逐字段读取，消除继承属性接受面 | 负向探针新增 `Object.create` 用例返回 `null`；现有 2 项单测与 E2E 不回归 |
| P1 | 面板增加 CLEAR/断开与新鲜度展示（`generatedAt` + STALE 标签）；导入失败时标注旧值状态 | E2E：清除后回到 `VAULT NOT CONNECTED`；伪造旧时间显示 STALE |
| P2 | `generatedAt` 严格 ISO-8601 校验；无效时间按策略拒绝或明确标注 | 负向探针覆盖 `"1"`、无时区、越界日期 |
| P2 | 文档措辞修正（INFO-3）、导出脚本文件夹判定（INFO-4）、说明 BOM 与 64 KiB 含边界 | 文档与行为一致；导出脚本在一次性 Vault 上人工验证 |
| P2 | 将独立负向测试的稳定子集纳入 `tests/unit/`（CI） | `npm run test:unit` 覆盖 schema/边界/污染/额外字段 |
| P3 | 实时插件按 §6 立项；在此之前保持 `docs/obsidian-readonly.md` 的 NOT IMPLEMENTED 声明 | 独立 RFC + 安全评审通过 |

---

## 8. 门禁判定

| 判定对象 | 判定 | 理由 |
|---|---|---|
| 静态元数据快照（已实现） | **PASS** | 白名单、上限、64 KiB、内存-only、无 localStorage、无网络、textContent 渲染、CSP 约束均经代码审查 + 单测 + 独立负向 + Electron E2E 验证；无 HIGH/CRITICAL。LOW 项不构成阻断 |
| 实时 Obsidian 插件 | **NOT IMPLEMENTED** | 无代码/未安装/未访问 Vault；仅给出可行性架构与门禁 |
| P5 Obsidian 模块（对外口径） | **PARTIAL** | 只可宣称「可选的静态快照导入」；不得宣称实时同步、Vault 读取或知识图谱。若发布标准仅针对静态快照，则该子项为 PASS |

> 发布建议：P2 可以带「静态快照（可选，手动导入）」合入；README/演示中保留「实时插件未实现」字样。任何「Obsidian 实时同步」表述都应推迟到独立插件评审通过之后。

---

## 9. 证据与复现

| 证据 | 路径 |
|---|---|
| 独立负向测试脚本 | [tests/evidence/p2-obsidian/negative-probe.mjs](../../tests/evidence/p2-obsidian/negative-probe.mjs) |
| 负向测试输出（17 PASS / 4 INFO） | [tests/evidence/p2-obsidian/negative-probe-output.txt](../../tests/evidence/p2-obsidian/negative-probe-output.txt) |
| Electron E2E 探针 | [tests/evidence/p2-obsidian/browser-probe-main.cjs](../../tests/evidence/p2-obsidian/browser-probe-main.cjs) |
| E2E 结果（16/16 PASS，含网络/存储/日志观测） | [tests/evidence/p2-obsidian/browser-probe-result.json](../../tests/evidence/p2-obsidian/browser-probe-result.json) |
| E2E 运行日志 | [tests/evidence/p2-obsidian/browser-probe-run.log](../../tests/evidence/p2-obsidian/browser-probe-run.log) |

复现命令（Windows PowerShell，仓库根目录）：

```powershell
node --test tests/unit/obsidian-metadata.test.mjs
npm run test:unit
node tests/evidence/p2-obsidian/negative-probe.mjs

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& 'C:\Users\Lenovo\.dsh\electron\electron.exe' 'D:\HALOFLUX\tests\evidence\p2-obsidian\browser-probe-main.cjs'
```

> E2E 探针只写 `tests/evidence/p2-obsidian/`，使用隐藏窗口与临时 `userData` 目录，不触碰真实用户配置或 Obsidian 数据。

---

## 10. 参考

- [Vault API](https://docs.obsidian.md/Reference/TypeScript+API/Vault)
- [MetadataCache API](https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache)
- 仓库内：[docs/obsidian-readonly.md](../../docs/obsidian-readonly.md)、[docs/PAPER-LAB-AUDIT-2026-11-09.md](../../docs/PAPER-LAB-AUDIT-2026-11-09.md)、[reports/p2/P0-BASELINE.md](P0-BASELINE.md)
