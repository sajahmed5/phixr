import { Ionicons } from '@expo/vector-icons';
import * as Application from 'expo-application';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ActionMenu } from '@/components/ui/action-menu';
import { ThemedView } from '@/components/themed-view';
import { BRAND, SUPPORT_EMAIL } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { getAdsConsent, setAdsConsent } from '@/lib/ads';
import { analytics } from '@/lib/analytics';
import { useAuth } from '@/lib/auth-context';
import { confirm } from '@/lib/confirm';
import {
  deleteAccount,
  getHideLikes,
  getNotificationPrefs,
  requestDataExport,
  setAllPostsVisibility,
  setFollowApproval,
  setHideLikes,
  setNotificationPrefs,
  setPrivacy,
  setSearchRadius,
  type NotificationPrefs,
  type PrefMode,
} from '@/lib/profile';

const RADII = [1, 5, 10, 25, 50];

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { profile, reload, signOut, signOutAll } = useAuth();

  const [isPrivate, setIsPrivate] = useState(profile?.is_private ?? false);
  const [privacyPromptOpen, setPrivacyPromptOpen] = useState(false);
  const [approveFollowers, setApproveFollowers] = useState(profile?.require_follow_approval ?? true);
  const [radius, setRadius] = useState(profile?.search_radius_miles ?? 5);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [shareUsage, setShareUsage] = useState(!analytics.isOptedOut());
  const [busy, setBusy] = useState<string | null>(null);

  async function toggleUsage(v: boolean) {
    setShareUsage(v);
    // value ON = analytics enabled; OFF = opted out. Honoured before any event fires.
    await analytics.setOptOut(!v);
  }

  const [hideLikes, setHideLikesState] = useState(false);
  const [personalisedAds, setPersonalisedAds] = useState(false);
  async function togglePersonalisedAds(v: boolean) {
    setPersonalisedAds(v);
    try {
      await setAdsConsent(v ? 'personalised' : 'non_personalised');
    } catch {
      setPersonalisedAds(!v);
    }
  }
  async function toggleHideLikes(v: boolean) {
    setHideLikesState(v);
    try {
      await setHideLikes(v);
    } catch {
      setHideLikesState(!v);
    }
  }

  const loadPrefs = useCallback(async () => {
    setPrefs(await getNotificationPrefs().catch(() => null));
    setHideLikesState(await getHideLikes().catch(() => false));
    setPersonalisedAds((await getAdsConsent().catch(() => 'unset')) === 'personalised');
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void loadPrefs();
  }, [loadPrefs]);

  async function togglePrivacy(v: boolean) {
    setIsPrivate(v);
    try {
      await setPrivacy(v);
      reload();
      // Going private doesn't hide existing PUBLIC posts (they still surface in the
      // feed), so offer to make them private too.
      if (v) setPrivacyPromptOpen(true);
    } catch {
      setIsPrivate(!v);
    }
  }
  async function toggleFollowApproval(v: boolean) {
    setApproveFollowers(v);
    try {
      await setFollowApproval(v);
      reload();
    } catch {
      setApproveFollowers(!v);
    }
  }
  async function changeRadius(m: number) {
    setRadius(m);
    try {
      await setSearchRadius(m);
      reload();
    } catch {
      /* keep optimistic */
    }
  }
  // Part 15: tri-state — 'on' | 'follows' (only from people I follow) | 'off'.
  async function setPrefMode(key: keyof NotificationPrefs, v: PrefMode) {
    if (!prefs) return;
    const next = { ...prefs, [key]: v };
    setPrefs(next);
    await setNotificationPrefs(next).catch(() => setPrefs(prefs));
  }

  async function onExport() {
    setBusy('export');
    try {
      // Server builds a JSON archive (profile, posts, comments, follows) + signed media
      // links and returns a short-lived signed download link.
      const { url, mediaCount } = await requestDataExport();
      const ok = await confirm(
        'Your export is ready',
        `A downloadable archive of your data${mediaCount ? ` and ${mediaCount} media files` : ''} has been prepared. The link is valid for 24 hours.`,
        'Download',
      );
      if (ok) void Linking.openURL(url);
    } catch {
      Alert.alert('Export failed', 'Could not export your data. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    // Two-step confirmation (works on web/PWA, where Alert.alert is a no-op).
    const first = await confirm(
      'Delete account',
      'This permanently erases your account, posts, and all data. This cannot be undone.',
      'Delete everything',
    );
    if (!first) return;
    const sure = await confirm(
      'Are you absolutely sure?',
      'There is no way to recover your account after this.',
      'Delete',
    );
    if (!sure) return;
    setBusy('delete');
    try {
      await deleteAccount();
    } catch {
      // signs out → root guard routes to login
      Alert.alert('Delete failed', 'Could not delete your account. Try again.');
      setBusy(null);
    }
  }

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Settings' }} />
      <ScrollView contentContainerStyle={styles.content}>
        <Group title="Privacy">
          <ToggleRow
            label="Private account"
            sublabel="Only accepted followers can see your posts."
            value={isPrivate}
            onValueChange={togglePrivacy}
          />
          <ToggleRow
            label="Share anonymous usage data"
            sublabel="Helps improve Phixr. Never your identity, and never which posts you swipe."
            value={shareUsage}
            onValueChange={toggleUsage}
          />
          <ToggleRow
            label="Hide my likes"
            sublabel="Creators won't see your name in their likers lists or notifications. Your likes still count in totals."
            value={hideLikes}
            onValueChange={toggleHideLikes}
          />
          {profile?.age_band !== 'minor' ? (
            <ToggleRow
              label="Personalised ads"
              sublabel="Use your age group, area and interests to pick ads. Off means ads that aren't based on you. Recorded with a timestamp (UK GDPR)."
              value={personalisedAds}
              onValueChange={togglePersonalisedAds}
            />
          ) : null}
          <LinkRow
            icon="people-outline"
            label="Audience groups"
            onPress={() => router.push('/settings/groups')}
          />
          {/* Phrased as the positive ("accept automatically") rather than the stored
              column ("require approval"), so the switch reads the way people expect.
              A private account always approves, whatever this says. */}
          <ToggleRow
            label="Automatically accept followers"
            sublabel={
              isPrivate
                ? 'Turned off while your account is private — private accounts always approve new followers.'
                : 'Off means people have to send you a follow request instead.'
            }
            value={!isPrivate && !approveFollowers}
            disabled={isPrivate}
            onValueChange={(v) => toggleFollowApproval(!v)}
          />
        </Group>

        <Group title="Discovery">
          <ThemedText type="small" themeColor="textSecondary" style={styles.rowPad}>
            Search radius
          </ThemedText>
          <View style={styles.radii}>
            {RADII.map((m) => (
              <Pressable
                key={m}
                onPress={() => changeRadius(m)}
                accessibilityRole="button"
                style={[
                  styles.radius,
                  {
                    borderColor: radius === m ? BRAND.accent : theme.border,
                    backgroundColor: radius === m ? BRAND.accent : 'transparent',
                  },
                ]}>
                <ThemedText
                  type="small"
                  style={{ color: radius === m ? BRAND.onAccent : theme.text, fontWeight: '600' }}>
                  {m} mi
                </ThemedText>
              </Pressable>
            ))}
          </View>
        </Group>

        <Group title="Notifications">
          {prefs === null ? (
            <View style={styles.rowPad}>
              <ActivityIndicator color={theme.textSecondary} />
            </View>
          ) : (
            <>
              <TriRow label="Likes" value={prefs.likes} onChange={(v) => void setPrefMode('likes', v)} />
              <TriRow label="Comments & replies" value={prefs.comments} onChange={(v) => void setPrefMode('comments', v)} />
              <TriRow label="Comment reactions" value={prefs.reactions} onChange={(v) => void setPrefMode('reactions', v)} />
              <TriRow label="Mentions" value={prefs.mentions} onChange={(v) => void setPrefMode('mentions', v)} />
              <TriRow label="New followers" value={prefs.follows} onChange={(v) => void setPrefMode('follows', v)} />
              <TriRow label="Follow requests" value={prefs.requests} onChange={(v) => void setPrefMode('requests', v)} />
              <TriRow label="Messages" value={prefs.messages} onChange={(v) => void setPrefMode('messages', v)} />
              <TriRow label="Boosts & reach" value={prefs.reach} onChange={(v) => void setPrefMode('reach', v)} noFollows />
              <TriRow label="Posting & collabs" value={prefs.posts} onChange={(v) => void setPrefMode('posts', v)} noFollows />
              <TriRow label="Earnings, offers & team" value={prefs.business} onChange={(v) => void setPrefMode('business', v)} noFollows />
              <TriRow
                label="Weekly creator digest"
                sublabel="A Monday summary of your week"
                value={prefs.digest}
                onChange={(v) => void setPrefMode('digest', v)}
                noFollows
              />
            </>
          )}
        </Group>

        <Group title="Help">
          <LinkRow
            icon="sparkles-outline"
            label="How points work"
            onPress={() => router.push('/points')}
          />
          <LinkRow
            icon="play-circle-outline"
            label="Replay tutorial"
            onPress={() => router.push('/tutorial')}
          />
          <LinkRow
            icon="shield-checkmark-outline"
            label="Community Guidelines"
            onPress={() => router.push('/legal/guidelines')}
          />
          <LinkRow
            icon="mail-outline"
            label="Contact support"
            onPress={() =>
              void Linking.openURL(
                `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Phixr support')}`,
              )
            }
          />
        </Group>

        <Group title="Safety">
          <LinkRow
            icon="ban-outline"
            label="Blocked & muted"
            onPress={() => router.push('/settings/blocked')}
          />
          <LinkRow
            icon="lock-closed-outline"
            label="Security & two-step login"
            onPress={() => router.push('/settings/security')}
          />
        </Group>

        <Group title="Your feed & time">
          <LinkRow
            icon="heart-circle-outline"
            label="Your interests"
            onPress={() => router.push('/settings/interests')}
          />
          <LinkRow
            icon="moon-outline"
            label="Wellbeing & quiet mode"
            onPress={() => router.push('/settings/wellbeing')}
          />
        </Group>

        <Group title="Account">
          <LinkRow
            icon="construct-outline"
            label="Creator tools"
            onPress={() => router.push('/settings/creator-tools')}
          />
          <LinkRow
            icon="briefcase-outline"
            label="Business account"
            onPress={() => router.push('/settings/business')}
          />
          {(profile as { account_type?: string } | null)?.account_type === 'business' ? (
            <LinkRow
              icon="ribbon-outline"
              label="Partnership requests"
              onPress={() => router.push('/settings/partnerships')}
            />
          ) : null}
          {profile?.age_band !== 'minor' ? (
            <LinkRow
              icon="cash-outline"
              label="Earnings"
              onPress={() => router.push('/settings/earnings')}
            />
          ) : null}
          <LinkRow
            icon="key-outline"
            label="Change password"
            onPress={() => router.push('/settings/password')}
          />
          <LinkRow
            icon="phone-portrait-outline"
            label="Devices & sessions"
            onPress={() => router.push('/settings/sessions')}
          />
          <LinkRow
            icon="download-outline"
            label="Export my data"
            onPress={onExport}
            busy={busy === 'export'}
          />
          <LinkRow icon="log-out-outline" label="Sign out" onPress={() => signOut()} />
          <LinkRow
            icon="log-out-outline"
            label="Sign out of all accounts"
            onPress={() => void signOutAll()}
          />
          <LinkRow
            icon="trash-outline"
            label="Delete account"
            destructive
            onPress={confirmDelete}
            busy={busy === 'delete'}
          />
        </Group>

        <Group title="Legal">
          <LinkRow
            icon="document-text-outline"
            label="Terms of Service"
            onPress={() => router.push('/legal/terms')}
          />
          <LinkRow
            icon="lock-closed-outline"
            label="Privacy Policy"
            onPress={() => router.push('/legal/privacy')}
          />
          <LinkRow
            icon="megaphone-outline"
            label="Advertising policy"
            onPress={() => router.push('/legal/ads')}
          />
          <LinkRow
            icon="shield-checkmark-outline"
            label="Online safety"
            onPress={() => router.push('/legal/safety')}
          />
        </Group>

        <ThemedText type="small" themeColor="textSecondary" style={styles.version}>
          Phixr {Application.nativeApplicationVersion ?? '1.0.0'} ({Application.nativeBuildVersion ?? '—'})
        </ThemedText>
      </ScrollView>
      <ActionMenu
        visible={privacyPromptOpen}
        title="Your existing posts are still public. Make them private too?"
        onClose={() => setPrivacyPromptOpen(false)}
        options={[
          {
            label: 'Make all posts private',
            onPress: async () => {
              try {
                const n = await setAllPostsVisibility('private');
                Alert.alert('Done', n ? `${n} post${n === 1 ? '' : 's'} set to private.` : 'No public posts to change.');
              } catch {
                Alert.alert('Something went wrong', 'Could not update your posts. Try again.');
              }
            },
          },
          { label: 'Keep them public', onPress: () => {} },
        ]}
      />
    </ThemedView>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.group}>
      <ThemedText type="smallBold" themeColor="textSecondary" style={styles.groupTitle}>
        {title.toUpperCase()}
      </ThemedText>
      <View style={[styles.card, { borderColor: theme.border }]}>{children}</View>
    </View>
  );
}

