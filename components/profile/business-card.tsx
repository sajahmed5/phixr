import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import {
  getBusinessExtras,
  getBusinessOffers,
  recordBusinessInsight,
  type BusinessExtras,
  type Offer,
} from '@/lib/business';

/**
 * Part 13E: hours, menu/booking links and live offers on a BUSINESS profile.
 * Renders nothing for personal accounts (the server returns nothing for
 * them). Views and link taps feed the business's aggregate-only insights.
 */
export function BusinessCard({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const theme = useTheme();
  const [extras, setExtras] = useState<BusinessExtras | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);

  useEffect(() => {
    let alive = true;
    void getBusinessExtras(userId)
      .then((e) => {
        if (!alive) return;
        setExtras(e);
        if (e && !isSelf) {
          recordBusinessInsight(userId, 'profile_view');
          if (e.business_hours) recordBusinessInsight(userId, 'hours_view');
        }
      })
      .catch(() => {});
    void getBusinessOffers(userId)
      .then((o) => {
        if (!alive) return;
        setOffers(o);
        if (o.length > 0 && !isSelf) recordBusinessInsight(userId, 'offer_view');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [userId, isSelf]);

  if (!extras && offers.length === 0) return null;

  const todayKey = (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[new Date().getDay()];
  const today = extras?.business_hours?.[todayKey] ?? null;

  return (
    <View style={styles.wrap}>
      {today ? (
        <ThemedText type="small" themeColor="textSecondary">
          Open today {today}
        </ThemedText>
      ) : null}
      {offers.map((o) => (
        <View key={o.id} style={[styles.offer, { borderColor: BRAND.accent }]}>
          <Ionicons name="pricetag" size={14} color={BRAND.accent} />
          <View style={styles.offerBody}>
            <ThemedText type="smallBold" numberOfLines={1}>
              {o.title}
            </ThemedText>
            {o.details ? (
              <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
                {o.details}
              </ThemedText>
            ) : null}
          </View>
        </View>
      ))}
      {extras?.menu_url || extras?.booking_url ? (
        <View style={styles.links}>
          {extras?.menu_url ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (!isSelf) recordBusinessInsight(userId, 'menu_click');
                void Linking.openURL(extras.menu_url!);
              }}
              style={[styles.linkBtn, { borderColor: theme.border }]}>
              <Ionicons name="restaurant-outline" size={16} color={theme.text} />
              <ThemedText type="smallBold">Menu</ThemedText>
            </Pressable>
          ) : null}
          {extras?.booking_url ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (!isSelf) recordBusinessInsight(userId, 'booking_click');
                void Linking.openURL(extras.booking_url!);
              }}
              style={[styles.linkBtn, { borderColor: theme.border }]}>
              <Ionicons name="calendar-outline" size={16} color={theme.text} />
              <ThemedText type="smallBold">Book</ThemedText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  offer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
  },
  offerBody: { flex: 1, gap: 1 },
  links: { flexDirection: 'row', gap: 8 },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flex: 1,
    justifyContent: 'center',
  },
});
