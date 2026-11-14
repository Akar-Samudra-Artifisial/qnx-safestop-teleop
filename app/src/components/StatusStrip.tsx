import { StyleSheet, Text, View } from 'react-native';

import { HEARTBEAT_DEADLINE_MS, type Mode } from '../protocol';
import type { LinkStatus } from '../net/teleopLink';
import { colors, font, modeColor, radius, space } from '../theme';

interface StatusStripProps {
  status: LinkStatus;
  mode: Mode | null;
  rttMs: number | null;
  hbAgeMs: number | null;
  /** Shown only when the server reports it (teleopd `plant_ok`). */
  plantOk?: boolean;
  stale: boolean;
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label} ${value}`}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

export default function StatusStrip({ status, mode, rttMs, hbAgeMs, plantOk, stale }: StatusStripProps) {
  const linkUp = status === 'open' && !stale;
  const modeLabel = !linkUp ? (status === 'open' ? 'NO DATA' : status.toUpperCase()) : (mode ?? '…');
  const modeTint = linkUp && mode ? modeColor[mode] : colors.warn;

  const age = hbAgeMs ?? 0;
  const ratio = Math.min(1, age / HEARTBEAT_DEADLINE_MS);
  const barColor = ratio >= 1 ? colors.danger : ratio > 0.66 ? colors.warn : colors.ok;

  return (
    <View style={styles.wrap}>
      <View
        style={[styles.mode, { borderColor: modeTint }]}
        accessible
        accessibilityRole="header"
        accessibilityLabel={`Mode ${modeLabel}`}
        accessibilityLiveRegion="polite"
      >
        <View style={[styles.dot, { backgroundColor: modeTint }]} />
        <Text style={[styles.modeText, { color: modeTint }]}>{modeLabel}</Text>
      </View>
      <View style={styles.row}>
        <Stat label="RTT" value={rttMs == null ? '—' : `${Math.round(rttMs)} ms`} />
        <Stat
          label="HB AGE"
          value={hbAgeMs == null ? '—' : `${Math.round(age)} ms`}
          color={hbAgeMs == null ? undefined : barColor}
        />
        {plantOk !== undefined && (
          <Stat
            label="PLANT"
            value={plantOk ? 'OK' : 'DOWN'}
            color={plantOk ? colors.ok : colors.danger}
          />
        )}
      </View>
      <View
        style={styles.track}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Heartbeat age against 150 millisecond deadline"
        accessibilityValue={{ min: 0, max: HEARTBEAT_DEADLINE_MS, now: Math.round(Math.min(age, HEARTBEAT_DEADLINE_MS)) }}
      >
        <View style={[styles.fill, { width: `${ratio * 100}%`, backgroundColor: barColor }]} />
        <Text style={styles.trackLabel}>deadline {HEARTBEAT_DEADLINE_MS} ms</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  mode: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 2,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    backgroundColor: colors.surface,
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  modeText: { fontSize: font.xl, fontWeight: '900', letterSpacing: 1.5 },
  row: { flexDirection: 'row', gap: space.sm },
  stat: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
  },
  statLabel: { color: colors.textMuted, fontSize: font.sm, fontWeight: '700', letterSpacing: 1 },
  statValue: { color: colors.text, fontSize: font.lg, fontWeight: '800', fontVariant: ['tabular-nums'] },
  track: {
    height: 18,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  trackLabel: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'right',
    paddingRight: space.sm,
  },
});
