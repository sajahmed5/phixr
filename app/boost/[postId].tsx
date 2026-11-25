import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import {
  ADULT_BANDS,
  createBoost,
  estimateBoostReach,
  type BoostEstimate,
} from '@/lib/boosts';
import { getClientSettings, settingNumber } from '@/lib/settings';

/**
 * Boost composer (Part 5B, points phase): days + audience (adult age bands,
 * area, "my post's interests"), a labelled reach ESTIMATE before paying, and
 * a points-only confirm. Money (Apple/Google) joins in the IAP build.
 * Boosts can't target under-18s — the server only ever serves adults, and
 * the band choices here are adult bands only.
 */
export default function BoostComposerScreen() {
  const { postId } = useLocalSearchParams<{ postId: string }>();
  const theme = useTheme();
  const router = useRouter();
  const { profile } = useAuth();

  const [days, setDays] = useState(1);
  const [bands, setBands] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<BoostEstimate | null>(null);
  const [perDay, setPerDay] = useState(100);
  const [maxDays, setMaxDays] = useState(7);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getClientSettings().then((s) => {
      setPerDay(settingNumber(s, 'boost_points_per_day', 100));
      setMaxDays(settingNumber(s, 'boost_max_days', 7));
    });
  }, []);

  const refreshEstimate = useCallback(async () => {
    try {
      setEstimate(await estimateBoostReach(bands, null, []));
    } catch {
      setEstimate(null);
    }
  }, [bands]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- estimate loader
    void refreshEstimate();
  }, [refreshEstimate]);

  const cost = days * perDay;
  const balance = Number(profile?.points_balance ?? 0);
  const canAfford = balance >= cost;
  const isMinor = profile?.age_band === 'minor';

  const dayOptions = useMemo(
    () => Array.from({ length: maxDays }, (_, i) => i + 1),
    [maxDays],
  );

  const buy = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await createBoost(postId, days, bands, null, []);
      Alert.alert('Boost running', 'Your post will start appearing more often in the deck.');
      router.back();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      Alert.alert(
        "Couldn't start the boost",
        msg.includes('not enough points')
          ? "You don't have enough points for that length."
          : msg.includes('already boosted')
            ? 'This post already has a boost running.'
            : 'Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (isMinor) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Boost' }} />
        <ThemedText type="subtitle">Boosts aren&apos;t available</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
          Boosting isn&apos;t available for under-18 accounts.
        </ThemedText>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Boost this post' }} />
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedText type="small" themeColor="textSecondary">
          A boost shows this post more often in the deck for the time you choose. It&apos;s always
          labelled &quot;Boosted&quot;, only ever shown to adults, and quality still matters — a post
          people skip quickly loses reach, boosted or not.
        </ThemedText>

        <Section title="How long?">
          <View style={styles.chips}>
            {dayOptions.map((d) => (
              <Chip key={d} label={`${d} day${d === 1 ? '' : 's'}`} on={days === d} onPress={() => setDays(d)} />
            ))}
          </View>
        </Section>

        <Section
          title="Who should see it?"
          subtitle="Leave empty for all adults. Boosts never target under-18s.">
          <View style={styles.chips}>
            {ADULT_BANDS.map((b) => (
              <Chip
                key={b}
                label={b}
                on={bands.includes(b)}
                onPress={() =>
                  setBands((prev) => (prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]))
                }
              />
            ))}
          </View>
        </Section>

        <Section title="Expected reach">
          {estimate ? (
            <View style={styles.estimateRow}>
              <Stat label="Matching people" value={estimate.audience_size.toLocaleString()} />
              <Stat label="Est. views / day" value={`~${estimate.est_daily_views.toLocaleString()}`} />
            </View>
          ) : (
            <ThemedText type="small" themeColor="textSecondary">
              Estimating…
            </ThemedText>
          )}
          <ThemedText type="small" themeColor="textSecondary">
            An estimate, not a promise — real reach depends on who&apos;s swiping.
          </ThemedText>
        </Section>

        <View style={[styles.payCard, { backgroundColor: theme.backgroundSelected }]}>
          <View style={styles.payRow}>
            <ThemedText type="smallBold">Cost</ThemedText>
            <ThemedText type="subtitle">{cost.toLocaleString()} points</ThemedText>
          </View>
          <View style={styles.payRow}>
            <ThemedText type="small" themeColor="textSecondary">
              Your balance
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {balance.toLocaleString()} points
            </ThemedText>
          </View>
          {!canAfford ? (
            <ThemedText type="small" style={{ color: BRAND.accent }}>
              Not enough points yet — keep taking part to earn more. Paying by card arrives in a
              future update.
            </ThemedText>
          ) : null}
          <Button
            title={busy ? 'Starting…' : `Boost for ${cost.toLocaleString()} points`}
            onPress={buy}
            disabled={!canAfford || busy}
          />
          <ThemedText type="small" themeColor="textSecondary">
            Cancel any time — unused whole days are refunded.
          </ThemedText>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={[
        styles.chip,
        { borderColor: theme.border },
        on && { backgroundColor: BRAND.accent, borderColor: BRAND.accent },
      ]}>
      <ThemedText type="smallBold" style={{ color: on ? BRAND.onAccent : theme.text }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <ThemedText type="subtitle">{value}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
    </View>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <ThemedText type="subtitle">{title}</ThemedText>
      {subtitle ? (
        <ThemedText type="small" themeColor="textSecondary">
          {subtitle}
        </ThemedText>
      ) : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
  centerText: { textAlign: 'center' },
  content: { padding: 20, gap: 22 },
  section: { gap: 6 },
  sectionBody: { marginTop: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  estimateRow: { flexDirection: 'row', gap: 24, marginBottom: 6 },
  stat: { gap: 2 },
  payCard: { borderRadius: 14, padding: 16, gap: 10 },
  payRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
});
