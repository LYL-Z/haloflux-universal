# 性能测试报告（Performance）

> 只记录本机实测数字。每条都注明**测试时长、机器、采样方法**；未测项明确写 TODO，不估算、不美化。
> 测试时间：2026-11-08 16:23–16:28 UTC（America/Los_Angeles 08:23–08:28）。
> 原始数据：`tests/evidence/soak-5min.json`、`tests/evidence/soak-2026-11-08_16-22-24.json`、`screenshots/visual-capture-stats.json`。

## 1. 机器与环境

| 项 | 实测值 |
|---|---|
| OS | Windows 11 家庭中文版 10.0.26300 x64 |
| CPU | Intel Core Ultra 9 290HX Plus，24 核 / 24 逻辑处理器 |
| 内存 | 68,378,017,792 B ≈ 63.7 GiB |
| GPU | NVIDIA GeForce RTX 5090 Laptop GPU（驱动 32.0.16.1742）；另有 ToDesk 虚拟显示 |
| Node.js | v24.16.0 |
| Electron | 43.3.0（DeepSeek Harness 自带，`C:\Users\Lenovo\.dsh\electron\electron.exe`，零下载） |
| 渲染分辨率 | 1600×900 逻辑；本机 DPR 2.4–2.5 → 3840×2250 物理。仓库内截图已缩为 1600px 宽，原始图仅本机保留 |
| 关键约束 | 自动化截图/浸泡使用软件渲染（`HALOFLUX_SOFTWARE_RENDER=1`）以保证确定性；真实窗口默认启用 GPU，实测可用（见 §3）。Electron 43.3.0 在 **argv 携带 `file://` URL** 时会在主脚本执行前退出，因此所有自动化管线都把 URL 放进环境变量。 |

## 2. 5 分钟浸泡测试（真实 bridge + 离屏 Electron renderer）

命令（QA 实测，后台运行，未与其他测试并行）：

```powershell
node scripts/soak.mjs --minutes 5 --events-per-second 8 --out tests\evidence\soak-5min.json
```

方法：

1. `packages/event-bridge/src/server.mjs` 以 **179xx 随机端口**（脚本保证 17910–17999、绝不使用 17817；本次运行未记录具体端口值）+ 临时 `HALOFLUX_HOME` + 随机 32 字节 token 启动；
2. 以 8 events/s 持续 POST 合法 v1 事件（12 个模拟会话轮转 session.start→task.received→run.start→tool.start→tool.end→run.end）；
3. 每 5 s 用 `powershell.exe Get-Process -Id <bridgePid>` 采样 bridge 的 `WorkingSet64` 与累计 `CPU` 秒数（CPU% = ΔCPU/Δt/24 核）；
4. 同一时间，Electron 离屏窗口（1600×900，`backgroundThrottling:false`，隐藏窗口）加载 renderer `?qa=1&mock=1`；
   每 2 s 注入的 rAF 计数器差值算 fps，`performance.memory.usedJSHeapSize` 算 JS 堆，
   `app.getAppMetrics()` 的 renderer/Tab 进程算渲染 CPU；共 107 个 renderer 样本；
5. 事件全部经真实 `/v1/events` 校验（0 post error，0 拒绝）。

### 2.1 汇总结果（实测）

| 指标 | 结果 |
|---|---|
| 实测时长 | **303.7 s（5.06 min）** |
| bridge 样本数 | 60（每 5 s） |
| 事件发送 / 接受 | **1684 / 1684**，postErrors = 0 |
| 最终 bridge eventCount / sessions | 1684 / 12 |
| bridge RSS | **65.09 MB → 71.26 MB**（+6.18 MB / 5 min） |
| bridge CPU | 平均 **0.03%**，峰值 **0.09%**（24 核百分比） |
| renderer fps（rAF，离屏隐藏窗口） | 平均 **0.91**，最低 0.23，最高 1.49（106 个有效样本） |
| renderer JS heap | 10.21 MB → **16.28 MB**（首个样本 10.21，末个 16.28；区间 7.84–16.93 MB） |
| renderer CPU | 平均 **4.08%**（107 个样本） |

> 独立复测（Lead，2026-11-08T16:27Z，`--events-per-second 10 --no-renderer`，5.0 min）：
> **1959/1959** 事件接受、`dropped=0`、bridge RSS **65.52 → 71.91 MB**、CPU 平均 **0.03%** / 峰值 **0.09%**。
> 报告：`tests/evidence/soak-2026-11-08_16-27-16.json`。两次独立运行的量级一致。

