import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ConnectScreen, { type ConnectTarget } from './src/screens/ConnectScreen';
import TeleopScreen from './src/screens/TeleopScreen';
import { colors } from './src/theme';

const DEFAULT_TARGET: ConnectTarget = { address: '192.168.1.10:8080', token: '' };
const REJECTED_MSG = 'Token salah atau robot sedang dipakai';

export default function App() {
  // In-memory only: the app has no persistent storage module installed.
  const [last, setLast] = useState<ConnectTarget>(DEFAULT_TARGET);
  const [active, setActive] = useState<ConnectTarget | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connect = useCallback((t: ConnectTarget) => {
    setLast(t);
    setConnectError(null);
    setActive(t);
  }, []);
  const exit = useCallback(() => setActive(null), []);
  const rejected = useCallback(() => {
    setConnectError(REJECTED_MSG);
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
        ) : (
          <ConnectScreen initial={last} connectError={connectError} onConnect={connect} />
        )}
        <StatusBar style="light" />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
