import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { colors, font, radius as r, space } from '../theme';

interface JoystickProps {
  /** Diameter of the base, pt. */
  size: number;
  /** Normalized axes: v forward (+up), w turn (+left), each in [-1, 1]. */
  onChange: (v: number, w: number) => void;
  disabled?: boolean;
  /** Shown over the stick while disabled, e.g. "Hold RE-ARM to drive". */
  hint?: string;
}

const DEADZONE = 0.06;

export default function Joystick({ size, onChange, disabled = false, hint }: JoystickProps) {
  const knob = Math.round(size * 0.42);
  const radius = (size - knob) / 2;
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  // Read on the UI thread so an in-flight drag stops immediately when disabled.
  const locked = useSharedValue(disabled);

  // Disabled (mode ≠ ARMED, stale, closed) → knob back to centre, setpoint 0.
  useEffect(() => {
    locked.set(disabled);
    if (disabled) {
      tx.set(withSpring(0, { duration: 180 }));
      ty.set(withSpring(0, { duration: 180 }));
      onChange(0, 0);
    }
  }, [disabled, locked, onChange, tx, ty]);

  const pan = usePanGesture({
    enabled: !disabled,
    minDistance: 0,
    onUpdate: (e) => {
      'worklet';
      if (locked.get()) return;
      let x = e.translationX;
      let y = e.translationY;
      const d = Math.hypot(x, y);
      if (d > radius) {
        x = (x / d) * radius;
        y = (y / d) * radius;
      }
      tx.set(x);
      ty.set(y);
      let nv = -y / radius;
      let nw = -x / radius;
      if (Math.abs(nv) < DEADZONE) nv = 0;
      if (Math.abs(nw) < DEADZONE) nw = 0;
      scheduleOnRN(onChange, nv, nw);
    },
    onFinalize: () => {
      'worklet';
      tx.set(withSpring(0, { duration: 180 }));
      ty.set(withSpring(0, { duration: 180 }));
      scheduleOnRN(onChange, 0, 0);
    },
  });

  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.get() }, { translateY: ty.get() }],
  }));

  return (
    <View style={{ width: size, height: size }}>
      <GestureDetector gesture={pan}>
        <View
          style={[
            styles.base,
            { width: size, height: size, borderRadius: size / 2 },
            !disabled && styles.live,
            disabled && styles.disabled,
          ]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Drive joystick"
          accessibilityHint={
            disabled && hint ? hint : 'Drag up to drive forward, left or right to turn. Release to stop.'
          }
          accessibilityState={{ disabled }}
        >
          <View style={[styles.axis, { width: 2, height: size - space.xl }]} />
          <View style={[styles.axis, { height: 2, width: size - space.xl }]} />
          <Text style={[styles.label, { top: space.sm }]}>FWD</Text>
          <Animated.View
            style={[
              styles.knob,
              disabled && styles.knobOff,
              { width: knob, height: knob, borderRadius: knob / 2 },
              knobStyle,
            ]}
          />
        </View>
      </GestureDetector>
      {disabled && hint && (
        // Not dimmed with the base, so the instruction stays AA-readable.
        <View style={styles.hintWrap} pointerEvents="none" accessible={false}>
          <Text style={styles.hint}>{hint}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  live: { borderColor: colors.accent },
  disabled: { opacity: 0.35 },
  knobOff: { backgroundColor: colors.border, borderColor: colors.textMuted },
  hintWrap: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
  hint: {
    color: colors.text,
    backgroundColor: colors.surfaceRaised,
    borderRadius: r.sm,
    overflow: 'hidden',
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    fontSize: font.sm,
    fontWeight: '700',
    textAlign: 'center',
  },
  axis: { position: 'absolute', backgroundColor: colors.grid },
  label: {
    position: 'absolute',
    color: colors.textMuted,
    fontSize: font.sm,
    fontWeight: '700',
    letterSpacing: 1,
  },
  knob: {
    backgroundColor: colors.accent,
    borderWidth: 3,
    borderColor: colors.text,
  },
});
