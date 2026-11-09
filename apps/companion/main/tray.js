/**
 * System tray for the HALOFLUX companion.
 *
 * Menu: show/hide, window mode switch, click-through toggle, opacity presets,
 * quit. The icon is embedded as a base64 PNG so the app has no asset/build step
 * and no filesystem dependency beyond this module.
 */

import { Menu, Tray, nativeImage } from 'electron';

const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABb0lEQVR42u2XzUrDQBDH8wQepEcpFjwIASuIICIFCd77OD5TH6LQHrwIESIFQSkUBMFRvHuZ8uuSS9lk82HYFbIwsOzO/P/zsTvZRFE//tM4ODzKhnPRkwfR00fRODXCnDX20OmEGILxs+jVWnTyIZp8id79GGHOGnvooPtnjhwvDOjNu2jyLXq9Eb14ET3LROMnI8xZYw8ddLHBtnXUl68mSqKDbLQ00dmEPXTQxQbbxtnAEKDbT9HzVTmxzRFssAUDrNppx3sASG9V4n3BFgywKpcDQ+pHComiKXkuYIAFZqVSkC4OEakrSvvgfvZmk6JygAWmsxR59JxkDlNVYpcjYIHpzAKNBG+5Trboc4Jp9qs2KXIALDDBhqM0/TQU7nRdcpcTYIJdWgZaKl3NdvLbOgAm2HAUOkBf58SW1b+pA2DusNOQHfBeAu+H0Ps19N6IvLfiID5G3j/HQTxIgniSeX+UBvMsD+LHpB9dji2fJ7HZJolC5AAAAABJRU5ErkJggg==';

function modeMenu(state, actions) {
  return ['window', 'overlay', 'compact'].map((mode) => ({
    label: { window: '窗口模式', overlay: '悬浮模式', compact: '紧凑模式' }[mode],
    type: 'radio',
    checked: state.mode === mode,
    click: () => actions.setMode(mode),
  }));
}

function opacityMenu(state, actions) {
  return [1, 0.9, 0.75, 0.5].map((value) => ({
    label: `${Math.round(value * 100)}%`,
    type: 'radio',
    checked: Math.abs((state.opacity ?? 1) - value) < 0.001,
    enabled: state.mode === 'overlay',
    click: () => actions.setOpacity(value),
  }));
}

export function trayMenuTemplate(state, actions) {
  return [
    {
      label: state.visible ? '隐藏窗口' : '显示窗口',
      click: () => actions.toggleVisibility(),
    },
    { type: 'separator' },
    { label: '窗口模式', submenu: modeMenu(state, actions) },
    {
      label: '点击穿透（Ctrl+Alt+H）',
      type: 'checkbox',
      checked: Boolean(state.clickThrough),
      enabled: state.mode === 'overlay',
      click: () => actions.toggleClickThrough(),
    },
    { label: '不透明度', submenu: opacityMenu(state, actions) },
    { type: 'separator' },
    {
      label: state.bridgeUrl ? `Bridge: ${state.bridgeUrl}` : 'Bridge: 未配置',
      enabled: false,
    },
    {
      label: state.demo ? '示例数据（simulated）' : '实时数据',
      enabled: false,
    },
    { type: 'separator' },
    { label: '退出 HALOFLUX Companion', click: () => actions.quit() },
  ];
}

export function createTrayController({ actions }) {
  const image = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  const tray = new Tray(image);
  tray.setToolTip('HALOFLUX Companion');
  tray.on('click', () => actions.toggleVisibility());

  let lastState = null;
  let destroyed = false;
  function update(state) {
    if (destroyed) return;
    lastState = state;
    try {
      tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(state, actions)));
      const label = `HALOFLUX Companion — ${state.mode}${state.demo ? ' (demo)' : ''}`;
      tray.setToolTip(label);
    } catch (error) {
      // The tray can be destroyed while a final window event is still queued.
      console.error('[companion] tray update failed:', error && error.message ? error.message : error);
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    try {
      tray.destroy();
    } catch {
      /* already destroyed */
    }
  }

  return {
    tray,
    update,
    destroy,
    get state() {
      return lastState;
    },
  };
}
