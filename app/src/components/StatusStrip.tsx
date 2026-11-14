import { memo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { fmtUsAsMs } from '../format';
import { HEARTBEAT_DEADLINE_MS } from '../protocol';
import { colors, font, radius, space } from '../theme';

interface StatusStripProps {
  rttMs: number | null;
  hbAgeMs: number | null;
  /** Shown only when the server reports it (teleopd `plant_ok`). */
  plantOk?: boolean;
  /** p99 hb_timeout detection latency, µs; null = no samples yet. */
  p99Us: number | null;
}

interface ChipProps {
  label: string;
  value: string;
  unit?: string;
  color?: string;
  a11y: string;
  flex?: number;
  children?: ReactNode;
}

function Chip({ label, value, unit, color, a11y, flex = 1, children }: ChipProps) {
  return (
    <View style={[styles.chip, { flex }]} accessible accessibilityLabel={a11y}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.value, color ? { color } : null]} numberOfLines={1}>
        {value}
        {unit && <Text style={styles.unit}> {unit}</Text>}
      </Text>
      {children}
    </View>
  );
}

/** Link health at a glance: RTT, heartbeat age against the watchdog deadline, plant, p99. */
function StatusStrip({ rttMs, hbAgeMs, plantOk, p99Us }: StatusStripProps) {
  const age = hbAgeMs ?? 0;
  const ratio = Math.min(1, age / HEARTBEAT_DEADLINE_MS);
  const barColor = ratio >= 1 ? colors.danger : ratio > 0.66 ? colors.warn : colors.ok;

  return (
    <View style={styles.row}>
      <Chip
        label="RTT"
        value={rttMs == null ? '—' : String(Math.round(rttMs))}
        unit={rttMs == null ? undefined : 'ms'}
        a11y={rttMs == null ? 'Round trip time unknown' : `Round trip time ${Math.round(rttMs)} milliseconds`}
      />
      <Chip
        label="HEARTBEAT"
        value={hbAgeMs == null ? '—' : String(Math.round(age))}
        unit={hbAgeMs == null ? undefined : `/ ${HEARTBEAT_DEADLINE_MS}`}
        color={hbAgeMs == null ? undefined : barColor}
        flex={1.35}
        a11y={
          hbAgeMs == null
            ? 'Heartbeat age unknown'
            : `Heartbeat age ${Math.round(age)} of ${HEARTBEAT_DEADLINE_MS} millisecond deadline`
        }
      >
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${ratio * 100}%`, backgroundColor: barColor }]} />
        </View>
      </Chip>
      <Chip
        label="PLANT"
        value={plantOk === undefined ? '—' : plantOk ? 'OK' : 'DOWN'}
        color={plantOk === undefined ? undefined : plantOk ? colors.ok : colors.danger}
        flex={0.9}
        a11y={plantOk === undefined ? 'Plant status unknown' : plantOk ? 'Plant OK' : 'Plant down'}
      />
      <Chip
        label="STOP p99"
        value={p99Us == null ? '—' : fmtUsAsMs(p99Us)}
        unit={p99Us == null ? undefined : 'ms'}
        flex={1.15}
        a11y={
          p99Us == null
            ? 'Stop detection p99 not measured yet'
            : `Stop detection 99th percentile ${fmtUsAsMs(p99Us)} milliseconds`
        }
      />
    </View>
  );
}

// Primitive props only: skips re-render when a 20 Hz frame leaves the numbers unchanged.
export default memo(StatusStrip);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm },
  chip: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    gap: 2,
    minWidth: 0,
  },
  label: { color: colors.textMuted, fontSize: font.xs, fontWeight: '700', letterSpacing: 0.8 },
  value: { color: colors.text, fontSize: font.lg, fontWeight: '800', fontVariant: ['tabular-nums'] },
  unit: { color: colors.textMuted, fontSize: font.xs, fontWeight: '600' },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.grid, overflow: 'hidden', marginTop: 2 },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2 },
});
