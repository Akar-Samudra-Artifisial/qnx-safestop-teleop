// Design tokens: dark, high-contrast operator UI.
import type { Mode } from './protocol';

export const colors = {
  bg: '#0b0d10',
  surface: '#15191f',
  surfaceRaised: '#1e242c',
  border: '#2f3742',
  text: '#f2f5f8',
  textMuted: '#9aa6b2',
  accent: '#4ea1ff',
  ok: '#2fd47a',
  warn: '#ffb020',
  danger: '#ff3b30',
  dangerPressed: '#c9241b',
  onDanger: '#ffffff',
  onAccent: '#06111f',
  grid: '#232a33',
  trail: '#4ea1ff',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;
export const font = { sm: 13, md: 15, lg: 18, xl: 22, xxl: 28 } as const;

/** Minimum touch target (pt) — large for one-handed operation. */
export const touchMin = 56;

export const modeColor: Record<Mode, string> = {
  DISARMED: colors.textMuted,
  ARMED: colors.ok,
  SAFE_STOP: colors.danger,
};
