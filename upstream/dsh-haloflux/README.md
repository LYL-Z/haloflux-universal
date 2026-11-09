# dsh-haloflux — 实时光环背景

把 **HALOFLUX** 的纯 Canvas 光场可视化，做成 DeepSeek Harness Web GUI 的全帧背景装饰，
并把原作里**预设的模拟数据**换成**当前会话的实时数据**：圆盘转动、词元抓取、光束迸发
都跟着模型调用走，调用结束即同步停住。

> 本包是自包含的：运行、构建、测试都只依赖包内文件与 DSH 自带的宿主接口，
> 不依赖工作区里的其它目录。

---

## 一、功能

| 能力 | 说明 |
|---|---|
| 全帧背景 | 挂载在 `shell.overlay`：透明底 + 加色发光，点击穿透，不遮挡聊天界面 |
| 会话驱动 | 词元、工具调用、`turn/step`、tok/s、上下文占用全部来自真实会话事件流 |
| 三档数据抓取 | 纯动画 / 混合 30% / 完全抓取，见下文 |
| 设置页面 | **设置 → HALOFLUX**：档位、预设、导入导出、全部 79 个参数 |
| HUD | `H` 键：KPI 条、事件流、工具调度、运镜按钮（默认关闭） |
| 三段状态机 | 运行态 / 静默态 / 无会话 各有目标强度，起势与收势独立时长、可调曲线 |
| 切会话转一圈 | 圆盘平滑转满 360°，外圈光束按层视差跟随 |
| 切换动效（5 个开关） | 外圈跟随 / 内容逐块揭示 / 亮度脉冲 / 色相扫过 / 镜头轻推，各自独立可关 |

## 二、安装

需要已安装 DeepSeek Harness（桌面版或 `dsh web`）。

```text
plugin_manager install_bundle  target=<本包目录的绝对路径>
```

安装后刷新页面，侧栏底部 **设置 → HALOFLUX** 出现即成功。

- 包名 `dsh-haloflux`，bundle 行 id `haloflux`，同时注册 `shell.overlay` 与 `settings.section`。
- 卸载：`plugin_manager remove_bundle target=dsh-haloflux`。

## 三、数据抓取档位

设置页顶部的三档开关（参数 `dataMode`）：

| 档 | 名称 | 光环上的文字与数字 | 会话读取 |
|---|---|---|---|
| 0 | 纯动画 | 全部来自原作示例词表与随机数 | 不抓词元（`pullTokens` 跳过）；亮度仍随运行/静默变化 |
| 1 | 混合 30%（默认） | 有词元时来自真实回答，数字与表头为合成 | 词元 + 工具名 + 运行状态 |
| 2 | 完全抓取 | 只显示真实数据：词元、工具名、`STEP n` / `TURN n`、tok/s、上下文；没有就留空 | 全部 |

档位只约束**画布上的文字与数字**；`H` 打开的 HUD 始终是真实会话监视器。

## 四、使用

快捷键（焦点不在输入框内时）：

| 键 | 作用 |
|---|---|
| `C` | 打开/关闭快速调参浮层 |
| `H` | 打开/关闭 HUD |
| `Esc` | 关闭浮层 |

设置页与浮层、画布共用同一份参数（`src/state.js`），任一处改动其余立刻跟随；
「保存为默认」写入 `localStorage`，跨重启保留。

### 切换动效

切换会话时依次发生（都可单独关闭）：

1. `revolveOnSwitch`：圆盘转满一圈（`revolveMs`）；
2. `revolveOuter`：外围光束按层跟随，远端慢、近端快，转起来有纵深；
3. `switchReveal`：转动过程中圆环面板逐块失效重建，旧会话的文字被新会话替换；
4. `switchFlash`：亮度在转圈中点轻微上冲后回落；
5. `switchHue`：可选的色相扫过（默认 0，不开就不换色）；
6. `switchCam`：镜头在 1 → 0.972 → 1 之间轻推一次。

2–6 由 `engine.switchFx()` 驱动，与是否转圈解耦：关掉转圈，其余效果仍然生效。

