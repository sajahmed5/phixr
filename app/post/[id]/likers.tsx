import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';

import { UserRow } from '@/components/profile/user-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { getPostLikers, type PostLiker } from '@/lib/deck';

const PAGE = 30;

/**
 * Who liked your post (Part 4B) — own posts only, enforced server-side.
 * Deck likes and feed hearts together, newest first. People who turned on
 * "Hide my likes" simply aren't here (their likes still count in totals),
 * and left swipes never appear anywhere, full stop.
 */
export default function PostLikersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();
  const [rows, setRows] = useState<PostLiker[] | null>(null);
  const [error, setError] = useState(false);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const first = await getPostLikers(id, null, PAGE);
      setRows(first);
      setDone(first.length < PAGE);
    } catch {
      setError(true);
    }
  }, [id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
  }, [load]);

  const more = async () => {
    if (done || !rows || rows.length === 0) return;
    try {
      const next = await getPostLikers(id, rows[rows.length - 1].liked_at, PAGE);
      setRows((prev) => [...(prev ?? []), ...next]);
      if (next.length < PAGE) setDone(true);
    } catch {
      // next scroll retries
    }
  };

  if (error) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Likes' }} />
        <ThemedText type="small" themeColor="textSecondary">
          Couldn&apos;t load likes.
        </ThemedText>
        <Button title="Retry" variant="secondary" onPress={load} />
      </ThemedView>
    );
  }
  if (!rows) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Likes' }} />
        <ActivityIndicator color={theme.textSecondary} />
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Likes' }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.user_id}
        contentContainerStyle={styles.content}
        onEndReached={more}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
            No likes to show yet.
          </ThemedText>
        }
        renderItem={({ item }) => (
          <UserRow
            handle={item.handle}
            displayName={item.display_name}
            avatarUrl={item.avatar_url}
            onPress={() => router.push(`/u/${item.handle}`)}
            right={
              item.verified ? (
                <View style={styles.verifiedRow}>
                  <Ionicons name="checkmark-circle" size={18} color={BRAND.accent} />
                  <ThemedText type="small" themeColor="textSecondary">
                    Verified
                  </ThemedText>
                </View>
              ) : undefined
            }
          />
        )}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  content: { padding: 20, gap: 4 },
  empty: { textAlign: 'center', marginTop: 24 },
  verifiedRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
