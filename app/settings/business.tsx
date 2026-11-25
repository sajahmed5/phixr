import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import { claimPlace, myVenueClaims, setAccountType, unclaimVenue, type VenueClaim } from '@/lib/business';
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
  const { profile, reload } = useAuth();
  const isBusiness = (profile as { account_type?: string } | null)?.account_type === 'business';

  const [claims, setClaims] = useState<VenueClaim[] | null>(null);
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
  }, [load]);

  const toggleType = async () => {
    if (busy) return;
    if (isBusiness) {
      if (!(await confirm('Back to personal?', 'Your venue claims will be released.', 'Switch'))) return;
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
            <ThemedText type="small" themeColor="textSecondary">
              A business account links your profile to your venue — or every branch if
              you&apos;re a chain. Your posts automatically attach to your venue, show in local
              search with your place name, and appear as pins on the map.
            </ThemedText>
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
          isBusiness ? (
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
          ) : null
        }
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
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
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
});
