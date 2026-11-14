import { StyleSheet, Text, View } from 'react-native';

import { fmtMs } from '../format';
import type { LinkEvent } from '../net/teleopLink';
import { colors, font, radius, space } from '../theme';

interface EventListProps {
  events: LinkEvent[];
  max?: number;
}

const fmtTime = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/**
 * hb_timeout: detect_us = last hb → SAFE_STOP detected ("deteksi").
 * estop/others: detect_us = command received → handled ("proses").
 */
export function eventLatencyLabel(reason: string, detectMs: number): string {
  const kind = reason === 'hb_timeout' ? 'deteksi' : 'proses';
  return `${kind} ${fmtMs(detectMs, detectMs < 10 ? 2 : 1)} ms`;
}

export default function EventList({ events, max = 3 }: EventListProps) {
  return (
    <View style={styles.wrap} accessibilityLabel="Recent safety events">
      <Text style={styles.title}>SAFE_STOP EVENTS</Text>
      {events.length === 0 ? (
        <Text style={styles.empty}>None yet</Text>
      ) : (
        events.slice(0, max).map((e) => (
          <View
            key={e.id}
            style={styles.row}
            accessible
            accessibilityLabel={`${fmtTime(e.at)}, ${e.reason}, ${eventLatencyLabel(e.reason, e.detectMs)}`}
          >
            <Text style={styles.time}>{fmtTime(e.at)}</Text>
            <Text style={styles.reason} numberOfLines={1}>
              {e.reason}
            </Text>
            <Text style={styles.detect}>{eventLatencyLabel(e.reason, e.detectMs)}</Text>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: space.sm,
    gap: space.xs,
  },
  title: { color: colors.textMuted, fontSize: font.sm, fontWeight: '700', letterSpacing: 1 },
  empty: { color: colors.textMuted, fontSize: font.sm },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  time: { color: colors.textMuted, fontSize: font.sm, fontVariant: ['tabular-nums'] },
  reason: { flex: 1, color: colors.danger, fontSize: font.sm, fontWeight: '700' },
  detect: { color: colors.text, fontSize: font.sm, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
