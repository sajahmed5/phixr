import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/constants/config';
import { useIsBusiness } from '@/lib/account-type';

/**
 * Wraps a business-only screen (analytics, scheduling, boosts, earnings…). Personal
 * accounts reaching it — e.g. from an old notification or link — get a short, friendly
 * explanation instead of a broken or empty screen.
 */
export function BusinessOnly({ feature, children }: { feature: string; children: ReactNode }) {
  const isBusiness = useIsBusiness();
  const router = useRouter();
  if (isBusiness) return <>{children}</>;
  return (
    <ThemedView style={styles.fill}>
      <View style={styles.box}>
        <View style={styles.icon}>
          <Ionicons name="briefcase-outline" size={28} color={BRAND.accent} />
        </View>
        <ThemedText type="subtitle" style={styles.center}>
          {feature} come with a business account
        </ThemedText>
        <ThemedText type="default" themeColor="textSecondary" style={styles.center}>
          Personal accounts are for friends and scrolling. Switch to a business account to
          get analytics, scheduling, promotion and earnings tools.
        </ThemedText>
        <Button title="About business accounts" onPress={() => router.replace('/settings/business')} />
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'center' },
  box: { padding: 28, gap: 14, alignItems: 'stretch' },
  icon: {
    alignSelf: 'center',
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,122,26,0.12)',
  },
  center: { textAlign: 'center' },
});
