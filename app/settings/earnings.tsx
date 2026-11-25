import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import { getMyEarnings, type MyEarnings } from '@/lib/earnings';

function pounds(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

const KIND_LABELS: Record<string, string> = {
  partnership: 'Paid partnership',
  ad_revenue_share: 'Ad revenue share',
  adjustment: 'Adjustment',
};

/**
 * Creator earnings (brief 9D) — behind the server-side flag until the
 * business rules are finalised; payout requests unlock with Stripe Connect.
 * Under-18s never see this screen (and the server refuses them anyway).
 */
export default function EarningsScreen() {
  const theme = useTheme();
  const { profile } = useAuth();
  const [data, setData] = useState<MyEarnings | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    getMyEarnings()
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  if (profile?.age_band === 'minor') {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Earnings' }} />
        <ThemedText type="small" themeColor="textSecondary" style={styles.pad}>
          Earnings are for over-18s.
        </ThemedText>
      </ThemedView>
    );
  }

  if (failed) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Earnings' }} />
        <ThemedText type="small" themeColor="textSecondary" style={styles.pad}>
          Couldn&apos;t load your earnings. Try again in a moment.
        </ThemedText>
      </ThemedView>
    );
  }

  if (!data) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Earnings' }} />
        <ActivityIndicator color={theme.textSecondary} />
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Earnings' }} />
      <FlatList
        data={data.entries}
        keyExtractor={(e) => e.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            <ThemedText type="title">{pounds(data.balance_pence)}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Available · {pounds(data.lifetime_pence)} lifetime
              {data.pending_payout_pence > 0
                ? ` · ${pounds(data.pending_payout_pence)} being paid out`
                : ''}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
              {!data.enabled
                ? 'Creator earnings are coming soon — payments from paid partnerships and promoted posts will land here.'
                : !data.payouts_live
                  ? `Payouts open once bank transfers go live (minimum ${pounds(data.min_payout_pence)}).`
                  : `Minimum payout ${pounds(data.min_payout_pence)}.`}
            </ThemedText>
          </View>
        }
        ListEmptyComponent={
          <ThemedText type="small" themeColor="textSecondary" style={styles.pad}>
            No earnings yet.
          </ThemedText>
        }
        renderItem={({ item }) => (
          <View style={[styles.row, { borderColor: theme.border }]}>
            <View style={styles.rowLeft}>
              <ThemedText type="smallBold">
                {KIND_LABELS[item.kind] ?? item.kind}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {new Date(item.created_at).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
                {item.note ? ` · ${item.note}` : ''}
              </ThemedText>
            </View>
            <ThemedText type="smallBold">{pounds(item.amount_pence)}</ThemedText>
          </View>
        )}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad: { padding: 24, textAlign: 'center' },
  list: { padding: 16 },
  header: { gap: 4, marginBottom: 16 },
  note: { marginTop: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
    gap: 12,
  },
  rowLeft: { flex: 1, gap: 2 },
});
