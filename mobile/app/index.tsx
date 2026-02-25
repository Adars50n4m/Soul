import { Redirect } from 'expo-router';
import { useApp } from '../context/AppContext';
import { View, ActivityIndicator } from 'react-native';

export default function Index() {
  const { currentUser, isReady } = useApp();

  if (!isReady) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#BC002A" />
      </View>
    );
  }

  if (!currentUser) {
    return <Redirect href="/login" />;
  }

  return <Redirect href="/(tabs)" />;
}
