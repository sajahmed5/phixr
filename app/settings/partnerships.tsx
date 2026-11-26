import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, View } from 'react-native';

import { BusinessOnly } from '@/components/business-only';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import {
  getBrandPartnerships,
  getPartnerPostStats,
  respondPartnership,
  revokePartnership,
  type MyPartnership,
} from '@/lib/partnerships';

type Row = MyPartnership & { creator_handle: string; caption: string | null };

/**
 * Brand side of paid partnerships (brief 9B): approve or decline being named
 * on a creator's post, and see the post's ANONYMOUS performance once
 * approved (adults-only aggregates, same floor as everywhere else).
 */
export default function PartnershipsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { profile } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [statsFor, setStatsFor] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(() => {
    getBrandPartnerships()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const respond = async (postId: string, accept: boolean) => {
    setBusy(postId);
    try {
      await respondPartnership(postId, accept);
      load();
    } catch (e) {
      Alert.alert('Could not respond', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (postId: string) => {
    setBusy(postId);
    try {
      await revokePartnership(postId);
      load();
    } catch (e) {
      Alert.alert('Could not withdraw', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const toggleStats = async (postId: string) => {
    if (statsFor === postId) {
      setStatsFor(null);
      setStats(null);
      return;
    }
    try {
      const s = await getPartnerPostStats(postId);
      setStatsFor(postId);
      setStats(s);
    } catch {
      Alert.alert('No stats yet', 'Performance data appears once the post has activity.');
    }
  };

  if ((profile as { account_type?: string } | null)?.account_type !== 'business') {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: 'Partnerships' }} />
        <BusinessOnly feature="Partnerships">{null}</BusinessOnly>
      </>
    );
  }

  const watch = (stats?.watch ?? {}) as Record<string, unknown>;
  const fmtRate = (x: unknown) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—');

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Partnerships' }} />
      {rows === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.textSecondary} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.post_id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <ThemedText type="small" themeColor="textSecondary" style={styles.pad}>
              No partnership requests yet. When a creator tags your business on a paid post, it
              appears here for your approval.
            </ThemedText>
          }
          renderItem={({ item }) => (
            <View style={[styles.card, { borderColor: theme.border }]}>
              <ThemedText type="smallBold">@{item.creator_handle}</ThemedText>
              {item.caption ? (
                <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
                  {item.caption}
                </ThemedText>
              ) : null}
              <ThemedText type="small" themeColor="textSecondary">
                {item.status === 'pending'
                  ? 'Wants to name you in a paid partnership.'
                  : `Status: ${item.status}`}
              </ThemedText>
              <View style={styles.actions}>
                <Button
                  title="View post"
                  variant="secondary"
                  onPress={() =>
                    router.push({ pathname: '/post/[id]', params: { id: item.post_id } })
                  }
                />
                {item.status === 'pending' ? (
                  <>
                    <Button
                      title="Approve"
                      disabled={busy === item.post_id}
                      onPress={() => respond(item.post_id, true)}
                    />
                    <Button
                      title="Decline"
                      variant="secondary"
                      disabled={busy === item.post_id}
                      onPress={() => respond(item.post_id, false)}
                    />
                  </>
                ) : null}
                {item.status === 'approved' ? (
                  <>
                    <Button
                      title={statsFor === item.post_id ? 'Hide stats' : 'Stats'}
                      variant="secondary"
                      onPress={() => toggleStats(item.post_id)}
                    />
                    <Button
                      title="Withdraw name"
                      variant="secondary"
                      disabled={busy === item.post_id}
                      onPress={() => revoke(item.post_id)}
                    />
                  </>
                ) : null}
              </View>
              {statsFor === item.post_id && stats ? (
                <View style={styles.stats}>
                  <ThemedText type="small">
                    Views {String(watch.views ?? 0)} · Like rate {fmtRate(stats.like_rate)} · Quick
                    skips {fmtRate(watch.quick_skip_rate)}
                  </ThemedText>
                  {typeof stats.tip === 'string' ? (
                    <ThemedText type="small" themeColor="textSecondary">
                      💡 {stats.tip}
                    </ThemedText>
                  ) : null}
                  <ThemedText type="small" themeColor="textSecondary">
                    Audience data is anonymous, adults-only and only shown for large groups.
                  </ThemedText>
                </View>
              ) : null}
            </View>
          )}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad: { padding: 24, textAlign: 'center' },
  list: { padding: 16, gap: 12 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  stats: { marginTop: 6, gap: 4 },
});
