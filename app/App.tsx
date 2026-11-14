import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import ConnectScreen from './src/screens/ConnectScreen';

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ConnectScreen />
      <StatusBar style="auto" />
    </GestureHandlerRootView>
  );
}