### 2.2 解释与边界

- **bridge 侧开销极小**：1684 事件/5 min、12 会话下 CPU 平均 0.03%，RSS 增长 6.18 MB。该增长是缓慢单调上升（65→71 MB），
  不足以判定泄漏：V8 堆自然增长/GC 也会产生该曲线。**必须做 ≥30 min 浸泡并观察 GC 后基线**才能下结论（TODO）。
- **fps 0.91 不是屏幕性能结论**：窗口 `show:false` 时 Chromium 会节流 rAF；加上硬件加速禁用，该数字只能作为
  "隐藏窗口下限"。任务要求的 fps 采样已如实完成并保存，但不能拿它代表用户可见窗口。
- **renderer CPU 4.08%** 为 `app.getAppMetrics()` 对 Tab 进程的采样；受隐藏窗口节流影响，真实可见窗口会更高。

## 3. 三种窗口模式（Lead 实测，GPU 路径）

> 来源：Lead 于 2026-11-08 在真实屏幕上切换三种模式测得（DPR 2.5，GPU 路径），**非 QA 复测**；
> 与 §2 的离屏软件渲染口径不同，不可直接相减/比较。

| 模式 | 分辨率 | fps（Lead 实测） |
|---|---|---|
| window | 1600×900 @ DPR 2.5 | **31** |
| overlay（透明置顶） | 1600×900 @ DPR 2.5 | **24** |
| compact（内容视口 320×320） | 320×320 @ DPR 2.5 | **24** |

结论：GPU 路径下 window 约 31 fps，overlay/compact 因透明合成与小窗口路径约 24 fps；仍低于 60 fps，
性能守卫会按 42/55 fps 阈值自动降质（见 `packages/visual-core/src/perf.js` 的 1.2 s/55 fps 规则）。

## 4. 截图时的 HUD 采样（非浸泡，仅作旁证）

| 截图 | HUD 显示 | 说明 |
|---|---|---|
| `screenshots/companion-live-dsh.png` | 6 fps / 156.5 ms / 画质 75% / 2013 particles | 真实 DSH 会话，软件渲染窗口 |
| `screenshots/visual-companion.png` | 5 fps / 228.5 ms / 画质 50% / 677 particles | 模拟 6 会话，软件渲染 |
| `screenshots/visual-capture-stats.json` | 6 预设 fps 1.4–3.3；10 状态 fps 0.9–5.7 | file:// + 隐藏窗口，仅用于"能渲染"证明，不作性能结论 |
| `screenshots/visual-compact.png` | 320×320，fps 5.5（同文件 stats） | compact 布局正确；隐藏窗口限制同上 |

## 5. 结论

1. **事件桥/状态机不是瓶颈**：5 分钟 1684 事件、12 会话，CPU 0.03%，内存增长 6 MB 量级；空闲时几乎为零。
2. **渲染是瓶颈且受显卡/合成路径影响极大**：GPU 路径 24–31 fps（Lead 实测），软件/离屏 1–5 fps（QA 实测）。
3. 性能守卫在低帧率下会降质（截图 HUD 的"画质 50%/75%"即证据），但**低帧率本身不可隐藏**；
   需要用户侧选择合适的预设（minimal/ambient 粒子更少）并避免 4K 全屏叠加。
4. 目前**没有**发现确定内存泄漏；也**没有**足够长的时间证明没有泄漏。

## 6. TODO（未测，不得引用为结论）

- [ ] 30 分钟（或更长）soak，记录 GC 后 RSS 基线，判定泄漏；
- [ ] 用户可见窗口的连续 fps（而非截图/隐藏窗口单点），分 1080p/1440p/4K；
- [ ] 真实 GPU 路径下的 CPU/GPU 占用细分（fps 已实测 31/24/24，占用率未采样）；
- [ ] overlay 点击穿透/置顶对 DWM 合成与 fps 的影响；
- [ ] 20+ 会话、单会话 70 万 token 长事件流下的状态机内存与 UI 渲染；
- [ ] 冷启动时间（从 `haloflux.mjs start` 到首帧）与包体大小；
- [ ] 自动降质/恢复的连续曲线（42 fps 降档、55 fps 恢复）实测；
- [ ] 多显示器 DPR 混合（150% + 200%）下的窗口位置与渲染尺寸。
