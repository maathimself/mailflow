import { GTD_CHIP_BG, GTD_COLORS } from './gtd.js';

export function resolveToastAppearance(notification = {}) {
  if (notification.type === 'error') {
    return {
      iconColor: 'var(--red)',
      iconBackground: 'rgba(248,113,113,0.15)',
      bodyColor: 'var(--text-tertiary)',
    };
  }

  const state = notification.gtdState;
  if (GTD_COLORS[state] && GTD_CHIP_BG[state]) {
    return {
      iconColor: GTD_COLORS[state],
      iconBackground: GTD_CHIP_BG[state],
      bodyColor: GTD_COLORS[state],
    };
  }

  return {
    iconColor: 'var(--accent)',
    iconBackground: 'var(--accent-dim)',
    bodyColor: 'var(--text-tertiary)',
  };
}
