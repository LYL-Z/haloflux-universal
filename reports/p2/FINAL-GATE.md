# P2 · 最终门禁（Final Gate）

- 分支：`feat/paper-lab-p2`（基于 `origin/main` `5fc9338`）
- 生成时间：2026-11-09T13:05Z 左右
- 结论：**PARTIAL（可交付候选，等待用户视觉审核与授权推送）**
- 未执行：推送 `main`、创建 PR、部署 Pages、发布 Release、修改真实 Obsidian Vault、重启 DSH。

## 1. 阶段门禁

| 阶段 | 状态 | 证据 | 说明 |
|---|---|---|---|
| P0 基线/保全/补丁核验 | **PASS** | `reports/p2/P0-BASELINE.md`、`P0-FILE-STATUS.json`、`P0.1-CORRELATION-FIX.md` | 工作区干净；远端 main `5fc9338` 已复核；补丁未重复应用；上游 `lab.html` 文本一致、LICENSE 已变更；P0.1 跨会话关联错误已修复并有回归测试 |
| P1 补丁导入与验收 | **PASS** | `reports/p2/P1-TESTS.md` | 导入时 82/82；P2.2 后全量 **93/93**（unit 69 + e2e 11 + security 13），build/typecheck 通过；17+1 截图 PASS |
| P2 视觉 A/B | **PARTIAL** | `reports/p2/VISUAL-DELTA-MATRIX.md`；`screenshots/p2/*`；30 s WebM 两份 | 构图/密度/masthead/扫描线/1280 比例已修正；底部真实画布；P2.2 修复 1280 host 裁切与模拟事件来源；剩余：束流连续感、无原版专用实验画布 |
| P3 可观测事件链路 | **PARTIAL** | `reports/p2/OBSERVABLE-EVENT-TRACE.md`、`P2.2-PROVENANCE-AND-GATE.md` | 事件级 source/confidence 四层贯通；toolCallId 关联/耗时；筛选/暂停/详情/缓存窗口；实时 DSH 新 toolCallId 需重启宿主 |
| P4 六宿主真实矩阵 | **PARTIAL** | `reports/p2/HOST-MATRIX.md`、`tests/evidence/p2-hosts/` | DSH PASS；Claude 工具 BLOCKED（未登录）；Codex/Cursor/WorkBuddy PARTIAL；TRAE UNSUPPORTED |
| P5 Obsidian | **PARTIAL** | `reports/p2/OBSIDIAN-STATUS.md` | 静态快照导入 PASS（E2E 16/16）；实时插件 NOT IMPLEMENTED；3 项 LOW 建议 |
| P6 安全/性能/无障碍 | **PASS（带 PARTIAL 项）** | `reports/p2/SECURITY-PERFORMANCE.md`、`P2.2-PROVENANCE-AND-GATE.md` | 安全 13/13 + 定向探针 21/21 PASS；XSS 端到端 PASS；P2.2 后窗口 **38.6 fps / mean 25.9 ms / p95 45.8 ms**、overlay **28.5 fps**；30 min soak **11631/11631 accepted**（RSS +12.65 MB，CPU 0.02%）；对比度/200% 缩放/Windows token ACL 为 PARTIAL |
| P7 交付文档/受控 PR 候选 | **PARTIAL** | 本目录 + `screenshots/p2/` | 分支已推送 `feat/paper-lab-p2`；**Draft PR #1 已创建**（未转 Ready、未合并、未部署 Pages/Release）；证据与报告已同步 |

## 2. 本轮实际代码修改

| 区域 | 文件 | 摘要 |
|---|---|---|
| 补丁导入 | 12 个文件（P1） | Paper Lab 8 单元监控台、投影、Obsidian 静态导入、预设、文档、测试 |
| P2 视觉 | `packages/visual-core/src/presets.js`、`apps/companion/renderer/styles.css` | 环 scale 0.86、亮度/束流收敛、控制台 288/300 px、字号 10–12 px |
| P3 事件 | `packages/event-schema/{src/index.ts,schema/event.schema.json}`、`packages/session-manager/src/index.mjs`、`apps/companion/renderer/{monitor-projection.mjs,app.js}`、`adapters/{deepseek-harness/haloflux-bridge/index.js,claude-code/adapter.mjs,_shared/event-client.mjs,_shared/schema-lite.mjs}` | 可选 `toolCallId/runId`；真实耗时关联；`TOOL / DURATION` 行；来源不降级；适配器 >100 事件自动分批 |
| 许可 | `LICENSE`、`NOTICE`、`README.md` | 同步上游 2026-11-09 LICENSE（分享署名条款） |

## 3. 可复现命令（本机）

```powershell
cd D:\HALOFLUX
git switch feat/paper-lab-p2
npm ci
npm run build
npm run typecheck
npm test                      # 93/93
node scripts/capture.mjs      # 17+1 截图
node scripts/p2-capture.mjs --root . --path "upstream/haloflux/lab.html" --out screenshots/p2/upstream-1600x900.png --width 1600 --height 900
node scripts/p2-capture.mjs --root . --path "apps/companion/renderer/index.html?qa=1&mock=1&preset=agent-monitor&state=tool" --out screenshots/p2/after-1600x900.png --width 1600 --height 900
node scripts/p2-record-app 环境变量见 VISUAL-DELTA-MATRIX.md
```

## 4. 未完成 / 阻塞（如实）

| 项 | 状态 | 下一步 |
|---|---|---|
| Claude Code 工具链 | BLOCKED | 用户登录后复跑真实 turn |
| Codex 原生 hook 投递 | NOT_TESTED | Codex `/hooks` 信任后复测；当前只有派生 |
| Cursor 真实事件 | NOT_TESTED | 在 Cursor GUI 内执行一次真实 agent 任务并采集 |
| TRAE | UNSUPPORTED | 无可信公开接口前不开发 |
| DSH 实时 toolCallId/run.end | BLOCKED | 需重新安装 bundle 并重启 DSH |
| 视觉最终 PASS | 等待用户 | 看 `after-1600x900.png` + 两份 30 s 录屏后决定 |
| 远端 PR | Draft #1 | 保持 Draft；未转 Ready、未合并 |

> 截图口径：`screenshots/p2/after-*` 使用 `?qa=1&mock=1` 模拟事件，只证明投影/渲染；真实宿主证据使用 `screenshots/p2/real-dsh-live.png`（真实 bridge、NAT/DRV 混合、LIVE）与 `tests/evidence/p2-hosts/`、`/v1/state` 快照。二者分开存档，不得把模拟截图当作真实接入 PASS。

## 5. 安全与许可摘要

- 回环监听、token 鉴权、Origin/Host、413/429、路径穿越、XSS、日志脱敏均实测通过（P6）。
- 适配器不发送 prompt/正文/工具参数/凭据；schema 白名单拒绝未知 metadata。
- 上游 LICENSE 已同步；发布截图/录屏必须注明来源；禁止商业使用。
- 未修改真实 Obsidian Vault、未绕过 Claude 登录、未重启用户 DSH、未动 `main`。
