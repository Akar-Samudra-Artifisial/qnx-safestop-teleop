import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { colors, font, radius, touchMin } from '../theme';

interface HoldButtonProps {
  label: string;
  /** Called once the button has been held for `holdMs`. */
  onConfirm: () => void;
  holdMs?: number;
  disabled?: boolean;
  /** Draw attention: this is the next thing the operator must do. */
  emphasis?: boolean;
  accessibilityHint?: string;
}

/** Press-and-hold confirmation; the fill sweeps left→right over `holdMs`. */
export default function HoldButton({
  label,
  onConfirm,
  holdMs = 1000,
  disabled = false,
  emphasis = false,
  accessibilityHint,
}: HoldButtonProps) {
  const progress = useSharedValue(0);

  const start = useCallback(() => {
    progress.set(
      withTiming(1, { duration: holdMs }, (finished) => {
        'worklet';
        if (finished) {
          scheduleOnRN(onConfirm);
          progress.set(withTiming(0, { duration: 150 }));
        }
      }),
    );
  }, [holdMs, onConfirm, progress]);

  const cancel = useCallback(() => {
    cancelAnimation(progress);
    progress.set(withTiming(0, { duration: 150 }));
  }, [progress]);

  const fillStyle = useAnimatedStyle(() => ({ width: `${progress.get() * 100}%` }));

  return (
    <Pressable
      onPressIn={start}
      onPressOut={cancel}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint ?? `Press and hold for ${holdMs / 1000} second`}
      accessibilityState={{ disabled }}
      // Screen readers cannot hold; a double-tap activation confirms directly.
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={(e) => e.nativeEvent.actionName === 'activate' && onConfirm()}
      style={({ pressed }) => [
        styles.btn,
        emphasis && styles.emphasis,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Animated.View style={[styles.fill, fillStyle]} />
      <View style={styles.content}>
        <Text style={[styles.text, emphasis && styles.textEmphasis]}>{label}</Text>
        <Text style={styles.sub}>hold {holdMs / 1000} s</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    minHeight: touchMin,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  emphasis: { borderColor: colors.ok, backgroundColor: colors.okSoft },
  pressed: { borderColor: colors.text },
  disabled: { opacity: 0.4 },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.ok, opacity: 0.45 },
  content: { alignItems: 'center', paddingVertical: 6 },
  text: { color: colors.textMuted, fontSize: font.lg, fontWeight: '800', letterSpacing: 1 },
  textEmphasis: { color: colors.text },
  sub: { color: colors.textMuted, fontSize: font.xs, fontWeight: '600' },
});