运行中的会话切到**空闲**会话时，收光会与转圈重叠（约 260ms 后开始衰减），不会亮着转完再暗；
若觉得转圈中点的亮度脉冲抢戏，把 `switchFlash` 调低或设 0。

## 五、参数

共 **109 项**，分 12 组：原作 **56 项**（`全局` 5 / `圆环` 7 / `圈内` 18 / `环外` 17 / `空间层次` 9），
本项目新增 **53 项**（`插件` 23 + `分层` 11 + `数据` 4 + `HUD` 3 + `配色` 4 + `状态` 4 + `性能` 4）：

| 参数 | 默认 | 作用 |
|---|---|---|
| `opacity` | 0.45 | 整层不透明度 |
| `blend` | 0 | 混合模式 0=screen 1=lighten 2=normal |
| `activityGain` | 1 | 活跃度对生成速率的增益 |
| `centerX` / `centerY` | -0.15 / 0 | 构图中心偏移 |
| `scale` | 0.6 | 整体缩放 |
| `hudOn` | 0 | HUD 开关 |
| `feedOn` | 1 | 事件流开关 |
| `dataMode` | 1 | 数据抓取档位 0/1/2 |
| `backdrop` | 0 | 深色底比例；0 = 纯透明发光 |
| `runLevel` | 1 | 运行态强度 |
| `idleMotion` | 0.18 | 静默态强度 |
| `voidLevel` | 0 | 无会话强度；0 = 整帧透明 |
| `attackMs` | 800 | 起势时长 |
| `releaseMs` | 2600 | 收势时长 |
| `easeCurve` | 1 | 过渡曲线 0 线性 / 1 平滑 / 2 双 S |
| `revolveOnSwitch` | 1 | 切换会话是否转满一圈 |
| `revolveMs` | 1500 | 整圈用时 |
| `camera`（原作） | 0 | 自动运镜开关；0 = 固定机位 |
| `revolveOuter` | 1 | 切换时外圈光束跟随转圈（远层 0.35 / 主层 1.0 / 近层 1.15 的视差） |
| `switchReveal` | 1 | 切换时圆环面板逐块重建，内容随转动换成新会话 |
| `switchFlash` | 0.6 | 切换窗口内的亮度脉冲强度；0 = 关 |
| `switchHue` | 0 | 切换窗口内的色相扫过强度；0 = 关（默认不换色） |
| `switchCam` | 1 | 切换时镜头轻微推拉（约 2.8% 缩放，不改相机状态） |

### 分层：文字与动画分开（v0.4.0）

有人反馈「文字和动画像一个图层，影响观看」——这指的是光环与界面文字合成在同一平面上，
缺少景深和遮挡关系。下面 7 项各自独立，任何一项关掉都回到原来的单一平面观感：

| 参数 | 默认 | 作用 |
|---|---|---|
| `fieldBlur` | 0 | 整层失焦（CSS `blur`），让光场退到文字后面；副作用是环上小字也会一起变糊 |
| `ringData` | 1 | 环带数据面板（小字、条码、迷你图）亮度；0 = 只剩纯光带，无噪点 |
| `guardOn` | 1 | 文字静区总开关：在正文区域把光削掉一层 |
| `guardStrength` | 0.4 | 正文区压制强度，0 = 不压 |
| `guardRadius` | 0.9 | 中心静区半径（× 环半径），只清中心区域 |
| `guardColW` | 0 | 按像素宽纵向清理一整列（聊天正文列）；0 = 关 |
| `plateAlpha` | 0.72 | HUD 面板底衬不透明度，越大文字越“浮”在光之上 |
| `fieldBright` | 1 | 背景层亮度（整体压暗/提亮） |
| `guardBlur` | 0 | 正文列**低通虚化**：同一帧镜像到第二画布、模糊后只铺在正文列上，主画布在同位置挖空。正文区是“同一束光的失焦版”，比压暗自然 |
| `motionQuiet` | 0 | 静读：整体减速（粒子速度降到 40%），运动不再抢注意力 |
| `readFade` | 0 | 阅读时自动降亮：滚动/输入时降到 55%，停手 2.5s 恢复 |

### 预设

