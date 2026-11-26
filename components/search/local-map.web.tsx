import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

/**
 * Web build of the Local Map: react-native-maps has no web implementation (importing
 * it crashed the whole site at load), so the map is app-only and the web shows a note.
 */
export function LocalMap() {
  const theme = useTheme();
  return (
    <View style={styles.wrap}>
      <Ionicons name="map-outline" size={36} color={theme.textSecondary} />
      <ThemedText themeColor="textSecondary" style={styles.text}>
        The map is available in the Phixr app on iPhone and Android.
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  text: { textAlign: 'center' },
});
