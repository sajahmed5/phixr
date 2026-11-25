import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { listAccounts, type LinkedAccount } from '@/lib/accounts';
import { useAuth } from '@/lib/auth-context';
import { confirm } from '@/lib/confirm';
import { getClientSettings, settingNumber } from '@/lib/settings';

/**
 * Part 11: the account switcher sheet (long-press the profile tab, or tap
 * your name on your profile). Accounts live ONLY in this device's keychain;
 * nothing here is ever visible to other users.
 */
export function AccountSwitcher({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, switchAccount, signOut, signOutAll } = useAuth();
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [maxAccounts, setMaxAccounts] = useState(5);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    void listAccounts().then(setAccounts);
    void getClientSettings().then((s) => setMaxAccounts(settingNumber(s, 'max_linked_accounts', 5)));
  }, [visible]);

  const switchTo = useCallback(
    async (userId: string) => {
      if (userId === user?.id || busy) return;
      setBusy(userId);
      try {
        await switchAccount(userId);
        onClose();
      } catch (e) {
        Alert.alert(
          'Sign in again',
          e instanceof Error ? e.message : 'That account needs signing in again.',
        );
        setAccounts(await listAccounts());
      } finally {
        setBusy(null);
      }
    },
    [user?.id, busy, switchAccount, onClose],
  );

  const onSignOut = useCallback(async () => {
    if (!(await confirm('Sign out?', 'Other accounts on this device stay signed in.', 'Sign out'))) return;
    onClose();
    await signOut();
  }, [signOut, onClose]);

  const onSignOutAll = useCallback(async () => {
    if (!(await confirm('Sign out of all accounts?', 'Every account on this device is signed out.', 'Sign out of all'))) return;
    onClose();
    await signOutAll();
  }, [signOutAll, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close account switcher" />
      <View
        style={[
          styles.sheet,
          { backgroundColor: theme.background, paddingBottom: insets.bottom + 12 },
        ]}>
        <View style={[styles.grabber, { backgroundColor: theme.border }]} />
        <ThemedText type="subtitle" style={styles.title}>
          Accounts
        </ThemedText>

        {accounts.map((a) => {
          const active = a.user_id === user?.id;
          return (
            <Pressable
              key={a.user_id}
              onPress={() => switchTo(a.user_id)}
              accessibilityRole="button"
              accessibilityLabel={`Switch to @${a.handle}`}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
              {a.avatar_url ? (
                <Image source={{ uri: a.avatar_url }} style={styles.avatar} contentFit="cover" />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: theme.backgroundSelected }]}>
                  <Ionicons name="person" size={18} color={theme.textSecondary} />
                </View>
              )}
              <View style={styles.rowBody}>
                <ThemedText type="smallBold">@{a.handle}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                  {a.display_name}
                </ThemedText>
              </View>
              {!active && a.unread > 0 ? (
                <View style={styles.badge}>
                  <ThemedText type="small" style={styles.badgeText}>
                    {a.unread > 9 ? '9+' : a.unread}
                  </ThemedText>
                </View>
              ) : null}
              {busy === a.user_id ? (
                <ActivityIndicator color={theme.textSecondary} />
              ) : active ? (
                <Ionicons name="checkmark-circle" size={22} color={BRAND.accent} />
              ) : null}
            </Pressable>
          );
        })}

        {accounts.length < maxAccounts ? (
          <Pressable
            onPress={() => {
              onClose();
              router.push('/add-account');
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
            <View style={[styles.avatar, styles.avatarFallback, { borderWidth: 1, borderColor: theme.border }]}>
              <Ionicons name="add" size={20} color={theme.text} />
            </View>
            <ThemedText type="smallBold">Add account</ThemedText>
          </Pressable>
        ) : (
          <ThemedText type="small" themeColor="textSecondary" style={styles.limit}>
            You can be signed in to up to {maxAccounts} accounts on one device.
          </ThemedText>
        )}

        <View style={[styles.footer, { borderTopColor: theme.border }]}>
          <Pressable onPress={onSignOut} accessibilityRole="button" style={styles.footerBtn}>
            <ThemedText type="smallBold">Sign out of @{accounts.find((a) => a.user_id === user?.id)?.handle ?? 'this account'}</ThemedText>
          </Pressable>
          {accounts.length > 1 ? (
            <Pressable onPress={onSignOutAll} accessibilityRole="button" style={styles.footerBtn}>
              <ThemedText type="smallBold" style={{ color: BRAND.accent }}>
                Sign out of all accounts
              </ThemedText>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  grabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, marginBottom: 8 },
  title: { marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  rowBody: { flex: 1, gap: 1 },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    backgroundColor: BRAND.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: BRAND.onAccent, fontSize: 11 },
  limit: { paddingVertical: 8 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 8, paddingTop: 8, gap: 4 },
  footerBtn: { paddingVertical: 8 },
});
