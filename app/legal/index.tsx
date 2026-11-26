import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { LEGAL_DOC_LIST, LEGAL_DOCS, TERMS_VERSION } from '@/constants/legal';
import { useTheme } from '@/hooks/use-theme';

/** Lists every legal document in constants/legal.ts; each row opens /legal/<id>. */
export default function LegalIndexScreen() {
  const theme = useTheme();
  const router = useRouter();

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Legal' }} />
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedText type="title">Legal</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Version {TERMS_VERSION}
        </ThemedText>
        <View style={[styles.card, { borderColor: theme.border }]}>
          {LEGAL_DOC_LIST.map(({ id, summary }, i) => (
            <Pressable
              key={id}
              onPress={() => router.push(`/legal/${id}`)}
              accessibilityRole="button"
              accessibilityLabel={LEGAL_DOCS[id].title}
              accessibilityHint={summary}
              style={({ pressed }) => [
                styles.row,
                i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
                pressed && styles.pressed,
              ]}>
              <View style={styles.rowText}>
                <ThemedText type="default">{LEGAL_DOCS[id].title}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {summary}
                </ThemedText>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
            </Pressable>
          ))}
        </View>
        <ThemedText type="small" themeColor="textSecondary" style={styles.footer}>
          Questions about any of these documents: support@joinphixr.com
        </ThemedText>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 20, gap: 10 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  rowText: { flex: 1, gap: 2 },
  pressed: { opacity: 0.6 },
  footer: { marginTop: 8 },
});
