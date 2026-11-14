import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { parseServerMessage, type ServerMessage } from '../protocol';

type WsStatus = 'idle' | 'invalid address' | 'connecting' | 'open' | 'closed' | 'error';

const ADDRESS_RE = /^[\w.-]+:\d{1,5}$/;

export default function ConnectScreen() {
  const [address, setAddress] = useState('192.168.1.10:8080');
  const [status, setStatus] = useState<WsStatus>('idle');
  const [lastMessage, setLastMessage] = useState<ServerMessage | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => () => wsRef.current?.close(), []);

  const connect = useCallback(() => {
    wsRef.current?.close();
    const trimmed = address.trim();
    if (!ADDRESS_RE.test(trimmed)) {
      setStatus('invalid address');
      return;
    }
    setStatus('connecting');
    const ws = new WebSocket(`ws://${trimmed}`);
    ws.onopen = () => setStatus('open');
    ws.onclose = () => setStatus('closed');
    ws.onerror = () => setStatus('error');
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = parseServerMessage(e.data);
        if (msg) setLastMessage(msg);
      }
    };
    wsRef.current = ws;
  }, [address]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>QNX Safe-Stop Teleop</Text>
      <TextInput
        style={styles.input}
        value={address}
        onChangeText={setAddress}
        placeholder="host:port"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel="Robot address host:port"
      />
      <Pressable style={styles.button} onPress={connect} accessibilityRole="button">
        <Text style={styles.buttonText}>Connect</Text>
      </Pressable>
      <Text>WebSocket: {status}</Text>
      {lastMessage?.type === 'state' && <Text>Mode: {lastMessage.mode}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 12, justifyContent: 'center', backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 8, padding: 12 },
  button: { backgroundColor: '#1f6feb', padding: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
});
