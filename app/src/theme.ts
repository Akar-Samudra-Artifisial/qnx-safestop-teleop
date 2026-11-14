// Design tokens: dark, high-contrast operator UI.
// Colour goes on state (mode, deadline, plant), not on chrome.
import type { Mode } from './protocol';

export const colors = {
  bg: '#0a0c0f',
  surface: '#13171c',
  surfaceRaised: '#1b2027',
  border: '#2a313b',
  text: '#f2f5f8',
  textMuted: '#9aa6b2',
  accent: '#4ea1ff',
  ok: '#34d27b',
  /** Tinted ground behind ARMED state (ok text on it ≈ 8:1). */
  okSoft: '#0f2619',
  warn: '#ffb020',
  warnSoft: '#2b210b',
  /** Danger as text/stroke on dark grounds. */
  danger: '#ff5a4f',
  /** Danger as a filled ground under white text (white on it ≈ 5.4:1, AA). */
  dangerFill: '#c62a1f',
  dangerPressed: '#9e1f16',
  onDanger: '#ffffff',
  onAccent: '#06111f',
  onOk: '#04140b',
  grid: '#1f252d',
  trail: '#4ea1ff',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;
export const font = { xs: 11, sm: 13, md: 15, lg: 18, xl: 22, xxl: 28, hero: 32 } as const;

/** Minimum touch target (pt) — large for one-handed operation. */
export const touchMin = 56;
/** Platform minimum for secondary controls (Apple HIG 44 pt). */
export const touchSecondary = 44;

export const modeColor: Record<Mode, string> = {
  DISARMED: colors.textMuted,
  ARMED: colors.ok,
  SAFE_STOP: colors.danger,
};