控制台「预设」一行：`A` / `B` / `MINE`（原作定稿）/ `QUIET`（阅读：整体压暗+失焦+减粒子）/
`EDGE`（构图：把环收小上移，正文落在环心暗区）/ `READ`（EDGE + 低通正文列 + 减弱运动 + 自动降亮）。

`EDGE` 是最“物理”的分层方案：不靠压暗和遮罩，而让光环和正文在画面上根本不重叠。

### 数据可视化（`数据` 组，各带开关）

| 参数 | 默认 | 作用 |
|---|---|---|
| `ctxArc` | 1 | 上下文占用 = 环内一圈的弧长；>82% 转红 |
| `stepTicks` | 1 | 步骤刻度：每完成一步亮一格（上限 12） |
| `toolBeam` | 1 | 工具调用从环上射出一条带工具名的光带 |
| `errFx` | 0 | 失败提示：**红蓝故障感**——整帧抖动 + 水平撕裂 + 红/蓝通道色散，持续约 0.9s |
| `glitchAmt` | 0.6 | 故障感强度（抖动幅度、撕裂位移、色散偏移一起缩放）；0 = 退化为干净输出 |

### HUD 布局与配色

| 参数 | 默认 | 作用 |
|---|---|---|
| `hudScale` | 1 | HUD 缩放 0.8–1.6（四角锚点不动） |
| `hudInset` | 12 | HUD 距边 px |
| `hudTop` | 6 | 顶部数据条的下移量 px |
| `tintFollow` | 0 | 跟随 DSH 主题色（读 `--dsw-alias-brand-primary` 取色相） |

控制台里还有：**参数搜索框**（名称或 key，如 `guard`、`色`）、**配色色块**（冰蓝/青绿/紫/品红/琥珀/红/原色 一键切换）、
以及每个分组的折叠。设置页（Settings → HALOFLUX）列出同一批参数。

### 状态语义（`状态` 组，各带开关）

光环能表达「AI 正在做什么」，不只是「亮不亮」：

| 参数 | 默认 | 作用 |
|---|---|---|
| `phaseRing` | 1 | 相位环（R×0.86）：用**运动签名**区分四种状态——思考=缓慢呼吸弧、流式输出=短弧顺时针跑、调工具=快速虚线扫、等待=不画 |
| `errPin` | 1 | 失败钉：工具失败时在那个工具的角度上留一个常亮 ×，不再整帧红闪 |
| `tpsRibbon` | 1 | 流速带（环外顶部）：长度取**相对本会话中位数**，慢模型不会被永久显示成「没在动」 |
| `thinkPulse` | 1 | 思考态脉动开关 |

`errFx`（红蓝故障感）现在**默认关闭**：工具失败是 agent 循环里最高频的事件，用最高级的打断通道去报它，
等于让打断通道失去意义——`errPin` 是替代品。想看「出事了」的强提示，把 `errFx` 打开，
用 `glitchAmt` 调强度（0.3 轻微闪烁 / 0.6 默认 / 1.0 明显撕裂）。

### 性能（`性能` 组，各带开关）

| 参数 | 默认 | 作用 |
|---|---|---|
| `glowBlurSmall` | 1 | 辉光在小缓冲上模糊：原先每帧对全屏（约 520 万像素）做一次 `blur(6px)`，改为在 1/GS 尺寸的缓冲上模糊再放大，视觉等价、像素量降到 1/GS² |
| `adaptQuality` | 1 | 低帧率自动降质：连续 1.2s 低于 42fps 降一档（粒子/飞线数量 ×0.75 → ×0.5），回到 55fps 以上再逐档恢复 |
| `idleSleepMs` | 0 | 无交互休眠：超过该毫秒数没有任何鼠标/滚轮/按键，整个渲染循环停摆；一动即恢复。0 = 不休眠 |
| `hudFadeMs` | 0 | HUD 更新节流：live 数据刷新最快间隔，0 = 用 adapter 自带的 200ms 合并 |

### 关于「成本与亮度无关」

空闲会话时画面停在 `idleMotion`（默认 0.18）亮度，但渲染成本与亮度完全无关——
用户看到 8% 的光，仍要付 100% 的帧成本。`idleSleepMs` + `adaptQuality` 就是针对这一点的两个开关。

