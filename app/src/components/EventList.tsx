import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { eventLatencyLabel, reasonText } from '../format';
import type { LinkEvent } from '../net/teleopLink';
import { colors, font, radius, space } from '../theme';

interface EventListProps {
  events: LinkEvent[];
  max?: number;
}

const fmtTime = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/** SAFE_STOP log: what stopped the robot, when, and how fast teleopd reacted. */
export default function EventList({ events, max = 8 }: EventListProps) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title} accessibilityRole="header">
        Safety stops this session
      </Text>
      {events.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyTitle}>No stops yet</Text>
          <Text style={styles.empty}>
            Press E-STOP, or switch on “Simulate link loss” while ARMED to trip the 150 ms watchdog.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {events.slice(0, max).map((e) => (
            <View
              key={e.id}
              style={styles.row}
              accessible
              accessibilityLabel={`${fmtTime(e.at)}, ${reasonText(e.reason)}, ${eventLatencyLabel(e.reason, e.detectMs)}`}
            >
              <View style={styles.rowMain}>
                <Text style={styles.reason} numberOfLines={1}>
                  {reasonText(e.reason)}
                </Text>
                <Text style={styles.meta}>
                  {fmtTime(e.at)} · {e.reason}
                </Text>
              </View>
              <Text style={styles.detect}>{eventLatencyLabel(e.reason, e.detectMs)}</Text>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: space.sm,
  },
  title: { color: colors.text, fontSize: font.md, fontWeight: '800' },
  list: { gap: 0 },
  emptyBox: { flex: 1, justifyContent: 'center', gap: space.xs },
  emptyTitle: { color: colors.text, fontSize: font.md, fontWeight: '700', textAlign: 'center' },
  empty: { color: colors.textMuted, fontSize: font.sm, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    gap: space.sm,
    alignItems: 'center',
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.grid,
  },
  rowMain: { flex: 1, minWidth: 0 },
  reason: { color: colors.danger, fontSize: font.md, fontWeight: '700' },
  meta: { color: colors.textMuted, fontSize: font.xs, fontVariant: ['tabular-nums'] },
  detect: { color: colors.text, fontSize: font.sm, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
