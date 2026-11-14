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
  accessibilityHint?: string;
}

/** Press-and-hold confirmation with a fill progress bar. */
export default function HoldButton({
  label,
  onConfirm,
  holdMs = 1000,
  disabled = false,
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
      style={({ pressed }) => [styles.btn, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Animated.View style={[styles.fill, fillStyle]} />
      <View style={styles.content}>
        <Text style={styles.text}>{label}</Text>
        <Text style={styles.sub}>hold 1 s</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    minHeight: touchMin,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.ok,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  pressed: { borderColor: colors.text },
  disabled: { opacity: 0.4 },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.ok, opacity: 0.35 },
  content: { alignItems: 'center', paddingVertical: 8 },
  text: { color: colors.text, fontSize: font.lg, fontWeight: '800', letterSpacing: 1 },
  sub: { color: colors.textMuted, fontSize: font.sm },
});
