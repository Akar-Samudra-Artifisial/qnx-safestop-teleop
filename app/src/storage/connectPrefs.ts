// Last connection target: host:port in AsyncStorage, pairing token in the OS keychain
// (expo-secure-store). Secure store is unavailable on web → token is not persisted there.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const ADDRESS_KEY = 'teleop.lastAddress';
const TOKEN_KEY = 'teleop.lastToken';

export interface StoredTarget {
  address: string;
  token: string;
}

async function secureAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function loadConnectTarget(): Promise<StoredTarget> {
  const [address, token] = await Promise.all([
    AsyncStorage.getItem(ADDRESS_KEY).catch(() => null),
    secureAvailable().then((ok) => (ok ? SecureStore.getItemAsync(TOKEN_KEY).catch(() => null) : null)),
  ]);
  return { address: address ?? '', token: token ?? '' };
}

export async function saveConnectTarget(t: StoredTarget): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(ADDRESS_KEY, t.address).catch(() => {}),
    secureAvailable().then((ok) =>
      ok
        ? SecureStore.setItemAsync(TOKEN_KEY, t.token, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          }).catch(() => {})
        : undefined,
    ),
  ]);
}
