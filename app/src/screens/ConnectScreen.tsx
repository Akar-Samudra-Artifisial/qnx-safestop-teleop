import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, font, radius, space, touchMin } from '../theme';

const ADDRESS_RE = /^[\w.-]+:\d{1,5}$/;
const TOKEN_RE = /^\d{6}$/;

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

  const onTokenChange = useCallback((t: string) => setToken(t.replace(/\D/g, '').slice(0, 6)), []);

  const submit = useCallback(() => {
    const a = address.trim();
    const next: FieldErrors = {};
    if (!ADDRESS_RE.test(a)) next.address = 'Use host:port — the robot/Mac LAN IP, e.g. 192.168.x.x:8080';
    if (!TOKEN_RE.test(token)) next.token = 'Token is the 6-digit code printed by teleopd';
    setErrors(next);
    if (next.address || next.token) return;
    onConnect({ address: a, token });
  }, [address, token, onConnect]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.title} accessibilityRole="header">
          QNX Safe-Stop Teleop
        </Text>

        {connectError && (
          <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="assertive">
            <Text style={styles.bannerText}>{connectError}</Text>
          </View>
        )}

        <Text style={styles.label} nativeID="addrLabel">
          Robot address
        </Text>
        <TextInput
          style={[styles.input, errors.address ? styles.inputError : null]}
          value={address}
          onChangeText={setAddress}
          placeholder="192.168.x.x:8080"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="next"
          accessibilityLabel="Robot address, host colon port"
          accessibilityLabelledBy="addrLabel"
        />
        {errors.address && <Text style={styles.error}>{errors.address}</Text>}

        <Text style={styles.label} nativeID="tokenLabel">
          Pairing token
        </Text>
        <TextInput
          style={[styles.input, styles.token, errors.token ? styles.inputError : null]}
          value={token}
          onChangeText={onTokenChange}
          onSubmitEditing={submit}
          placeholder="000000"
          placeholderTextColor={colors.textMuted}
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          returnKeyType="go"
          accessibilityLabel="Pairing token, 6 digits"
          accessibilityLabelledBy="tokenLabel"
        />
        {errors.token && <Text style={styles.error}>{errors.token}</Text>}

        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          onPress={submit}
          accessibilityRole="button"
          accessibilityLabel="Connect"
        >
          <Text style={styles.buttonText}>Connect</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, padding: space.xl, gap: space.md, justifyContent: 'center' },
  title: { color: colors.text, fontSize: font.xxl, fontWeight: '800', marginBottom: space.md },
  label: { color: colors.textMuted, fontSize: font.sm, fontWeight: '700', letterSpacing: 1 },
  input: {
    minHeight: touchMin,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    color: colors.text,
    backgroundColor: colors.surface,
    fontSize: font.lg,
  },
  token: { fontSize: font.xl, letterSpacing: 6, fontVariant: ['tabular-nums'] },
  inputError: { borderColor: colors.danger },
  error: { color: colors.danger, fontSize: font.sm, fontWeight: '600' },
  banner: {
    borderWidth: 2,
    borderColor: colors.danger,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: space.md,
  },
  bannerText: { color: colors.text, fontSize: font.md, fontWeight: '700' },
  button: {
    minHeight: touchMin,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.8 },
  buttonText: { color: colors.onAccent, fontSize: font.lg, fontWeight: '800' },
});
