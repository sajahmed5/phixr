import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import {
  claimPlace,
  myActingBusinesses,
  myVenueClaims,
  setAccountType,
  unclaimVenue,
  type ActingBusiness,
  type VenueClaim,
} from '@/lib/business';
import { confirm } from '@/lib/confirm';
import { getCurrentCoords, nearbyPlaces, type NearbyPlace } from '@/lib/location';

/**
 * Business account (Part 7C): switch account type (18+, server-enforced),
 * claim your venue(s) — chains claim every branch — and see verification
 * status. Verification itself is done by the Phixr team for now (the Google
 * Business Profile sign-in arrives once Google API access is approved).
 */
export default function BusinessSettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { profile, reload } = useAuth();
  const isBusiness = (profile as { account_type?: string } | null)?.account_type === 'business';

  const [claims, setClaims] = useState<VenueClaim[] | null>(null);
  const [acting, setActing] = useState<ActingBusiness[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NearbyPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const searchRun = useRef(0);

  const load = useCallback(async () => {
    if (!isBusiness) {
      setClaims([]);
      return;
    }
    try {
      setClaims(await myVenueClaims());
    } catch {
      setClaims([]);
    }
  }, [isBusiness]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
    void myActingBusinesses().then(setActing).catch(() => {});
  }, [load]);

  const toggleType = async () => {
    if (busy) return;
    if (isBusiness) {
      if (
        !(await confirm(
          'Switch back to personal?',
          'Business tools (analytics, scheduling, boosts, earnings, bio links) will be hidden and your venue claims released. Boosts and scheduled posts already set up will still finish. You can switch back any time.',
          'Switch',
        ))
      )
        return;
    }
    setBusy(true);
    try {
      await setAccountType(isBusiness ? 'personal' : 'business');
      reload();
      void load();
    } catch (e) {
      Alert.alert(
        "Couldn't switch",
        e instanceof Error && e.message.includes('18+')
          ? 'Business accounts are for over-18s.'
          : 'Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  // Debounced place search near the device (or just by text).
  useEffect(() => {
    if (!isBusiness || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const id = ++searchRun.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const coords = await getCurrentCoords().catch(() => null);
        const places = await nearbyPlaces(coords?.lat ?? 53.4808, coords?.lon ?? -2.2426, query.trim());
        if (id === searchRun.current) setResults(places.filter((p) => p.provider_place_id));
      } finally {
        if (id === searchRun.current) setSearching(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [query, isBusiness]);

  const claim = async (p: NearbyPlace) => {
    try {
      await claimPlace({
        provider: p.provider ?? undefined,
        provider_place_id: p.provider_place_id!,
        name: p.name,
        category: p.category,
        lat: p.lat,
        lon: p.lon,
        address: p.address,
      });
      setQuery('');
      setResults([]);
      void load();
    } catch (e) {
      Alert.alert(
        "Couldn't claim that place",
        e instanceof Error && e.message.includes('verified business')
          ? 'A verified business already owns this venue.'
          : 'Please try again.',
      );
    }
  };

  const remove = async (c: VenueClaim) => {
    if (!(await confirm('Remove this venue?', 'Your posts will no longer link to it.', 'Remove'))) return;
    try {
      await unclaimVenue(c.venue_id);
      void load();
    } catch {
      // next refresh shows the truth
    }
  };

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Business account' }} />
      <FlatList
        data={isBusiness ? (claims ?? []) : []}
        keyExtractor={(c) => c.venue_id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={[styles.typeCard, { borderColor: theme.border }]}>
              <ThemedText type="smallBold">
                {isBusiness ? 'You have a business account' : 'You have a personal account'}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {isBusiness
                  ? 'You get every creator and business tool. Find them all under Business tools on your profile.'
                  : 'Personal accounts are for friends and scrolling: post, swipe, follow and message.'}
              </ThemedText>
            </View>
            {!isBusiness ? (
              <View style={styles.perks}>
                <ThemedText type="smallBold">A business account adds</ThemedText>
                {(
                  [
                    ['bar-chart-outline', 'Analytics for your posts and audience'],
                    ['calendar-outline', 'Drafts and scheduled posts'],
                    ['rocket-outline', 'Boosts to promote your posts'],
                    ['cash-outline', 'Earnings, payouts and paid partnerships'],
                    ['link-outline', 'Bio links and a profile category'],
                    ['storefront-outline', 'Your venue, hours, offers and a team'],
                  ] as const
                ).map(([icon, text]) => (
                  <View key={text} style={styles.perk}>
                    <Ionicons name={icon} size={18} color={BRAND.accent} />
                    <ThemedText type="small" style={styles.perkText}>
                      {text}
                    </ThemedText>
                  </View>
                ))}
                <ThemedText type="small" themeColor="textSecondary">
                  For over-18s. You can switch back to personal at any time.
                </ThemedText>
              </View>
            ) : null}
            <Button
              title={
                busy ? 'Switching…' : isBusiness ? 'Switch back to personal' : 'Switch to business account'
              }
              variant={isBusiness ? 'secondary' : undefined}
              onPress={toggleType}
              disabled={busy}
            />
            {isBusiness ? (
              <>
                <ThemedText type="smallBold" style={styles.subhead}>
                  Manage
                </ThemedText>
                {(
                  [
                    ['Hours, links & offers', '/business/details', 'time-outline'],
                    ['Team', '/business/team', 'people-outline'],
                    ['Business inbox', '/business/inbox', 'chatbubbles-outline'],
                  ] as const
                ).map(([label, path, icon]) => (
                  <Pressable
                    key={path}
                    accessibilityRole="button"
                    onPress={() => router.push(path)}
                    style={[styles.navRow, { borderColor: theme.border }]}>
                    <Ionicons name={icon} size={20} color={theme.textSecondary} />
                    <ThemedText type="smallBold" style={styles.navLabel}>
                      {label}
                    </ThemedText>
                    <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
                  </Pressable>
                ))}
                <ThemedText type="smallBold" style={styles.subhead}>
                  Your venues {claims ? `(${claims.length})` : ''}
                </ThemedText>
                {claims === null ? <ActivityIndicator color={theme.textSecondary} /> : null}
                {claims?.length === 0 ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    No venues yet — find your place below.
                  </ThemedText>
                ) : null}
              </>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <View style={[styles.claimRow, { borderColor: theme.border }]}>
            <View style={styles.claimInfo}>
              <View style={styles.claimName}>
                <ThemedText type="smallBold" numberOfLines={1}>
                  {item.venues?.name ?? 'Venue'}
                </ThemedText>
                {item.verified ? (
                  <Ionicons name="checkmark-circle" size={16} color={BRAND.accent} />
                ) : null}
              </View>
              <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                {item.verified
                  ? 'Verified'
                  : 'Verification pending — the Phixr team confirms ownership'}
                {item.venues?.address ? ` · ${item.venues.address}` : ''}
              </ThemedText>
            </View>
            <Button title="Remove" variant="secondary" onPress={() => void remove(item)} />
          </View>
        )}
        ListFooterComponent={
          <>
            {acting.length > 0 ? (
              <View style={styles.footer}>
                <ThemedText type="smallBold" style={styles.subhead}>
                  Businesses you help run
                </ThemedText>
                {acting.map((b) => (
                  <View key={b.business_id} style={[styles.claimRow, { borderColor: theme.border }]}>
                    <View style={styles.claimInfo}>
                      <ThemedText type="smallBold" numberOfLines={1}>
                        {b.profiles?.handle ? `@${b.profiles.handle}` : 'Business'}
                      </ThemedText>
                      <ThemedText type="small" themeColor="textSecondary">
                        You&apos;re {b.role === 'admin' || b.role === 'editor' || b.role === 'analyst' ? 'an' : 'a'} {b.role}
                      </ThemedText>
                    </View>
                    {b.role === 'admin' || b.role === 'editor' ? (
                      <Button
                        title="Details"
                        variant="secondary"
                        onPress={() =>
                          router.push({ pathname: '/business/details', params: { business: b.business_id } })
                        }
                      />
                    ) : null}
                    {b.role !== 'analyst' ? (
                      <Button
                        title="Inbox"
                        variant="secondary"
                        onPress={() =>
                          router.push({ pathname: '/business/inbox', params: { business: b.business_id } })
                        }
                      />
                    ) : null}
                  </View>
                ))}
              </View>
            ) : null}
            {isBusiness ? (
            <View style={styles.footer}>
              <ThemedText type="smallBold" style={styles.subhead}>
                Add a venue
              </ThemedText>
              <TextField
                label="Find your place"
                placeholder="Search your business name"
                value={query}
                onChangeText={setQuery}
              />
              {searching ? <ActivityIndicator color={theme.textSecondary} /> : null}
              {results.map((r) => (
                <Pressable
                  key={r.provider_place_id}
                  onPress={() => void claim(r)}
                  style={[styles.resultRow, { borderColor: theme.border }]}>
                  <View style={styles.claimInfo}>
                    <ThemedText type="smallBold" numberOfLines={1}>
                      {r.name}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                      {r.address ?? ''}
                    </ThemedText>
                  </View>
                  <ThemedText type="linkPrimary">Claim</ThemedText>
                </Pressable>
              ))}
            </View>
            ) : null}
          </>
        }
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  typeCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 4 },
  perks: { gap: 10 },
  perk: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  perkText: { flex: 1 },
  fill: { flex: 1 },
  content: { padding: 20, gap: 10 },
  header: { gap: 12, marginBottom: 6 },
  subhead: { marginTop: 10 },
  claimRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
  claimInfo: { flex: 1, gap: 2 },
  claimName: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  footer: { gap: 10, marginTop: 10 },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
  navLabel: { flex: 1 },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
});
