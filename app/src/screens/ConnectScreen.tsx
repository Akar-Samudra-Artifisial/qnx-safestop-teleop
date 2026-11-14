import { useCallback, useRef, useState, type ComponentRef } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import BrandMark from '../components/BrandMark';
import { colors, font, radius, space, touchMin } from '../theme';

const ADDRESS_RE = /^[\w.-]+:\d{1,5}$/;
const TOKEN_RE = /^\d{6}$/;
const TOKEN_LEN = 6;

export interface ConnectTarget {
  /** host:port */
  address: string;
  /** 6-digit pairing token printed by teleopd. */
  token: string;
}

interface ConnectScreenProps {
  initial: ConnectTarget;
  /** Error from the previous attempt (e.g. handshake rejected). */
  connectError?: string | null;
  /** Called with a validated target. */
  onConnect: (target: ConnectTarget) => void;
}

type FieldErrors = { address?: string; token?: string };

export default function ConnectScreen({ initial, connectError, onConnect }: ConnectScreenProps) {
  const [address, setAddress] = useState(initial.address);
  const [token, setToken] = useState(initial.token);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [tokenFocused, setTokenFocused] = useState(false);
  const tokenRef = useRef<ComponentRef<typeof TextInput>>(null);
  const restored = initial.address !== '';

  const onTokenChange = useCallback((t: string) => {
    setToken(t.replace(/\D/g, '').slice(0, TOKEN_LEN));
    setErrors((e) => (e.token ? { ...e, token: undefined } : e));
  }, []);
  const onAddressChange = useCallback((a: string) => {
    setAddress(a);
    setErrors((e) => (e.address ? { ...e, address: undefined } : e));
  }, []);

  const submit = useCallback(() => {
    const a = address.trim();
    const next: FieldErrors = {};
    if (!ADDRESS_RE.test(a)) next.address = 'Use host:port — the robot’s LAN IP, e.g. 192.168.1.20:8080';
    if (!TOKEN_RE.test(token)) next.token = 'Enter the 6-digit code teleopd printed at start-up';
    setErrors(next);
    if (next.address || next.token) return;
    onConnect({ address: a, token });
  }, [address, token, onConnect]);

  const ready = ADDRESS_RE.test(address.trim()) && TOKEN_RE.test(token);

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <BrandMark size={44} />
            <Text style={styles.title} accessibilityRole="header">
              SafeStop Teleop
            </Text>
            <Text style={styles.subtitle}>
              Drive a QNX robot from your phone. If the link drops for 150{' '}ms, the robot stops itself.
            </Text>
          </View>

          {connectError && (
            <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <Text style={styles.bannerTitle}>Could not connect</Text>
              <Text style={styles.bannerText}>{connectError}</Text>
            </View>
          )}

          <View style={styles.field}>
            <Text style={styles.label} nativeID="addrLabel">
              Robot address
            </Text>
            <TextInput
              style={[styles.input, errors.address ? styles.inputError : null]}
              value={address}
              onChangeText={onAddressChange}
              placeholder="192.168.1.20:8080"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="next"
              onSubmitEditing={() => tokenRef.current?.focus()}
              accessibilityLabel="Robot address, host colon port"
              accessibilityLabelledBy="addrLabel"
            />
            {errors.address ? (
              <Text style={styles.error}>{errors.address}</Text>
            ) : (
              <Text style={styles.hint}>{restored ? 'Last used address restored' : 'host:port shown by teleopd'}</Text>
            )}
          </View>

          <View style={styles.field}>
            <Text style={styles.label} nativeID="tokenLabel">
              Pairing code
            </Text>
            <Pressable onPress={() => tokenRef.current?.focus()} accessible={false} style={styles.otpRow}>
              {Array.from({ length: TOKEN_LEN }, (_, i) => {
                const active = tokenFocused && (i === token.length || (i === TOKEN_LEN - 1 && token.length === TOKEN_LEN));
                return (
                  <View
                    key={i}
                    style={[
                      styles.otpCell,
                      token[i] ? styles.otpFilled : null,
                      active && styles.otpActive,
                      errors.token ? styles.inputError : null,
                    ]}
                  >
                    <Text style={styles.otpDigit}>{token[i] ?? ''}</Text>
                  </View>
                );
              })}
              {/* One real input under the cells: paste, one-time-code autofill and a11y keep working. */}
              <TextInput
                ref={tokenRef}
                style={styles.otpInput}
                value={token}
                onChangeText={onTokenChange}
                onSubmitEditing={submit}
                onFocus={() => setTokenFocused(true)}
                onBlur={() => setTokenFocused(false)}
                keyboardType="number-pad"
                inputMode="numeric"
                maxLength={TOKEN_LEN}
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                returnKeyType="go"
                caretHidden
                accessibilityLabel="Pairing code, 6 digits"
                accessibilityLabelledBy="tokenLabel"
              />
            </Pressable>
            {errors.token ? (
              <Text style={styles.error}>{errors.token}</Text>
            ) : (
              <Text style={styles.hint}>6 digits, printed by teleopd when it starts</Text>
            )}
          </View>

          <Pressable
            style={({ pressed }) => [styles.button, !ready && styles.buttonIdle, pressed && styles.pressed]}
            onPress={submit}
            accessibilityRole="button"
            accessibilityLabel="Connect"
          >
            <Text style={[styles.buttonText, !ready && styles.buttonTextIdle]}>Connect</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  container: { flexGrow: 1, padding: space.xl, gap: space.lg, justifyContent: 'center' },
  brand: { gap: space.sm, marginBottom: space.sm },
  title: { color: colors.text, fontSize: font.xxl, fontWeight: '800' },
  subtitle: { color: colors.textMuted, fontSize: font.md, lineHeight: 21 },
  field: { gap: space.xs },
  label: { color: colors.text, fontSize: font.sm, fontWeight: '700' },
  hint: { color: colors.textMuted, fontSize: font.sm },
  input: {
    minHeight: touchMin,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    color: colors.text,
    backgroundColor: colors.surface,
    fontSize: font.lg,
    fontVariant: ['tabular-nums'],
  },
  inputError: { borderColor: colors.danger },
  otpRow: { flexDirection: 'row', gap: space.sm },
  otpCell: {
    flex: 1,
    height: touchMin,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  otpFilled: { backgroundColor: colors.surfaceRaised },
  otpActive: { borderColor: colors.accent },
  otpDigit: { color: colors.text, fontSize: font.xl, fontWeight: '800', fontVariant: ['tabular-nums'] },
  otpInput: {
    ...StyleSheet.absoluteFill,
    opacity: 0.011,
    color: 'transparent',
    fontSize: 1,
  },
  error: { color: colors.danger, fontSize: font.sm, fontWeight: '600' },
  banner: {
    borderWidth: 1.5,
    borderColor: colors.danger,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: space.md,
    gap: 2,
  },
  bannerTitle: { color: colors.danger, fontSize: font.sm, fontWeight: '800' },
  bannerText: { color: colors.text, fontSize: font.md, fontWeight: '600' },
  button: {
    minHeight: touchMin,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.sm,
  },
  buttonIdle: { backgroundColor: colors.surfaceRaised },
  pressed: { opacity: 0.8 },
  buttonText: { color: colors.onAccent, fontSize: font.lg, fontWeight: '800' },
  buttonTextIdle: { color: colors.textMuted },
});
