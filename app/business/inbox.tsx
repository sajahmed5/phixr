import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import { getBusinessConversations, type BusinessConversation } from '@/lib/business';
import { formatRelative } from '@/lib/relative-time';

/**
 * Part 13A: the business inbox for the owner and team (admin/editor/
 * moderator). Opening a thread replies AS the business — the customer only
 * ever sees the business; the activity log records who really wrote it.
 */
export default function BusinessInboxScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ business?: string }>();
  const businessId = (typeof params.business === 'string' && params.business) || user?.id || '';
  const actingForOther = businessId !== user?.id;

  const [rows, setRows] = useState<BusinessConversation[] | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await getBusinessConversations(businessId));
    } catch {
      setRows([]);
    }
  }, [businessId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
  }, [load]);

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Business inbox' }} />
      {rows === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.textSecondary} />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.center}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            No customer messages yet.
          </ThemedText>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.conversation_id}
          contentContainerStyle={styles.content}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: '/conversation/[id]',
                  params: actingForOther
                    ? { id: item.conversation_id, as: businessId }
                    : { id: item.conversation_id },
                })
              }
              style={[styles.row, { borderColor: theme.border }]}>
              <View style={styles.info}>
                <ThemedText type="smallBold" numberOfLines={1}>
                  {item.other_display_name || `@${item.other_handle}`}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                  {item.last_body ?? 'No messages yet'}
                </ThemedText>
              </View>
              {item.last_at ? (
                <ThemedText type="small" themeColor="textSecondary">
                  {formatRelative(item.last_at)}
                </ThemedText>
              ) : null}
            </Pressable>
          )}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centerText: { textAlign: 'center' },
  content: { padding: 16, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
  info: { flex: 1, gap: 2 },
});
