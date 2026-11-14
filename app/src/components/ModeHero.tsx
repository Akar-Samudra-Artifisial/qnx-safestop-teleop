import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { eventLatencyLabel, reasonText } from '../format';
import type { Mode } from '../protocol';
import type { LinkEvent, LinkStatus } from '../net/teleopLink';
import { colors, font, radius, space } from '../theme';

interface ModeHeroProps {
  status: LinkStatus;
  stale: boolean;
  mode: Mode | null;
  /** Most recent SAFE_STOP event, explains why the robot stopped. */
  lastEvent: LinkEvent | null;
  linkLossSim: boolean;
  compact?: boolean;
}

type Tone = 'ok' | 'danger' | 'warn' | 'idle';

interface HeroView {
  tone: Tone;
  title: string;
  line: string;
  detail?: string;
  /** What the operator should do next; always its own line, never truncated. */
  action?: string;
}

const fmtClock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/** Plain-language summary of what the robot is doing and what the operator should do next. */
export function heroView({ status, stale, mode, lastEvent, linkLossSim }: ModeHeroProps): HeroView {
  if (status === 'connecting') return { tone: 'idle', title: 'CONNECTING', line: 'Opening the link to teleopd…' };
  if (status !== 'open') {
    return { tone: 'warn', title: 'LINK DOWN', line: 'No connection. teleopd stops the robot on its own.', action: 'Tap Reconnect' };
  }
  if (stale || !mode) return { tone: 'warn', title: 'NO DATA', line: 'No robot state for over 1 s. Motion held.' };
  if (mode === 'ARMED') {
    return linkLossSim
      ? { tone: 'warn', title: 'ARMED', line: 'Link loss simulated. Watchdog trips at 150 ms.' }
      : { tone: 'ok', title: 'ARMED', line: 'Drive with the stick. Release to stop.' };
  }
  if (mode === 'SAFE_STOP') {
    return {
      tone: 'danger',
      title: 'SAFE STOP',
      line: lastEvent ? reasonText(lastEvent.reason) : 'Motion stopped by teleopd.',
      detail: lastEvent
        ? `${eventLatencyLabel(lastEvent.reason, lastEvent.detectMs)} · ${fmtClock(lastEvent.at)}`
        : undefined,
      action: 'Hold RE-ARM to resume',
    };
  }
  return { tone: 'idle', title: 'DISARMED', line: 'Motion disabled.', action: 'Hold RE-ARM to drive' };
}

const TONE = {
  ok: { bg: colors.okSoft, border: colors.ok, title: colors.ok, text: colors.text, dot: colors.ok },
  danger: { bg: colors.dangerFill, border: colors.dangerFill, title: colors.onDanger, text: colors.onDanger, dot: colors.onDanger },
  warn: { bg: colors.warnSoft, border: colors.warn, title: colors.warn, text: colors.text, dot: colors.warn },
  idle: { bg: colors.surface, border: colors.border, title: colors.text, text: colors.textMuted, dot: colors.textMuted },
} as const;

/** The one-glance answer: is the robot allowed to move, and if not, why. */
function ModeHero(props: ModeHeroProps) {
  const v = heroView(props);
  const t = TONE[v.tone];
  return (
    <View
      style={[styles.card, props.compact && styles.cardCompact, { backgroundColor: t.bg, borderColor: t.border }]}
      accessible
      accessibilityRole="header"
      accessibilityLabel={[v.title, v.line, v.detail, v.action].filter(Boolean).join('. ')}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.titleRow}>
        <View style={[styles.dot, { backgroundColor: t.dot }]} />
        <Text style={[styles.title, props.compact && styles.titleCompact, { color: t.title }]} numberOfLines={1}>
          {v.title}
        </Text>
      </View>
      <Text style={[styles.line, { color: t.text }]} numberOfLines={2}>
        {v.line}
      </Text>
      {v.detail && (
        <Text style={[styles.detail, { color: t.text }]} numberOfLines={2}>
          {v.detail}
        </Text>
      )}
      {v.action && <Text style={[styles.action, { color: t.title }]}>→ {v.action}</Text>}
    </View>
  );
}

// Parent re-renders at 20 Hz; props here change only on mode/link/event transitions.
export default memo(ModeHero);

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1.5,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: 2,
  },
  cardCompact: { paddingVertical: space.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 12, height: 12, borderRadius: 6 },
  title: { fontSize: font.hero, fontWeight: '900', letterSpacing: 1 },
  titleCompact: { fontSize: font.xxl },
  line: { fontSize: font.md, fontWeight: '700' },
  detail: { fontSize: font.sm, fontWeight: '600', fontVariant: ['tabular-nums'] },
  action: { fontSize: font.md, fontWeight: '800', marginTop: 2 },
});
