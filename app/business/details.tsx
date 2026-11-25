import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import {
  createOffer,
  endOffer,
  getBusinessExtras,
  getBusinessOffers,
  setBusinessDetails,
  type BusinessHours,
  type Offer,
} from '@/lib/business';
import { confirm } from '@/lib/confirm';

/**
 * Part 13E: opening hours, menu/booking links and offers. Editable by the
 * owner and team admins/editors (server-enforced). Hours are simple
 * "09:00-17:00" strings per day; blank = closed.
 */

const DAYS = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
] as const;

export default function BusinessDetailsScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ business?: string }>();
  const businessId = (typeof params.business === 'string' && params.business) || user?.id || '';

  const [hours, setHours] = useState<Record<string, string>>({});
  const [menuUrl, setMenuUrl] = useState('');
  const [bookingUrl, setBookingUrl] = useState('');
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const [offerTitle, setOfferTitle] = useState('');
  const [offerDetails, setOfferDetails] = useState('');
  const [offerDays, setOfferDays] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [extras, live] = await Promise.all([
        getBusinessExtras(businessId),
        getBusinessOffers(businessId),
      ]);
      const h: Record<string, string> = {};
      for (const [key] of DAYS) h[key] = (extras?.business_hours as Record<string, string> | null)?.[key] ?? '';
      setHours(h);
      setMenuUrl(extras?.menu_url ?? '');
      setBookingUrl(extras?.booking_url ?? '');
      setOffers(live);
    } catch {
      setOffers([]);
    } finally {
      setLoaded(true);
    }
  }, [businessId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const h: BusinessHours = {};
      let any = false;
      for (const [key] of DAYS) {
        const v = hours[key]?.trim();
        if (v) {
          (h as Record<string, string>)[key] = v;
          any = true;
        }
      }
      await setBusinessDetails(
        businessId,
        any ? h : null,
        menuUrl.trim() || null,
        bookingUrl.trim() || null,
      );
      Alert.alert('Saved', 'Your business details are live.');
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const addOffer = async () => {
    const title = offerTitle.trim();
    if (!title) return;
    setCreating(true);
    try {
      const days = parseInt(offerDays, 10);
      const endsAt = Number.isFinite(days) && days > 0
        ? new Date(Date.now() + days * 24 * 3600 * 1000)
        : null;
      await createOffer(businessId, title, offerDetails.trim() || null, endsAt);
      setOfferTitle('');
      setOfferDetails('');
      setOfferDays('');
      void load();
    } catch (e) {
      Alert.alert("Couldn't add that offer", e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setCreating(false);
    }
  };

  const stop = async (o: Offer) => {
    if (!(await confirm('End this offer?', `“${o.title}” will stop showing right away.`, 'End offer'))) return;
    try {
      await endOffer(o.id);
      void load();
    } catch (e) {
      Alert.alert("Couldn't end it", e instanceof Error ? e.message : 'Please try again.');
    }
  };

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Hours, links & offers' }} />
      {!loaded ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.textSecondary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <ThemedText type="smallBold">Opening hours</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Like 09:00-17:00. Leave a day blank if you&apos;re closed.
          </ThemedText>
          {DAYS.map(([key, label]) => (
            <TextField
              key={key}
              label={label}
              placeholder="Closed"
              value={hours[key] ?? ''}
              onChangeText={(v) => setHours((prev) => ({ ...prev, [key]: v }))}
              autoCapitalize="none"
            />
          ))}

          <ThemedText type="smallBold" style={styles.subhead}>Links</ThemedText>
          <TextField
            label="Menu link"
            placeholder="https://…"
            value={menuUrl}
            onChangeText={setMenuUrl}
            autoCapitalize="none"
            keyboardType="url"
          />
          <TextField
            label="Booking link"
            placeholder="https://…"
            value={bookingUrl}
            onChangeText={setBookingUrl}
            autoCapitalize="none"
            keyboardType="url"
          />
          <Button title={saving ? 'Saving…' : 'Save details'} onPress={() => void save()} disabled={saving} />

          <ThemedText type="smallBold" style={styles.subhead}>
            Offers {offers ? `(${offers.length} live)` : ''}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Offers show on your profile and on your venue&apos;s map card. Up to 3 live at once.
          </ThemedText>
          {(offers ?? []).map((o) => (
            <View key={o.id} style={[styles.offerRow, { borderColor: theme.border }]}>
              <View style={styles.offerInfo}>
                <ThemedText type="smallBold" numberOfLines={1}>{o.title}</ThemedText>
                {o.details ? (
                  <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
                    {o.details}
                  </ThemedText>
                ) : null}
                {o.ends_at ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    Ends {new Date(o.ends_at).toLocaleDateString()}
                  </ThemedText>
                ) : null}
              </View>
              <Button title="End" variant="secondary" onPress={() => void stop(o)} />
            </View>
          ))}

          <TextField label="New offer" placeholder="2-for-1 flat whites" value={offerTitle} onChangeText={setOfferTitle} />
          <TextField
            label="Details (optional)"
            placeholder="Weekdays before 11am"
            value={offerDetails}
            onChangeText={setOfferDetails}
          />
          <TextField
            label="Runs for (days, optional)"
            placeholder="7"
            value={offerDays}
            onChangeText={setOfferDays}
            keyboardType="number-pad"
          />
          <Button
            title={creating ? 'Adding…' : 'Add offer'}
            variant="secondary"
            onPress={() => void addOffer()}
            disabled={creating || !offerTitle.trim()}
          />
        </ScrollView>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, gap: 10, paddingBottom: 48 },
  subhead: { marginTop: 14 },
  offerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
  offerInfo: { flex: 1, gap: 2 },
});