实现方式：整帧先合成到离屏缓冲，输出前用 `destination-out` 在文字区削一层光。
canvas 是叠在界面之上的混合层，削掉的是**光**而不是文字，所以下层文字只会更清楚。
若觉得环内出现可见“圆洞硬边”，把 `guardRadius` 调小或 `guardStrength` 调低即可。

## 六、数据来源（只读）

全部来自 Client 已有的会话服务，不新增 Host 事件、不写会话日志：

- `ctx.sessions.binding(sessionId)` → `eventSource`
  - `transient` 条目 = 流式词元（`assistant/live-chunk` 的 `text-delta`）
  - 持久事件 = `turn/step`、`user/message`、`assistant/message`（含 `usage`）、`tool/call`、`tool/result`
- `useSessions` 找当前打开的会话，`useSessionStatus` 给「运行中/空闲」
- tok/s、上下文占用、工具状态由 `src/live.js` 派生

任何宿主调用都包在 `try/catch` 里；绑定消失、切会话、销毁都会释放订阅与定时器。

## 七、源码结构与构建

```text
dsh-haloflux/
├─ package.json          # bundle 清单 + dsh.client
├─ cordis.patch.yml      # 插入 haloflux 行
├─ index.js              # Host 半边（无行为，占位使 bundle 可激活）
├─ client.js             # ★ 构建产物（浏览器加载的唯一文件，勿手改）
├─ build.mjs             # 拼接 src/*.js → client.js
├─ src/
│  ├─ engine.js          # Canvas 引擎（渲染、状态机、数据档位）
│  ├─ state.js           # 参数 store（三个 React 根共用）
│  ├─ live.js            # 会话实时数据适配
│  ├─ hud.js             # HUD + 参数控件
│  ├─ settings.js        # 设置 → HALOFLUX 页面
│  └─ mount.js           # 槽注册、组件装配、快捷键
├─ locale/{en,zh}.json   # 插件管理器展示文案
├─ icon.svg              # 图标
├─ tools/                # 无头自测脚本
├─ LICENSE               # PolyForm Noncommercial 1.0.0
└─ NOTICE                # 署名与再分发要求
```

构建：

```bash
node build.mjs && node --check client.js
```

改完 `src/` 后需要重新 `install_bundle`（或重启 Host）并刷新页面。

## 八、测试

四个脚本都不需要浏览器，也不需要包外文件：

```bash
node tools/engine-smoke.cjs     # 无头假 DOM + 记录型 2D context（含三档数据断言）
node tools/live-selftest.mjs    # 假 binding/eventSource：词元队列、tok/s、订阅生命周期
node tools/client-smoke.cjs     # 假 module loader：装配、双槽注册、参数 store
node tools/session-switch.cjs   # 切会话回归：运行态不被清、内容换到新会话、旧订阅释放
```

`tools/_engine-probe.mjs` 是参数表的静态检查（项数、分组、重复键、预设）。

## 九、兼容性

- 实测于 DeepSeek Harness **0.2.1-rc.2**（Windows 桌面版）。
- 依赖宿主内部约定：`shell.overlay` / `settings.section` 槽位、槽位标准 props
  `useSessions` / `useSessionStatus`、`sessions.binding()` 的 `eventSource`。
  这些接口跨大版本可能变化；升级 DSH 后若出现白屏，先在这里排查。

## 十、许可与致谢

- 原作 **HALOFLUX**：Copyright (c) 2026 Ryder191（RYDER CODE / Ms MAIKEBAIs CAT），
  <https://github.com/Ryder191/haloflux>，PolyForm Noncommercial License 1.0.0。
- 本移植：同样**仅限非商业使用**，可在保留 `LICENSE` 与 `NOTICE` 的前提下自由分发与修改。
- 再分发、二次修改请保留 `NOTICE` 中的 Required Notice 行。
- 上游已在 `Community` / `社区作品` 一节收录本项目（上游 commit `ff9a4a6`）：
  <https://github.com/Ryder191/haloflux#community>。上游仓库只保留原作代码，插件由本项目独立维护。