// Part 15: On / People I follow / Off, as one-handed chips.
function TriRow({
  label,
  sublabel,
  value,
  onChange,
  noFollows,
}: {
  label: string;
  sublabel?: string;
  value: PrefMode;
  onChange: (v: PrefMode) => void;
  /** Types with no actor (digests, reach) — just On/Off. */
  noFollows?: boolean;
}) {
  const theme = useTheme();
  const options: { v: PrefMode; title: string }[] = noFollows
    ? [
        { v: 'on', title: 'On' },
        { v: 'off', title: 'Off' },
      ]
    : [
        { v: 'on', title: 'On' },
        { v: 'follows', title: 'Follows' },
        { v: 'off', title: 'Off' },
      ];
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <ThemedText type="default">{label}</ThemedText>
        {sublabel ? (
          <ThemedText type="small" themeColor="textSecondary">
            {sublabel}
          </ThemedText>
        ) : null}
      </View>
      <View style={styles.triChips}>
        {options.map((o) => (
          <Pressable
            key={o.v}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${o.title === 'Follows' ? 'only from people I follow' : o.title}`}
            accessibilityState={{ selected: value === o.v }}
            onPress={() => onChange(o.v)}
            style={[
              styles.triChip,
              { borderColor: value === o.v ? BRAND.accent : theme.border },
              value === o.v ? styles.triChipOn : null,
            ]}>
            <ThemedText type="small">{o.title}</ThemedText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function ToggleRow({
  label,
  sublabel,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  sublabel?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.row, disabled ? { opacity: 0.5 } : null]}>
      <View style={styles.rowText}>
        <ThemedText type="default">{label}</ThemedText>
        {sublabel ? (
          <ThemedText type="small" themeColor="textSecondary">
            {sublabel}
          </ThemedText>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ true: BRAND.accent }}
      />
    </View>
  );
}

function LinkRow({
  icon,
  label,
  onPress,
  destructive,
  busy,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  busy?: boolean;
}) {
  const theme = useTheme();
  const color = destructive ? theme.danger : theme.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <Ionicons name={icon} size={20} color={color} />
      <ThemedText type="default" style={[styles.linkLabel, { color }]}>
        {label}
      </ThemedText>
      {busy ? (
        <ActivityIndicator color={theme.textSecondary} />
      ) : (
        <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 16, gap: 22 },
  group: { gap: 8 },
  groupTitle: { paddingHorizontal: 4, letterSpacing: 0.5 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  rowPad: { padding: 14 },
  rowText: { flex: 1, gap: 2 },
  triChips: { flexDirection: 'row', gap: 6 },
  triChip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  triChipOn: { backgroundColor: 'rgba(255, 122, 24, 0.12)' },
  pressed: { opacity: 0.6 },
  linkLabel: { flex: 1 },
  radii: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 14, paddingTop: 0 },
  radius: { borderWidth: 1, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  version: { textAlign: 'center', paddingVertical: 8 },
});
