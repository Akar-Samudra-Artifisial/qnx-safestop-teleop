import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, font, radius, space, touchSecondary } from '../theme';

export interface SegmentOption<K extends string> {
  key: K;
  label: string;
  /** Small count after the label, e.g. number of events. */
  badge?: number;
}

interface SegmentedProps<K extends string> {
  options: readonly SegmentOption<K>[];
  value: K;
  onChange: (key: K) => void;
  accessibilityLabel: string;
}

/** Tab switcher for the secondary panel (map / latency / events). */
function Segmented<K extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: SegmentedProps<K>) {
  return (
    <View style={styles.wrap} accessibilityRole="tablist" accessibilityLabel={accessibilityLabel}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.badge ? `${o.label}, ${o.badge}` : o.label}
            style={({ pressed }) => [styles.seg, on && styles.segOn, pressed && !on && styles.pressed]}
          >
            <Text style={[styles.text, on && styles.textOn]}>{o.label}</Text>
            {!!o.badge && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{o.badge}</Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

// memo() drops the generic; cast keeps `K` inference at call sites.
export default memo(Segmented) as typeof Segmented;

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 3,
    gap: 3,
  },
  seg: {
    flex: 1,
    minHeight: touchSecondary,
    borderRadius: radius.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  segOn: { backgroundColor: colors.surfaceRaised },
  pressed: { opacity: 0.7 },
  text: { color: colors.textMuted, fontSize: font.sm, fontWeight: '700' },
  textOn: { color: colors.text },
  badge: {
    minWidth: 18,
    paddingHorizontal: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.dangerFill,
    alignItems: 'center',
  },
  badgeText: { color: colors.onDanger, fontSize: font.xs, fontWeight: '800', fontVariant: ['tabular-nums'] },
});
