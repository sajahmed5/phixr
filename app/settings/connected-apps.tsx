import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { BusinessOnly } from '@/components/business-only';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import { confirm } from '@/lib/confirm';
import { listConnectedApps, removeConnectedApp, type ConnectedApp } from '@/lib/connected-apps';
import { formatRelative } from '@/lib/relative-time';

const SHORT: Record<string, string> = {
  'account:read': 'account details',
  'posts:read': 'see its posts',
  'posts:write': 'create and schedule posts',
  'insights:read': 'see insights',
};

/**
 * Settings → Connected apps. Outside tools (Metricool, Buffer, our Zapier app…) this
 * business has allowed to post for it through the Phixr Publishing API. Removing one
 * ends its access immediately.
 */
export default function ConnectedAppsScreen() {
  const theme = useTheme();
  const { profile } = useAuth();
  const profileId = profile?.id;
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setApps(await listConnectedApps(profileId));
      setFailed(false);
    } catch {
      setApps([]);
      setFailed(true);
    }
  }, [profileId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
  }, [load]);

  const remove = async (a: ConnectedApp) => {
    const ok = await confirm(
      `Remove ${a.app_name}?`,
      `${a.app_name} will stop being able to post for this account straight away. Posts it already made stay up. Anything it had scheduled is moved back to your drafts, so nothing else goes out.`,
      'Remove',
    );
    if (!ok) return;
    try {
      await removeConnectedApp(a.grant_id);
      void load();
    } catch {
      Alert.alert('Something went wrong', 'Could not remove the app. Try again.');
    }
  };

  return (
    <BusinessOnly feature="Connected apps">
      <ThemedView style={styles.fill}>
        <Stack.Screen options={{ headerShown: true, title: 'Connected apps' }} />
        <ScrollView contentContainerStyle={styles.content}>
          <ThemedText type="small" themeColor="textSecondary">
            Scheduling tools you’ve allowed to post to Phixr for this account. Their posts still go
            through Phixr’s safety checks. Remove any you don’t use or don’t recognise.
          </ThemedText>

          <View style={[styles.card, { borderColor: theme.border }]}>
            {apps === null ? (
              <View style={styles.pad}>
                <ActivityIndicator color={theme.textSecondary} />
              </View>
            ) : apps.length === 0 ? (
              <View style={styles.pad}>
                <ThemedText type="small" themeColor="textSecondary">
                  {failed ? 'Couldn’t load your connected apps. Try again later.' : 'No apps connected.'}
                </ThemedText>
              </View>
            ) : (
              apps.map((a) => (
                <View key={a.grant_id} style={styles.row}>
                  <Ionicons name="apps-outline" size={22} color={theme.text} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <ThemedText type="default">
                      {a.app_name}
                      {a.app_status !== 'live' ? ' (testing)' : ''}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      Can {a.scopes.map((s) => SHORT[s] ?? s).join(', ')}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {a.connected_by ? `Connected by @${a.connected_by} · ` : ''}
                      {a.last_used_at ? `last used ${formatRelative(a.last_used_at)}` : 'not used yet'}
                    </ThemedText>
                  </View>
                  <Pressable
                    onPress={() => remove(a)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${a.app_name}`}>
                    <ThemedText type="smallBold" style={{ color: theme.danger }}>
                      Remove
                    </ThemedText>
                  </Pressable>
                </View>
              ))
            )}
          </View>
        </ScrollView>
      </ThemedView>
    </BusinessOnly>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 16, gap: 14 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  pad: { padding: 16 },
});
