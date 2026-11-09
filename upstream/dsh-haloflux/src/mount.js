/**
 * HALOFLUX for DSH — Client assembly.
 *
 */
const HalofluxPlugin = (() => {
  const NS = 'haloflux';
  const STORAGE_KEY = 'dsh-haloflux:params:v2';
  const PARAMS_KEY = 'dsh-haloflux:params:default:v2';
  /** a Session switch can report "no main session" for a frame or two: never collapse inside it */
  const SWITCH_GRACE_MS = 1200;
  /** a stale "idle" right after a switch is held off only briefly, so a running -> idle
      switch starts dimming WITH the turn instead of spinning at full brightness first */
  const SWITCH_SETTLE_MS = 260;

  const DICT = {
    en: {
      'ui.console': 'CONTROL',
      'ui.consoleTitle': 'HALOFLUX console',
      'ui.presets': 'Presets',
      'ui.export': 'Export',
      'ui.import': 'Import',
      'ui.saveDefault': 'Save as default',
      'ui.reset': 'Reset',
      'ui.close': 'Close',
      'ui.hint': 'C console · H hud · Esc close',
      'ui.idle': 'IDLE',
      'ui.running': 'RUNNING',
      'ui.tokens': 'TOKENS',
      'ui.rate': 'TOK/S',
      'ui.context': 'CONTEXT',
      'ui.steps': 'STEPS',
      'ui.tools': 'TOOLS',
      'ui.feed': 'EVENT FEED',
      'ui.tokensFeed': 'TOKEN STREAM',
      'ui.dispatch': 'TOOL DISPATCH',
      'ui.empty': 'waiting for the next call',
      'ui.copied': 'copied',
      'ui.camera': 'CAMERA',
      'ui.cameraHint': 'Auto camera: occasional push-in on a detail. Off keeps one steady framing.',
      'ui.sectionLabel': 'HALOFLUX',
      'ui.settingsHeading': 'HALOFLUX live ring',
      'ui.settingsDesc': 'A frame-wide light-ring background driven by the current session: ring rotation, token capture and beams follow the running model call and stop when it settles.',
      'ui.dataTitle': 'Data source',
      'ui.dataMode': 'Data capture',
      'ui.mode0': 'Animation only',
      'ui.mode1': 'Mixed 30%',
      'ui.mode2': 'Full capture',
      'ui.mode0Hint': 'Level 0 - pure animation: the ring shows the original HALOFLUX sample words and numbers and never touches the session text stream (pullTokens is skipped). Brightness still follows the running/idle state.',
      'ui.mode1Hint': 'Level 1 - mixed (the current look): ring text comes from the streaming answer whenever tokens are available, while numbers and headers stay synthetic.',
      'ui.mode2Hint': 'Level 2 - full capture: every word and number comes from this session (streaming tokens, tool names, step/turn, tok/s, context). A panel stays blank when there is nothing real to show.',
      'ui.configTitle': 'Presets & config',
      'ui.paramsTitle': 'Parameters',
      'ui.saved': 'saved',
      'ui.failed': 'failed',
      'ui.apply': 'Apply',
      'ui.importHint': 'Paste JSON, then Enter to apply',
    },
    zh: {
      'ui.console': '控制台',
      'ui.consoleTitle': 'HALOFLUX 控制台',
      'ui.presets': '预设',
      'ui.export': '导出',
      'ui.import': '导入',
      'ui.saveDefault': '保存为默认',
      'ui.reset': '重置',
      'ui.close': '关闭',
      'ui.hint': 'C 控制台 · H 面板 · Esc 关闭',
      'ui.idle': '空闲',
      'ui.running': '运行中',
      'ui.tokens': '词元',
      'ui.rate': '词元/秒',
      'ui.context': '上下文',
      'ui.steps': '步数',
      'ui.tools': '工具',
      'ui.feed': '事件流',
      'ui.tokensFeed': '词元流',
      'ui.dispatch': '工具调度',
      'ui.empty': '等待下一次调用',
      'ui.copied': '已复制',
      'ui.camera': '运镜',
      'ui.cameraHint': '自动运镜：不定时推近画面看局部。关闭后保持固定机位。',
      'ui.sectionLabel': 'HALOFLUX',
      'ui.settingsHeading': 'HALOFLUX 实时光环',
      'ui.settingsDesc': '由当前会话驱动的全帧光环背景：圆盘转动、词元抓取与光束跟随模型调用，调用结束即同步停止。',
      'ui.dataTitle': '数据来源',
      'ui.dataMode': '数据抓取档位',
      'ui.mode0': '纯动画',
      'ui.mode1': '混合 30%',
      'ui.mode2': '完全抓取',
      'ui.mode0Hint': '0 档 · 纯动画：环上的词与数字全部来自原作示例，不抓取任何会话文字（不调用词元流）；画面亮度仍随「运行/静默」变化。',
      'ui.mode1Hint': '1 档 · 混合（现在的样子）：有词元时环上的文字来自正在流出的真实回答，数字与表头仍为合成数据。',
      'ui.mode2Hint': '2 档 · 完全抓取：每个词、每个数字都来自当前会话（流式词元、工具名、step/turn、tok/s、上下文）；没有真实数据时面板留空。',
      'ui.configTitle': '预设与配置',
      'ui.paramsTitle': '参数',
      'ui.saved': '已保存',
      'ui.failed': '失败',
      'ui.apply': '应用',
      'ui.importHint': '粘贴 JSON 后按 Enter 应用',
    },
  };

  const BASE_CSS = `
.hfx-root{position:absolute;inset:0;pointer-events:none;z-index:0;isolation:auto}
.hfx-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}
.hfx-hud{position:absolute;inset:0;pointer-events:none;font:11px/1.45 "JetBrains Mono",Consolas,ui-monospace,monospace;
  letter-spacing:.06em;color:var(--dsw-alias-label-secondary,#8b93a7);user-select:none}
.hfx-panel{pointer-events:auto;background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b0d10) 82%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,#2a2f3a) 70%,transparent);
  border-radius:10px;backdrop-filter:blur(10px)}
.hfx-dim{color:var(--dsw-alias-label-tertiary,#6a7285)}
.hfx-num{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e6ecff)}
.hfx-pink{color:#ff9ecb}.hfx-cyan{color:#7fd8ff}
/* HUD scale: the individual 'scale' property keeps the corner anchors (transform is used for centring) */
.hfx-stats{transform-origin:top center;scale:var(--hfx-hud-scale,1)}
.hfx-feed{transform-origin:bottom left;scale:var(--hfx-hud-scale,1)}
.hfx-tools{transform-origin:bottom right;scale:var(--hfx-hud-scale,1)}
.hfx-console{transform-origin:top right;scale:var(--hfx-hud-scale,1)}
`;

  /* ---------- params live in the shared store (src/state.js) ---------- */

  /** The DSH brand colour as a hue, for "follow the theme colour" (null = unavailable). */
  function themeHue() {
    try {
      if (typeof getComputedStyle !== 'function') return null;
      const el = document.documentElement;
      if (!el) return null;
      const raw = String(getComputedStyle(el).getPropertyValue('--dsw-alias-brand-primary') || '').trim();
      let r = 0, g = 0, b = 0, m;
      if ((m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw))) {
        let hx = m[1];
        if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
        r = parseInt(hx.slice(0, 2), 16) / 255;
        g = parseInt(hx.slice(2, 4), 16) / 255;
        b = parseInt(hx.slice(4, 6), 16) / 255;
      } else if ((m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(raw))) {
        r = Number(m[1]) / 255; g = Number(m[2]) / 255; b = Number(m[3]) / 255;
      } else return null;
      if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return null;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d < 0.02) return null;
      let hue;
      if (mx === r) hue = ((g - b) / d) % 6;
      else if (mx === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      return ((hue * 60) + 360) % 360;
    } catch { return null; }
  }

  function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  /* ---------- locale ---------- */

  function makeT(locale) {
    function activeId() {
      try {
        const snap = locale && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined;
        const id = snap && (snap.locale || snap.id || snap.current);
        if (typeof id === 'string' && id) return id;
      } catch { /* ignore */ }
      try {
        const lang = (navigator.language || 'en').toLowerCase();
        if (lang.startsWith('zh')) return 'zh';
      } catch { /* ignore */ }
      return 'en';
    }
    return function t(key) {
      const id = activeId();
      const dict = DICT[id] || DICT[id.split('-')[0]] || DICT.en;
      return dict[key] || DICT.en[key] || key;
    };
  }

  /* ---------- stable selectors ---------- */

  const selectMainSessionId = (state) => {
    if (!state || !state.byId) return undefined;
    const rows = Object.values(state.byId);
    for (const row of rows) if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return row.id;
    return rows.length === 1 && rows[0] ? rows[0].id : undefined;
  };

  /** A blank Session is the "new session" hero page: the decoration fades out there. */
  const selectMainBlank = (state) => {
    if (!state || !state.byId) return false;
    const id = selectMainSessionId(state);
    const row = id === undefined ? undefined : state.byId[id];
    return !!(row && row.blank === true);
  };

  /* ---------- the layer ---------- */

  function HalofluxLayer(props) {
    const { useSessions, useSessionStatus } = props;
    const h = React.createElement;

    const sessionsSvc = props.__sessions || undefined;
    const t = props.__t;

    const sessionId = useSessions(selectMainSessionId);
    const blank = useSessions(selectMainBlank);
    const stateSelector = React.useCallback((map) => {
      const hit = map && map.get ? map.get(sessionId) : undefined;
      return hit ? hit.running === true : undefined;
    }, [sessionId]);
    const running = useSessionStatus(stateSelector);

    // "present" = a real conversation is on screen. The blank New Session hero page
    // (and the no-session page) both mean absent, so the halo fades out there.
    const present = sessionId !== undefined && !blank;

    const hostRef = React.useRef(null);
    const canvasRef = React.useRef(null);
    const canvas2Ref = React.useRef(null);
    const engineRef = React.useRef(null);
    const liveRef = React.useRef(null);
    const sessionRef = React.useRef(sessionId);
    sessionRef.current = sessionId;
    const prevSessionRef = React.useRef(sessionId);
    /** when the current switch started: keeps a fresh Session's stale "not running" out */
    const switchAtRef = React.useRef(0);

    const params = HalofluxState.useParams();
    const [open, setOpen] = React.useState(false);
    const [stats, setStats] = React.useState(null);
    const [liveTick, setLiveTick] = React.useState(0);
    const [reading, setReading] = React.useState(false);
    /** last time a HUD tick was pushed (hudFadeMs throttling) */
    const lastHudPush = React.useRef(0);

    const patchParams = React.useCallback((partial) => { HalofluxState.set(partial); }, []);

    /* live source: created once, bound to the active session */
    React.useEffect(() => {
      const live = createHalofluxLive({
        getSessionId: () => sessionRef.current,
        bindingOf: (id) => {
          try {
            const svc = sessionsSvc || (props.__ctx && props.__ctx.get && props.__ctx.get('sessions'));
            return svc && typeof svc.binding === 'function' ? svc.binding(id) : undefined;
          } catch { return undefined; }
        },
      });
      liveRef.current = live;
      // presence must be right before the first frame, not one effect later
      try { live.sessionPresent = sessionRef.current !== undefined; } catch { /* readonly */ }
      const off = live.subscribe(() => {
        // hudFadeMs throttles HUD re-renders independently of the engine's frame rate
        const gap = Number(params.hudFadeMs) || 0;
        if (gap > 0) {
          const t = Date.now();
          if (t - lastHudPush.current < gap) return;
          lastHudPush.current = t;
        }
        setLiveTick((n) => (n + 1) % 1000000);
      });
      try { if (typeof window !== 'undefined' && window.__HFX_DEBUG) window.__hfx = { live: live, engine: () => engineRef.current }; } catch { /* debug hook */ }
      return () => { off(); live.dispose(); liveRef.current = null; };
    }, []);

    /* live session switch. A switch can report "no main session" for a frame or
       two; skip those gaps so the previous feed (and its level) survives until the
       new Session's binding is actually published. */
    React.useEffect(() => {
      if (sessionId === undefined) return;
      if (liveRef.current) liveRef.current.setSession(sessionId);
    }, [sessionId]);

    /* presence: running conversation vs. New Session hero / no Session at all.
       Applied only after a short grace, otherwise the whole frame collapses to
       voidLevel in the middle of a Session switch. */
    React.useEffect(() => {
      const live = liveRef.current;
      if (!live) return undefined;
      if (present) { live.sessionPresent = true; return undefined; }
      const timer = setTimeout(() => {
        live.sessionPresent = false;
        live.setRunning(false);
        live.setSession(undefined);
      }, SWITCH_GRACE_MS);
      return () => { clearTimeout(timer); };
    }, [present]);

    /* switching to a different real conversation spins the ring exactly one turn.
       The last real id is remembered across a transient undefined gap, so a
       S1 -> (gap) -> S2 switch still revolves instead of resetting silently. */
    React.useEffect(() => {
      if (sessionId === undefined) return;
      const previous = prevSessionRef.current;
      prevSessionRef.current = sessionId;
      if (previous === undefined || previous === sessionId) return;
      switchAtRef.current = Date.now();
      const engine = engineRef.current;
      // the non-revolve switch effects run even when the ring spin is disabled
      if (engine && typeof engine.switchFx === 'function') engine.switchFx();
      if (!(params.revolveOnSwitch >= 0.5)) return;
      if (engine && typeof engine.revolve === 'function') engine.revolve(1);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    /* author's default on first run */
    React.useEffect(() => {
      if (prefersReducedMotion() && params.idleMotion > 0.05) patchParams({ idleMotion: 0.05 });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* engine lifecycle */
    React.useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !liveRef.current) return undefined;
      const engine = HalofluxEngine.create({
        canvas,
        canvas2: canvas2Ref.current,
        live: liveRef.current,
        params,
        onStats: setStats,
      });
      engineRef.current = engine;
      engine.start();
      return () => { engineRef.current = null; engine.dispose(); };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* params -> engine */
    React.useEffect(() => {
      const engine = engineRef.current;
      if (engine) engine.setParams(params);
    }, [params]);

    /* running state -> live (a hero/no-session page is never "running").
       Absence is applied by the presence effect above, with its grace period. */
    React.useEffect(() => {
      const live = liveRef.current;
      if (!live) return undefined;
      if (!present) return undefined;
      if (typeof running !== 'boolean') return undefined;
      if (running === false) {
        // A freshly opened Session may project running=false for a beat before its
        // own status arrives; hold it off briefly, then let the release overlap the
        // turn so the light drains while the ring is still moving.
        const left = SWITCH_SETTLE_MS - (Date.now() - switchAtRef.current);
        if (left > 0) {
          const timer = setTimeout(() => { live.setRunning(false); }, left);
          return () => { clearTimeout(timer); };
        }
      }
      live.setRunning(running);
      return undefined;
    }, [running, present]);

    /* container resize */
    React.useEffect(() => {
      const host = hostRef.current;
      if (!host || typeof ResizeObserver === 'undefined') return undefined;
      let raf = 0;
      const ro = new ResizeObserver(() => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (engineRef.current) engineRef.current.resize();
        });
      });
      ro.observe(document.documentElement);
      return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
    }, []);

    /* visibility: stop burning frames on a hidden tab */
    React.useEffect(() => {
      const onVis = () => {
        const engine = engineRef.current;
        if (!engine) return;
        if (document.hidden) engine.stop(); else engine.start();
      };
      document.addEventListener('visibilitychange', onVis);
      return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    /* keyboard: C console, H hud */
    React.useEffect(() => {
      const onKey = (event) => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
        const target = event.target;
        const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)) return;
        const key = String(event.key || '').toLowerCase();
        if (key === 'c') { setOpen((v) => !v); }
        else if (key === 'h') { patchParams({ hudOn: params.hudOn ? 0 : 1 }); }
        else if (key === 'escape') { setOpen(false); }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [params.hudOn, patchParams]);

    /* idleSleepMs: after N ms without interaction the engine parks entirely.
       One shared interaction clock drives both this and readFade. */
    React.useEffect(() => {
      const sleepOn = Number(params.idleSleepMs) > 0;
      const fadeOn = Number(params.readFade) >= 0.5;
      if (!sleepOn && !fadeOn) {
        setReading(false);
        if (engineRef.current && typeof engineRef.current.setIdle === 'function') engineRef.current.setIdle(0);
        return undefined;
      }
      let lastAt = Date.now();
      let timer = 0;
      const bump = () => {
        lastAt = Date.now();
        if (fadeOn) {
          setReading(true);
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { timer = 0; setReading(false); }, 2500);
        }
      };
      const passive = { passive: true };
      const capture = { passive: true, capture: true };
      window.addEventListener('wheel', bump, passive);
      window.addEventListener('scroll', bump, capture);
      window.addEventListener('keydown', bump, passive);
      window.addEventListener('mousedown', bump, passive);
      window.addEventListener('pointermove', bump, passive);
      const poll = setInterval(() => {
        const engine = engineRef.current;
        if (engine && typeof engine.setIdle === 'function') engine.setIdle(Date.now() - lastAt);
      }, 1000);
      return () => {
        if (timer) clearTimeout(timer);
        clearInterval(poll);
        window.removeEventListener('wheel', bump, passive);
        window.removeEventListener('scroll', bump, capture);
        window.removeEventListener('keydown', bump, passive);
        window.removeEventListener('mousedown', bump, passive);
        window.removeEventListener('pointermove', bump, passive);
      };
    }, [params.readFade, params.idleSleepMs]);

    const blendMode = ['screen', 'lighten', 'normal'][params.blend | 0] || 'screen';
    // readFade: while the user scrolls/types the field recedes, then returns on idle
    const rawFade = Number(params.readFade);
    const readOn = isFinite(rawFade) && rawFade >= 0.5;
    const fadeK = readOn && reading ? 0.55 : 1;
    const opacity = Math.max(0, Math.min(1, Number(params.opacity) * fadeK));
    // layer separation: the field can be pushed out of focus (a depth cue that puts it
    // behind the text) and the HUD panes can be more or less opaque over the light
    const rawBlur = Number(params.fieldBlur);
    const blurPx = Math.max(0, Math.min(3, isFinite(rawBlur) ? rawBlur : 0));
    const rawPlate = Number(params.plateAlpha);
    const platePct = Math.round(Math.max(0, Math.min(1, isFinite(rawPlate) ? rawPlate : 0.72)) * 100);
    // theme colour: sepia() flattens the light to one hue, hue-rotate() picks the hue,
    // saturate() decides how strong it reads. Applied to the canvas only, so the UI
    // text and every HUD element keep their own colours.
    const rawTint = Number(params.tintAmount);
    const tintAmt = Math.max(0, Math.min(1, isFinite(rawTint) ? rawTint : 0));
    const rawHue = Number(params.tintHue);
    const followTint = Number(params.tintFollow) >= 0.5;
    const themeH = followTint ? themeHue() : null;
    const tintHue = themeH != null ? themeH : ((isFinite(rawHue) ? rawHue : 210) % 360 + 360) % 360;
    const rawSat = Number(params.tintSat);
    const tintSat = Math.max(0.2, Math.min(3, isFinite(rawSat) ? rawSat : 1.6));
    const filters = [];
    const rawBright = Number(params.fieldBright);
    const brightK = Math.max(0.3, Math.min(1.3, isFinite(rawBright) ? rawBright : 1));
    if (Math.abs(brightK - 1) > 0.005) filters.push('brightness(' + brightK.toFixed(2) + ')');
    if (blurPx > 0.05) filters.push('blur(' + blurPx.toFixed(2) + 'px)');
    if (tintAmt > 0.01) {
      filters.push('sepia(' + tintAmt.toFixed(2) + ')',
        'hue-rotate(' + tintHue.toFixed(0) + 'deg)',
        'saturate(' + tintSat.toFixed(2) + ')');
    }
    const hudVisible = params.hudOn >= 0.5 && params.opacity > 0.02;

    // HUD layout: base font scale + edge offsets, all live from the console
    const rawScale = Number(params.hudScale);
    const hudScale = Math.max(0.8, Math.min(1.6, isFinite(rawScale) ? rawScale : 1));
    const rawInset = Number(params.hudInset);
    const hudInset = Math.max(4, Math.min(48, isFinite(rawInset) ? rawInset : 12));
    const rawTop = Number(params.hudTop);
    const hudTop = Math.max(0, Math.min(80, isFinite(rawTop) ? rawTop : 6));
    const rootVars = {
      pointerEvents: 'none',
      '--hfx-plate': platePct + '%',
      '--hfx-hud-scale': String(hudScale),
      '--hfx-hud-inset': hudInset + 'px',
      '--hfx-hud-top': hudTop + 'px',
    };

    // low-pass reading column: the SAME frame is mirrored onto a second canvas, blurred and
    // masked to the column, while the main canvas gets a matching hole. Sharp outside,
    // defocused inside — depth instead of a punched-out hole, and no brightness loss.
    const rawCol = Number(params.guardColW);
    const colW = Math.max(0, Math.min(1600, isFinite(rawCol) ? rawCol : 0));
    const rawGuardBlur = Number(params.guardBlur);
    const guardBlur = Math.max(0, Math.min(24, isFinite(rawGuardBlur) ? rawGuardBlur : 0));
    const lowOn = guardBlur > 0.3 && colW > 80;
    const feather = Math.min(180, Math.max(24, colW * 0.22));
    const xA = 'calc(50% - ' + (colW / 2 + feather) + 'px)';
    const xB = 'calc(50% - ' + colW / 2 + 'px)';
    const xC = 'calc(50% + ' + colW / 2 + 'px)';
    const xD = 'calc(50% + ' + (colW / 2 + feather) + 'px)';
    const maskBand = lowOn
      ? 'linear-gradient(to right,transparent 0,transparent ' + xA + ',#000 ' + xB + ',#000 ' + xC + ',transparent ' + xD + ',transparent 100%)'
      : undefined;
    const maskHole = lowOn
      ? 'linear-gradient(to right,#000 0,#000 ' + xA + ',transparent ' + xB + ',transparent ' + xC + ',#000 ' + xD + ',#000 100%)'
      : undefined;
    const lowFilter = (guardBlur > 0.3 ? 'blur(' + guardBlur.toFixed(1) + 'px) ' : '')
      + (filters.length ? filters.join(' ') : '');

    const live = liveRef.current;
    /** stable defaults object: the slider list memoises on reference identity */
    const baseDefaults = React.useMemo(() => HalofluxState.baseParams(), []);

    const hudProps = {
      params, setParams: patchParams, live, t, stats,
      open, setOpen,
      defaults: baseDefaults,
      presets: HalofluxEngine.PRESETS,
      applyPreset: (name) => {
        const preset = HalofluxEngine.PRESETS[name];
        if (preset) patchParams({ ...preset });
      },
      exportJson: () => HalofluxState.exportJson(),
      importJson: (text) => HalofluxState.importJson(text),
      saveDefault: () => HalofluxState.saveDefault(),
      resetDefault: () => HalofluxState.resetDefault(),
    };

    return h('div', { className: 'hfx-root', ref: hostRef, 'aria-hidden': open ? undefined : true, style: rootVars },
      h('style', null, BASE_CSS),
      h('canvas', {
        ref: canvasRef,
        className: 'hfx-canvas',
        style: {
          opacity,
          transition: 'opacity .35s ease',
          mixBlendMode: blendMode === 'normal' ? undefined : blendMode,
          filter: filters.length ? filters.join(' ') : undefined,
          maskImage: maskHole,
          WebkitMaskImage: maskHole,
        },
      }),
      h('canvas', {
        ref: canvas2Ref,
        className: 'hfx-canvas',
        'aria-hidden': true,
        style: {
          opacity,
          transition: 'opacity .35s ease',
          display: lowOn ? undefined : 'none',
          mixBlendMode: blendMode === 'normal' ? undefined : blendMode,
          filter: lowFilter || undefined,
          maskImage: maskBand,
          WebkitMaskImage: maskBand,
        },
      }),
      hudVisible && HalofluxHud && live ? h(HalofluxHud.Stats, { ...hudProps, liveTick }) : null,
      hudVisible && HalofluxHud && live && Number(params.feedOn) >= 0.5
        ? h(HalofluxHud.Feed, { ...hudProps, liveTick }) : null,
      hudVisible && HalofluxHud && live ? h(HalofluxHud.Tools, { ...hudProps, liveTick }) : null,
      HalofluxHud && live ? h(HalofluxHud.Console, { ...hudProps, liveTick }) : null,
    );
  }

  /**
   * Root-scoped slot entries cannot read the plugin's own context from props,
   * so the registration closes over it here.
   */
  function makeLayer(ctx, t) {
    return function HalofluxLayerBound(props) {
      return HalofluxLayer({ ...props, __ctx: ctx, __t: t, __sessions: ctx.get('sessions') });
    };
  }

  /**
   * The settings page lives in the Settings panel's own React tree, so it only
   * receives the locale closure; parameters travel through HalofluxState.
   */
  function makeSettingsPage(t) {
    return function HalofluxSettingsPage() {
      return React.createElement(HalofluxSettings.SettingsPage, { __t: t });
    };
  }

  return {
    inject: ['slots', 'sessions'],
    apply(ctx) {
      let t = makeT(undefined);
      try {
        const locale = ctx.get('locale');
        if (locale) {
          try { locale.register(NS, 'en', DICT.en); } catch { /* already registered */ }
          try { locale.register(NS, 'zh', DICT.zh); } catch { /* already registered */ }
          t = makeT(locale);
        }
      } catch { /* locale absent: fall back to navigator */ }

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'haloflux',
        order: -10,
        label: () => t('ui.consoleTitle'),
      }, makeLayer(ctx, t)));

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'haloflux',
        order: 50,
        label: () => t('ui.sectionLabel'),
      }, makeSettingsPage(t)));
    },
  };
})();