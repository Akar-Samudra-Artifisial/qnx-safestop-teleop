import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ConnectScreen, { type ConnectTarget } from './src/screens/ConnectScreen';
import TeleopScreen from './src/screens/TeleopScreen';
import type { RejectReason } from './src/net/teleopLink';
import { loadConnectTarget, saveConnectTarget } from './src/storage/connectPrefs';
import { colors } from './src/theme';

const DEFAULT_TARGET: ConnectTarget = { address: '', token: '' };
const REJECTED_MSG: Record<RejectReason, string> = {
  unauthorized: 'Wrong pairing code (401). Check the code teleopd printed.',
  forbidden: 'Server refused this app’s origin (403).',
  conflict: 'Robot is in use by another operator (409).',
  timeout: 'Robot not reachable. Check the address and that you are on the same network.',
  // RN did not expose the HTTP status.
  unknown: 'Wrong pairing code, or the robot is in use.',
};

export default function App() {
  // Last target persisted (host → AsyncStorage, token → SecureStore); null until loaded.
  const [last, setLast] = useState<ConnectTarget | null>(null);
  const [active, setActive] = useState<ConnectTarget | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadConnectTarget()
      .catch(() => DEFAULT_TARGET)
      .then((t) => alive && setLast(t));
    return () => {
      alive = false;
    };
  }, []);

  const connect = useCallback((t: ConnectTarget) => {
    setLast(t);
    setConnectError(null);
    setActive(t);
    void saveConnectTarget(t);
  }, []);
  const exit = useCallback(() => setActive(null), []);
  const rejected = useCallback((reason: RejectReason) => {
    setConnectError(REJECTED_MSG[reason]);
    setActive(null);
  }, []);

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.root}>
        {active ? (
          <TeleopScreen
            key={`${active.address}/${active.token}`}
            address={active.address}
            token={active.token}
            onExit={exit}
            onRejected={rejected}
          />
        ) : last ? (
          <ConnectScreen initial={last} connectError={connectError} onConnect={connect} />
        ) : null}
        <StatusBar style="light" />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
